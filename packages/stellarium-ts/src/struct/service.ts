import {
    interpretParsed,
    MAX_STRUCT_DEPTH,
    parseScript,
    parseTypeString,
    RequestScriptError,
    type Script,
    structLabel,
    type StructRef,
    structReferences,
    type StructResolver,
    typeStructReferences,
    typeToString,
} from "requestscript";
import type { RunTokenVerifier } from "../client/runTokens.js";
import type { ContractCaller, ContractRefusal } from "../contract/service.js";
import { isFreshExpiry, safeVerifyData, signData } from "../crypto/utils.js";
import type { NodeConfig } from "../service.js";
import type { HostStruct } from "./define.js";
import type { StructRepository } from "./repository.js";
import {
    MAX_STRUCT_FIELDS,
    MAX_STRUCT_SOURCE_BYTES,
    type StructAnnouncement,
    structAnnouncementPayload,
    type StructField,
} from "./types.js";

/** How long an announcement of this node's structs is valid. */
const ANNOUNCEMENT_LIFETIME_MS = 1000 * 60 * 10;

const refuse = (status: number, error: string): ContractRefusal => ({ ok: false, status, error });

/** A struct as the deploy route answers it. */
export interface DeclaredStruct {
    path: string;
    name: string;
    version: string;
    fields: StructField[];
    ownerOrganizationId: string;
}

/** The structs a type string names, or none when it doesn't parse. */
function typeStringReferences(type: string): StructRef[] {
    try {
        return typeStructReferences(parseTypeString(type));
    } catch {
        return [];
    }
}

/**
 * Declares this node's structs, learns its peers', and resolves them for the scripts it runs. A struct's path
 * belongs to the organization whose node declared it first, and only that organization's nodes may declare
 * versions of it. Versions never change and are never deleted, so a type that names one always means the same
 * fields, on every node that knows it.
 */
export class StructService {
    /** Tells peers about this node's structs again. Set once the node listens. */
    announce?: () => void;

    /** Looks up the structs a script's types name, for the interpreter. */
    readonly resolver: StructResolver = {
        resolve: async (path, name, version) => {
            const struct = await this.repository.get(path, name, version);
            return struct && { path: struct.path, name: struct.name, version: struct.version, fields: struct.fields };
        },
    };

    constructor(
        readonly repository: StructRepository,
        private readonly config: NodeConfig,
        private readonly verifier: RunTokenVerifier | undefined,
    ) {}

    /**
     * Declares a struct from its source, owned by this node's organization. The node's admin, or an API client
     * of its own organization, may. Declaring a version again with the same fields succeeds without a change.
     */
    async deploy(source: string, description: string | undefined, caller: ContractCaller): Promise<{ ok: true, struct: DeclaredStruct, created: boolean } | ContractRefusal> {
        if (Buffer.byteLength(source) > MAX_STRUCT_SOURCE_BYTES) {
            return refuse(413, `Structs may be at most ${MAX_STRUCT_SOURCE_BYTES} bytes`);
        }
        let script: Script;
        try {
            script = parseScript(source);
        } catch (error) {
            return refuse(400, `Invalid struct: ${error instanceof Error ? error.message : String(error)}`);
        }
        const declaration = script.declaration;
        if (declaration.kind !== 'struct') {
            return refuse(400, 'Invalid struct: deploy a struct declaration, such as struct com.example.Name@1(field: string)');
        }
        if (caller.kind === 'client' && caller.organizationId !== this.config.organizationId) {
            return refuse(403, 'Structs belong to the organization of the node that declares them: declare yours on one of your own nodes');
        }
        const fields = declaration.fields.map(field => ({ name: field.name, type: typeToString(field.type) }));
        return this.declare({ path: declaration.path.join('.'), name: declaration.name, version: declaration.version, fields }, description ?? null, source);
    }

    /**
     * Declares the structs the node's host code defined, as its organization's, when the node starts. They may
     * name each other in any order. Throws when one can't be declared, which stops the node from starting.
     */
    async declareHost(structs: HostStruct[]): Promise<void> {
        let pending = [...structs];
        while (pending.length > 0) {
            const refused: { struct: HostStruct, error: string }[] = [];
            for (const struct of pending) {
                const result = await this.declare(struct, null, null);
                if (!result.ok) {
                    refused.push({ struct, error: result.error });
                }
            }
            // A struct naming one declared later in the same pass succeeds on the next; no progress means it never will.
            if (refused.length === pending.length) {
                throw new Error(`Can't declare struct ${refused[0]!.struct.type}: ${refused[0]!.error}`);
            }
            pending = refused.map(({ struct }) => struct);
        }
    }

    private async declare(struct: { path: string, name: string, version: string, fields: StructField[] }, description: string | null, source: string | null): Promise<{ ok: true, struct: DeclaredStruct, created: boolean } | ContractRefusal> {
        const label = `${struct.path}.${struct.name}@${struct.version}`;
        if (!struct.path) {
            return refuse(400, 'Invalid struct: give it a path, such as com.example.Name@1');
        }
        if (struct.fields.length > MAX_STRUCT_FIELDS) {
            return refuse(400, `Invalid struct: a struct may have at most ${MAX_STRUCT_FIELDS} fields`);
        }
        const organizationId = this.config.organizationId;
        if (!organizationId) {
            return refuse(503, 'This node isn\'t enrolled in an organization, so it can\'t own structs');
        }
        const unknown = await this.unknownReferences(struct.fields.flatMap(field => typeStringReferences(field.type)));
        if (unknown.length > 0) {
            return refuse(400, `Invalid struct: it names ${unknown.join(', ')}, which this node doesn't know`);
        }
        const nesting = await this.nestingRefusal(label, struct.fields);
        if (nesting) {
            return refuse(400, `Invalid struct: ${nesting}`);
        }
        const declared: DeclaredStruct = { ...struct, ownerOrganizationId: organizationId };
        const result = await this.repository.saveLocal({ ...declared, baseUrl: this.config.baseUrl, description }, source ?? '');
        if (!result.ok) {
            return result.refused === 'version_exists'
                ? refuse(409, `${label} already exists with other fields: structs are immutable, so declare a new version`)
                : refuse(409, `${struct.path}.${struct.name} is another organization's struct`);
        }
        if (result.saved) {
            this.announce?.();
        }
        return { ok: true, struct: declared, created: result.saved };
    }

    /**
     * Why the struct `label` with `fields` can't be declared: it would contain itself, or nest deeper than the
     * interpreter resolves. Structs this node doesn't know yet count as one level.
     */
    private async nestingRefusal(label: string, fields: StructField[]): Promise<string | undefined> {
        const heights = new Map<string, number>();
        const chain: string[] = [];
        const height = async (current: string, currentFields: StructField[]): Promise<number | string> => {
            const known = heights.get(current);
            if (known !== undefined) {
                return known;
            }
            chain.push(current);
            let deepest = 0;
            for (const ref of currentFields.flatMap(field => typeStringReferences(field.type))) {
                const child = structLabel(ref);
                if (chain.includes(child)) {
                    return `${label} would contain itself: ${[...chain.slice(chain.indexOf(child)), child].join(' -> ')}`;
                }
                const struct = child === label ? { fields } : await this.repository.get(ref.path.join('.'), ref.name, ref.version);
                const below = struct ? await height(child, struct.fields) : 1;
                if (typeof below === 'string') {
                    return below;
                }
                deepest = Math.max(deepest, below);
            }
            chain.pop();
            heights.set(current, deepest + 1);
            return deepest + 1;
        };
        const result = await height(label, fields);
        if (typeof result === 'string') {
            return result;
        }
        return result > MAX_STRUCT_DEPTH ? `${label} nests ${result} structs deep, more than ${MAX_STRUCT_DEPTH}` : undefined;
    }

    /** The structs among `refs` this node doesn't know, as path.Name@version, once each. */
    async unknownReferences(refs: StructRef[]): Promise<string[]> {
        const unknown = new Set<string>();
        for (const ref of refs) {
            if (!await this.repository.get(ref.path.join('.'), ref.name, ref.version)) {
                unknown.add(structLabel(ref));
            }
        }
        return [...unknown];
    }

    /** A refusal for a contract or event type that names a struct this node doesn't know. */
    async checkScript(script: Script, what: string): Promise<ContractRefusal | undefined> {
        const unknown = await this.unknownReferences(structReferences(script));
        return unknown.length > 0 ? refuse(400, `Invalid ${what}: it names ${unknown.join(', ')}, which this node doesn't know`) : undefined;
    }

    /**
     * Why `parameters` don't fit a host function's struct-typed parameters, checked before it runs, or undefined.
     * Parameters of other types are passed to the function as they come, as before. The check runs an empty
     * contract with those parameters, so it is the interpreter's own.
     */
    async parameterRefusal(declared: { name: string, type: string }[], parameters: { name: string, value: unknown }[]): Promise<string | undefined> {
        const typed = declared.filter(parameter => typeStringReferences(parameter.type).length > 0);
        if (typed.length === 0) {
            return undefined;
        }
        const script = parseScript(`contract Check(${typed.map(parameter => `${parameter.name}: ${parameter.type}`).join(', ')}) { }`);
        const values = Object.fromEntries(typed.map(parameter => [parameter.name, parameters.find(candidate => candidate.name === parameter.name)?.value ?? null]));
        try {
            await interpretParsed(script, { parameters: values, structs: this.resolver });
        } catch (error) {
            if (error instanceof RequestScriptError) {
                return error.message;
            }
            throw error;
        }
        return undefined;
    }

    // Announcements

    /** The structs this node declared for its organization, signed, as peers learn them. */
    async announcement(): Promise<StructAnnouncement> {
        const { membershipToken, organizationId, publicKey, privateKey } = this.config;
        // Only a node that can prove its organization announces the structs that organization owns.
        const structs = membershipToken && organizationId ? await this.repository.localStructs(organizationId) : [];
        const unsigned = { membershipToken: membershipToken ?? null, structs, expiry: new Date(Date.now() + ANNOUNCEMENT_LIFETIME_MS).toISOString() };
        return { publicKey, ...unsigned, signature: signData(structAnnouncementPayload(unsigned), privateKey) };
    }

    /**
     * Learns a peer's structs from its signed announcement, when the operator's membership token says the peer
     * belongs to their owner. Returns the structs it refused.
     */
    async applyAnnouncement(announcement: StructAnnouncement, peerBaseUrl: string): Promise<{ ok: true, rejected: string[] } | ContractRefusal> {
        if (!isFreshExpiry(announcement.expiry) || !safeVerifyData(structAnnouncementPayload(announcement), announcement.publicKey, announcement.signature)) {
            return refuse(400, 'Invalid signature');
        }
        let owner: string | undefined;
        if (announcement.membershipToken && this.verifier) {
            const membership = await this.verifier.verifyMembership(announcement.membershipToken);
            if (membership?.publicKey === announcement.publicKey) {
                owner = membership.organizationId;
            }
        }
        const rejected = await this.repository.learn(peerBaseUrl, announcement.structs, owner);
        return { ok: true, rejected };
    }
}
