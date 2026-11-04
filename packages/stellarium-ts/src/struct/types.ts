/** The most fields one struct may declare. */
export const MAX_STRUCT_FIELDS = 64;
/** The largest struct source a node accepts, in bytes. */
export const MAX_STRUCT_SOURCE_BYTES = 16 * 1024;

/** A field of a struct: its name and RequestScript type string. A struct type in it names its version. */
export interface StructField {
    name: string;
    type: string;
}

/** A struct this node knows: declared here, or learned from a node of its owner. */
export interface StructDefinition {
    path: string;
    name: string;
    version: string;
    fields: StructField[];
    /** The organization that owns the struct's path. Only its nodes may declare versions of it. */
    ownerOrganizationId: string;
    /** The node that declared this version. */
    baseUrl: string;
    description: string | null;
    createdAt: string;
}

/** A struct, as a node announces the ones its organization owns. */
export interface AnnouncedStruct {
    path: string;
    name: string;
    version: string;
    fields: StructField[];
    ownerOrganizationId: string;
    description: string | null;
}

/**
 * The structs a node's organization owns, signed by the node's key. Receivers learn them only when the
 * operator's membership token says the node belongs to their owner.
 */
export interface StructAnnouncement {
    publicKey: string;
    /** Absent when the node has no session with an operator, which also means it announces no structs. */
    membershipToken: string | null;
    structs: AnnouncedStruct[];
    expiry: string;
    signature: string;
}

/**
 * What a struct announcement's signature covers, in this order. `signData` signs `JSON.stringify` output,
 * so the order is part of the signed bytes.
 */
export function structAnnouncementPayload(announcement: Omit<StructAnnouncement, 'signature' | 'publicKey'>) {
    return {
        membershipToken: announcement.membershipToken,
        structs: announcement.structs,
        expiry: announcement.expiry,
    };
}

/** `path.Name@version` */
export function structLabelOf(struct: { path: string, name: string, version: string }): string {
    return `${struct.path}.${struct.name}@${struct.version}`;
}

/** Whether two field lists are the same: the same names and types, in the same order. */
export function sameFields(a: StructField[], b: StructField[]): boolean {
    return a.length === b.length && a.every((field, index) => field.name === b[index]!.name && field.type === b[index]!.type);
}
