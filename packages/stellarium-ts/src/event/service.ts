import { randomUUID } from "node:crypto";
import { type EmittedEvent, emittedEvents, type EventRef, type EventResolver, type EventType, parseScript, parseTypeString, RuntimeError, type Script, structReferences, typeStructReferences, typeToString } from "requestscript";
import type { RunTokenVerifier } from "../client/runTokens.js";
import type { ContractCaller, ContractRefusal } from "../contract/service.js";
import { isFreshExpiry, safeVerifyData, signData } from "../crypto/utils.js";
import type { NodeConfig } from "../service.js";
import type { StructService } from "../struct/service.js";
import { type EventConsumer, EventRepository, type InboxItem, type OutboxItem, type QueuedEvent } from "./repository.js";
import {
    type AnnouncedEventType,
    DEFAULT_MAX_EVENT_DATA_BYTES,
    DEFAULT_MAX_EVENTS_PER_RUN,
    type EventAnnouncement,
    eventAnnouncementPayload,
    type EventEnvelope,
    eventEnvelopePayload,
    type EventLineage,
    type EventTypeDefinition,
    EVENT_MAX_AGE_MS,
    MAX_EVENT_DEPTH,
    qualifiedName,
} from "./types.js";

/** Per delivery to a peer. */
export const EVENT_DELIVERY_TIMEOUT_MS = 10_000;
/** A delivery is retried until it succeeds, is refused for good, or the event is `EVENT_MAX_AGE_MS` old. */
export const MAX_DELIVERY_ATTEMPTS = 12;
/** An event contract that fails is run again with the event at most this many times in all. */
export const MAX_EVENT_RUN_ATTEMPTS = 3;
/** How long an announcement of this node's events is valid. */
const ANNOUNCEMENT_LIFETIME_MS = 1000 * 60 * 10;
/** A worker that claimed a delivery or event and didn't settle it within this stopped; it is claimed again. */
const STALE_CLAIM_MS = 1000 * 60 * 10;
/** Settled deliveries and events are kept this long, so a redelivered event is still recognized. */
const SETTLED_RETENTION_MS = 3 * EVENT_MAX_AGE_MS;
/** How far ahead of this node's clock an event's publish time may be. */
const CLOCK_SKEW_MS = 1000 * 60 * 5;
/** Deliveries a peer refuses with one of these won't succeed later. */
const PERMANENT_REFUSALS = new Set([400, 401, 403, 413]);

const refuse = (status: number, error: string): ContractRefusal => ({ ok: false, status, error });

/** Exponential backoff from 30 seconds, at most an hour. `attempts` counts the attempts made so far. */
export function retryDelayMs(attempts: number): number {
    return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60 * 1000);
}

/** Splits `path.Name`. */
export function splitQualifiedName(qualified: string): { path: string, name: string } | undefined {
    const dot = qualified.lastIndexOf('.');
    if (dot <= 0 || dot === qualified.length - 1) {
        return undefined;
    }
    return { path: qualified.slice(0, dot), name: qualified.slice(dot + 1) };
}

/** Runs this node's event contracts with the events delivered to them. */
export interface EventContractHost {
    /** Runs the event contract with one event. A failed run says whether running it again may succeed. */
    runEvent(consumer: EventConsumer, envelope: EventEnvelope): Promise<{ ok: true } | { ok: false, error: string, retry: boolean }>;
}

/** What a script emits through: its event resolver, then the check and publishing of its events once it succeeds. */
export interface Emitter {
    resolver: EventResolver;
    /** Why the run's events can't be published, checked before anything of the run is saved. Undefined when they can. */
    check(events: EmittedEvent[]): string | undefined;
    /** Queues the run's events for this node's event contracts and for the peers subscribed to them. */
    publish(events: EmittedEvent[]): Promise<void>;
}

export interface EmitterOptions {
    /** The organization the script belongs to: the run's, or the contract's owner. Null is this node's admin. */
    scriptOwner: string | null;
    /** The chain the script runs in, when an event started it. */
    lineage?: EventLineage;
    /** The event type an event contract consumes, at the version it was deployed against. */
    consumes?: { path: string, name: string, version: string };
    /** The contract emitting, as path.Name, which joins the chain of the events it emits. */
    contract?: string;
}

/** An event type as the deploy route answers it. */
export interface DeployedEventType {
    path: string;
    name: string;
    version: string;
    fields: { name: string, type: string }[];
    restricted: boolean;
    ownerOrganizationId: string;
}

/**
 * Declares event types, publishes the events this node's scripts emit, delivers them to the peers whose event
 * contracts consume them, and runs this node's event contracts with the events delivered to it.
 *
 * An event type belongs to the organization of the node that declared it. Only scripts of that organization,
 * running on its own nodes, may emit it, and every event carries the operator's membership token, so a
 * receiver can check the publisher belongs to the owner. Delivery is at least once: an event is queued, sent
 * until the peer accepts it, and each event contract runs once per event id.
 */
export class EventService {
    /** Set once the node's contract service exists, since it runs the event contracts. */
    contracts?: EventContractHost;
    /** Knows the structs event types' fields name. Without it, an event type can't name a struct. */
    structs?: StructService;
    /** Tells peers about this node's event types and event contracts again. Set once the node listens. */
    announce?: () => void;
    /** Whether this node has announced its events, so an empty announcement still clears what peers learned before. */
    announcedBefore = false;
    private kicked?: NodeJS.Immediate;
    private workers?: { stop: () => void };
    private dispatching?: Promise<number>;
    private processing?: Promise<number>;

    constructor(
        readonly repository: EventRepository,
        private readonly config: NodeConfig,
        private readonly verifier: RunTokenVerifier | undefined,
        private readonly log: (error: unknown, message: string) => void = (error, message) => console.error(message, error),
    ) {}

    private get maxEventsPerRun(): number {
        return this.config.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN;
    }

    private get maxEventDataBytes(): number {
        return this.config.maxEventDataBytes ?? DEFAULT_MAX_EVENT_DATA_BYTES;
    }

    // Event types

    /**
     * Declares a version of an event type, owned by this node's organization. Its admin, or an API client of
     * its own organization, may: an event type belongs to the organization whose nodes may emit it.
     */
    async deployType(source: string, description: string | undefined, caller: ContractCaller): Promise<{ ok: true, eventType: DeployedEventType } | ContractRefusal> {
        const maxBytes = this.config.maxContractSourceBytes ?? 64 * 1024;
        if (Buffer.byteLength(source) > maxBytes) {
            return refuse(413, `Event types may be at most ${maxBytes} bytes`);
        }
        let script: Script;
        try {
            script = parseScript(source);
        } catch (error) {
            return refuse(400, `Invalid event type: ${error instanceof Error ? error.message : String(error)}`);
        }
        const declaration = script.declaration;
        if (declaration.kind !== 'event') {
            return refuse(400, 'Invalid event type: deploy an event declaration, such as event com.example.Name(field: string)');
        }
        if (declaration.path.length === 0) {
            return refuse(400, 'Invalid event type: give it a path, such as com.example.Name');
        }
        const structs = this.structs
            ? await this.structs.checkScript(script, 'event type')
            : structReferences(script).length > 0 ? refuse(400, 'Invalid event type: this node doesn\'t know any structs') : undefined;
        if (structs) {
            return structs;
        }
        const organizationId = this.config.organizationId;
        if (!organizationId) {
            return refuse(503, 'This node isn\'t enrolled in an organization, so it can\'t own event types');
        }
        if (caller.kind === 'client' && caller.organizationId !== organizationId) {
            return refuse(403, 'Event types belong to the organization of the node that declares them: declare yours on one of your own nodes');
        }
        const eventType: DeployedEventType = {
            path: declaration.path.join('.'),
            name: declaration.name,
            version: declaration.version,
            fields: declaration.fields.map(field => ({ name: field.name, type: typeToString(field.type) })),
            restricted: declaration.restricted,
            ownerOrganizationId: organizationId,
        };
        const label = qualifiedName(eventType.path, eventType.name);
        const result = await this.repository.saveLocalType({ ...eventType, baseUrl: this.config.baseUrl, description: description ?? null }, source);
        if (!result.ok) {
            return result.refused === 'version_exists'
                ? refuse(409, `${label}@${eventType.version} already exists: event types are immutable, so deploy a new version`)
                : refuse(409, `${label} is another node's event type`);
        }
        this.announce?.();
        return { ok: true, eventType };
    }

    /** Deletes a version, or every version, of an event type this node declared. */
    async deleteType(path: string, name: string, version: string | undefined, caller: ContractCaller): Promise<{ ok: true } | ContractRefusal> {
        if (caller.kind === 'client' && caller.organizationId !== this.config.organizationId) {
            return refuse(403, `${qualifiedName(path, name)} belongs to another organization`);
        }
        if (!await this.repository.deleteLocalType(path, name, version)) {
            return refuse(404, `No event type ${qualifiedName(path, name)}${version === undefined ? '' : `@${version}`} on this node`);
        }
        this.announce?.();
        return { ok: true };
    }

    /**
     * The event type an event contract consumes, at the version it pins or the latest, checked for its deployer:
     * a restricted type may only be consumed by its owner's contracts.
     */
    async consumedType(consumes: EventRef, deployerOrganizationId: string | null): Promise<{ ok: true, eventType: EventTypeDefinition } | ContractRefusal> {
        const path = consumes.path.join('.');
        const label = qualifiedName(path, consumes.name);
        const eventType = await this.repository.resolveType(path, consumes.name, consumes.version);
        if (!eventType) {
            return refuse(400, `Invalid contract: it consumes ${label}${consumes.version === undefined ? '' : `@${consumes.version}`}, which this node doesn't know`);
        }
        if (eventType.restricted && eventType.ownerOrganizationId !== deployerOrganizationId) {
            return refuse(403, `${label} is restricted: only its owner's contracts may consume it`);
        }
        return { ok: true, eventType };
    }

    /**
     * Checks the events a contract may emit before it is deployed: each must be a type this node's organization
     * owns, the contract's owner must be that organization, and an event contract can't emit what it consumes.
     */
    async checkEmits(script: Script, ownerOrganizationId: string | null): Promise<ContractRefusal | undefined> {
        const refs = emittedEvents(script);
        if (refs.length === 0) {
            return undefined;
        }
        const nodeOrganizationId = this.config.organizationId;
        const consumes = script.declaration.kind === 'contract' ? script.declaration.consumes : undefined;
        for (const ref of refs) {
            const path = ref.path.join('.');
            const label = qualifiedName(path, ref.name);
            if (consumes && consumes.path.join('.') === path && consumes.name === ref.name) {
                return refuse(400, `Invalid contract: an event contract can't emit ${label}, the event it consumes`);
            }
            const eventType = await this.repository.resolveType(path, ref.name, ref.version);
            if (!eventType) {
                return refuse(400, `Invalid contract: it emits ${label}, which this node doesn't know`);
            }
            if (!nodeOrganizationId || eventType.ownerOrganizationId !== nodeOrganizationId || (ownerOrganizationId ?? nodeOrganizationId) !== nodeOrganizationId) {
                return refuse(403, `Only ${eventType.ownerOrganizationId}'s contracts on its own nodes may emit ${label}`);
            }
        }
        return undefined;
    }

    // Emitting

    /** The resolver, check and publishing a script emits through. */
    emitter(options: EmitterOptions): Emitter {
        let emitted = 0;
        const resolver: EventResolver = {
            resolve: async (path, name, version) => {
                const consumes = options.consumes;
                if (consumes && consumes.path === path && consumes.name === name && (version === undefined || version === consumes.version)) {
                    return this.toEventType(await this.repository.resolveType(path, name, consumes.version));
                }
                const eventType = await this.repository.resolveType(path, name, version);
                if (!eventType) {
                    return undefined;
                }
                const reason = this.emitRefusal(eventType, options, ++emitted);
                if (reason) {
                    throw new RuntimeError(reason);
                }
                return this.toEventType(eventType);
            },
        };
        return {
            resolver,
            check: (events) => {
                for (const event of events) {
                    const bytes = Buffer.byteLength(JSON.stringify(event.data));
                    if (bytes > this.maxEventDataBytes) {
                        return `event ${qualifiedName(event.path, event.name)} has ${bytes} bytes of data, more than this node's ${this.maxEventDataBytes}`;
                    }
                }
                return undefined;
            },
            publish: (events) => this.publish(events, options),
        };
    }

    private toEventType(eventType: EventTypeDefinition | undefined): EventType | undefined {
        return eventType && { path: eventType.path, name: eventType.name, version: eventType.version, fields: eventType.fields };
    }

    /** Why a script can't emit an event of `eventType`, or undefined. `count` is how many events it emitted with this one. */
    private emitRefusal(eventType: EventTypeDefinition, options: EmitterOptions, count: number): string | undefined {
        const label = qualifiedName(eventType.path, eventType.name);
        const nodeOrganizationId = this.config.organizationId;
        if (!this.verifier || !this.config.membershipToken || !nodeOrganizationId) {
            return `This node can't publish ${label}: it has no session with the operator to prove its organization`;
        }
        if (eventType.ownerOrganizationId !== nodeOrganizationId || (options.scriptOwner ?? nodeOrganizationId) !== nodeOrganizationId) {
            return `Only ${eventType.ownerOrganizationId}'s scripts on its own nodes may emit ${label}`;
        }
        if (options.lineage?.types.includes(label)) {
            return `Can't emit ${label}: it is earlier in this chain of events`;
        }
        if ((options.lineage?.depth ?? 0) >= MAX_EVENT_DEPTH) {
            return `Can't emit ${label}: events may chain at most ${MAX_EVENT_DEPTH} deep`;
        }
        if (count > this.maxEventsPerRun) {
            return `Can't emit ${label}: a run may emit at most ${this.maxEventsPerRun} events`;
        }
        return undefined;
    }

    private async publish(events: EmittedEvent[], options: EmitterOptions): Promise<void> {
        if (events.length === 0) {
            return;
        }
        const { publicKey, privateKey, membershipToken, organizationId, baseUrl } = this.config;
        if (!membershipToken || !organizationId) {
            throw new Error('This node has no membership token to publish events with');
        }
        const lineage = options.lineage;
        const contracts = [...lineage?.contracts ?? []];
        if (options.contract && !contracts.includes(options.contract)) {
            contracts.push(options.contract);
        }
        const queued: QueuedEvent[] = [];
        for (const event of events) {
            const unsigned = {
                id: randomUUID(),
                type: qualifiedName(event.path, event.name),
                version: event.version,
                ownerOrganizationId: organizationId,
                data: event.data,
                publishedAt: new Date().toISOString(),
                depth: (lineage?.depth ?? 0) + 1,
                lineage: { types: [...lineage?.types ?? []], contracts },
                publisherPublicKey: publicKey,
                membershipToken,
            };
            const envelope: EventEnvelope = { ...unsigned, signature: signData(eventEnvelopePayload(unsigned), privateKey) };
            const eventType = await this.repository.resolveType(event.path, event.name, event.version);
            const deliverable = (owner: string | null) => !eventType?.restricted || owner === eventType.ownerOrganizationId;
            const consumers = (await this.repository.consumersOf(event.path, event.name, event.version))
                .filter(consumer => deliverable(consumer.ownerOrganizationId ?? organizationId));
            const targets = [...new Set((await this.repository.subscribersOf(event.path, event.name, event.version))
                .filter(subscription => subscription.baseUrl !== baseUrl && deliverable(subscription.ownerOrganizationId))
                .map(subscription => subscription.baseUrl))];
            queued.push({ envelope, consumers, targets });
        }
        await this.repository.enqueue(queued);
        this.kick();
    }

    // Receiving

    /**
     * Accepts an event a peer delivers: checks it is signed by its publisher, that the operator says the
     * publisher belongs to the event type's owner, and that it is recent, then queues it for this node's event
     * contracts. A redelivered event is accepted again without running them twice.
     */
    async receive(envelope: EventEnvelope): Promise<{ ok: true, accepted: number } | ContractRefusal> {
        if (!this.verifier) {
            return refuse(503, 'This node has no operator to check events against');
        }
        const publishedAt = Date.parse(envelope.publishedAt);
        const now = Date.now();
        if (!Number.isFinite(publishedAt) || publishedAt > now + CLOCK_SKEW_MS || publishedAt < now - EVENT_MAX_AGE_MS) {
            return refuse(400, 'The event is too old, or published in the future');
        }
        if (!Number.isSafeInteger(envelope.depth) || envelope.depth < 1 || envelope.depth > MAX_EVENT_DEPTH) {
            return refuse(400, `Events may chain at most ${MAX_EVENT_DEPTH} deep`);
        }
        if (Buffer.byteLength(JSON.stringify(envelope.data)) > this.maxEventDataBytes) {
            return refuse(413, `Event data may be at most ${this.maxEventDataBytes} bytes`);
        }
        if (!safeVerifyData(eventEnvelopePayload(envelope), envelope.publisherPublicKey, envelope.signature)) {
            return refuse(401, 'Invalid event signature');
        }
        const membership = await this.verifier.verifyMembership(envelope.membershipToken, new Date(publishedAt));
        if (!membership || membership.publicKey !== envelope.publisherPublicKey || membership.organizationId !== envelope.ownerOrganizationId) {
            return refuse(403, 'The operator doesn\'t say the publisher belongs to the event\'s owner');
        }
        const qualified = splitQualifiedName(envelope.type);
        if (!qualified) {
            return refuse(400, 'Invalid event type');
        }
        const eventType = await this.repository.resolveType(qualified.path, qualified.name, envelope.version);
        // Not learned yet: the publisher retries, and its announcement may arrive first.
        if (!eventType) {
            return refuse(409, `This node doesn't know ${envelope.type}@${envelope.version} yet`);
        }
        if (eventType.ownerOrganizationId !== envelope.ownerOrganizationId) {
            return refuse(403, `${envelope.type} belongs to another organization`);
        }
        const consumers = (await this.repository.consumersOf(qualified.path, qualified.name, envelope.version))
            .filter(consumer => !eventType.restricted || (consumer.ownerOrganizationId ?? this.config.organizationId) === eventType.ownerOrganizationId);
        await this.repository.enqueue([{ envelope, consumers, targets: [] }]);
        this.kick();
        return { ok: true, accepted: consumers.length };
    }

    // Workers

    /** Sends the deliveries that are due. Returns how many it attempted. Calls already in flight share one pass. */
    dispatchDue(now: number = Date.now()): Promise<number> {
        this.dispatching ??= this.dispatchPass(now).finally(() => {
            this.dispatching = undefined;
        });
        return this.dispatching;
    }

    private async dispatchPass(now: number): Promise<number> {
        let attempted = 0;
        for (;;) {
            const batch = await this.repository.claimOutbox(now, 20);
            if (batch.length === 0) {
                return attempted;
            }
            await Promise.all(batch.map(item => this.deliver(item)));
            attempted += batch.length;
        }
    }

    private async deliver(item: OutboxItem): Promise<void> {
        let status: number | undefined;
        let error: string;
        try {
            const response = await fetch(`${item.targetBaseUrl}/v1/events/deliver`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item.envelope),
                signal: AbortSignal.timeout(EVENT_DELIVERY_TIMEOUT_MS),
            });
            if (response.ok) {
                await this.repository.settleOutbox(item.id, { status: 'delivered' });
                return;
            }
            status = response.status;
            const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
            error = typeof body?.error === 'string' ? `${status}: ${body.error}` : `${status} ${response.statusText}`.trim();
        } catch (failure) {
            error = failure instanceof Error ? failure.message : String(failure);
        }
        const attempts = item.attempts + 1;
        const nextAttemptAt = Date.now() + retryDelayMs(attempts);
        const expired = nextAttemptAt > Date.parse(item.envelope.publishedAt) + EVENT_MAX_AGE_MS;
        const failed = expired || attempts >= MAX_DELIVERY_ATTEMPTS || (status !== undefined && PERMANENT_REFUSALS.has(status));
        await this.repository.settleOutbox(item.id, { status: failed ? 'failed' : 'pending', attempts, nextAttemptAt, error });
        if (failed) {
            this.log(undefined, `Gave up delivering event ${item.envelope.id} to ${item.targetBaseUrl}: ${error}`);
        }
    }

    /** Runs this node's event contracts with the events that are due. Returns how many runs it attempted. */
    processInbox(now: number = Date.now()): Promise<number> {
        this.processing ??= this.processPass(now).finally(() => {
            this.processing = undefined;
        });
        return this.processing;
    }

    private async processPass(now: number): Promise<number> {
        let attempted = 0;
        for (;;) {
            const batch = await this.repository.claimInbox(now, 20);
            if (batch.length === 0) {
                return attempted;
            }
            // One at a time: event contracts with state run one call at a time anyway.
            for (const item of batch) {
                await this.consume(item);
            }
            attempted += batch.length;
        }
    }

    private async consume(item: InboxItem): Promise<void> {
        const consumer = await this.repository.consumer(item.consumerPath, item.consumerName);
        const qualified = splitQualifiedName(item.envelope.type);
        if (!consumer || !qualified || consumer.eventPath !== qualified.path || consumer.eventName !== qualified.name || consumer.eventVersion !== item.envelope.version) {
            await this.repository.settleInbox(item, { status: 'failed', attempts: item.attempts + 1, nextAttemptAt: Date.now(), error: 'The event contract was deleted, or now consumes another version' });
            return;
        }
        let result: Awaited<ReturnType<EventContractHost['runEvent']>>;
        try {
            result = this.contracts
                ? await this.contracts.runEvent(consumer, item.envelope)
                : { ok: false, error: 'This node doesn\'t run contracts', retry: false };
        } catch (error) {
            this.log(error, `Event contract ${qualifiedName(consumer.path, consumer.name)} failed on event ${item.envelope.id}`);
            result = { ok: false, error: 'Internal error', retry: true };
        }
        if (result.ok) {
            await this.repository.settleInbox(item, { status: 'done' });
            return;
        }
        const attempts = item.attempts + 1;
        const failed = !result.retry || attempts >= MAX_EVENT_RUN_ATTEMPTS;
        await this.repository.settleInbox(item, { status: failed ? 'failed' : 'pending', attempts, nextAttemptAt: Date.now() + retryDelayMs(attempts), error: result.error });
    }

    /** Runs both queues soon, once the workers are started. */
    private kick(): void {
        if (!this.workers || this.kicked) {
            return;
        }
        this.kicked = setImmediate(() => {
            this.kicked = undefined;
            void this.dispatchDue().catch(error => this.log(error, 'Failed to deliver events'));
            void this.processInbox().catch(error => this.log(error, 'Failed to run event contracts'));
        });
    }

    /**
     * Runs the queues every `intervalMs`, and as soon as an event is queued, until `stop`. Also reclaims work a
     * stopped worker left claimed, and deletes old settled rows.
     */
    startWorkers(intervalMs: number): { stop: () => void } {
        let timer: NodeJS.Timeout | undefined;
        let stopped = false;
        const tick = async () => {
            try {
                const now = Date.now();
                await this.repository.maintain(now - STALE_CLAIM_MS, now - SETTLED_RETENTION_MS);
                await Promise.all([this.dispatchDue(), this.processInbox()]);
            } catch (error) {
                this.log(error, 'Failed to run the event queues');
            }
            if (!stopped) {
                timer = setTimeout(tick, intervalMs);
                timer.unref();
            }
        };
        timer = setTimeout(tick, 0);
        timer.unref();
        this.workers = {
            stop: () => {
                stopped = true;
                clearTimeout(timer);
                if (this.kicked) {
                    clearImmediate(this.kicked);
                    this.kicked = undefined;
                }
                this.workers = undefined;
            },
        };
        return this.workers;
    }

    // Announcements

    /** This node's event types and event contracts, signed, as peers learn them. */
    async announcement(): Promise<EventAnnouncement> {
        const { membershipToken, organizationId, publicKey, privateKey } = this.config;
        // Only a node that can prove its organization announces the types that organization owns.
        const eventTypes: AnnouncedEventType[] = membershipToken && organizationId
            ? (await this.repository.localTypes()).filter(type => type.ownerOrganizationId === organizationId)
            : [];
        const subscriptions = (await this.repository.consumers()).map(consumer => ({
            eventPath: consumer.eventPath,
            eventName: consumer.eventName,
            eventVersion: consumer.eventVersion,
            consumer: qualifiedName(consumer.path, consumer.name),
            ownerOrganizationId: consumer.ownerOrganizationId ?? organizationId ?? null,
        }));
        const unsigned = { membershipToken: membershipToken ?? null, eventTypes, subscriptions, expiry: new Date(Date.now() + ANNOUNCEMENT_LIFETIME_MS).toISOString() };
        return { publicKey, ...unsigned, signature: signData(eventAnnouncementPayload(unsigned), privateKey) };
    }

    /**
     * Learns a peer's event types and event contracts from its signed announcement, replacing what it said
     * before. Event types are learned only when the operator's token says the peer belongs to their owner.
     * Returns the event types it refused.
     */
    async applyAnnouncement(announcement: EventAnnouncement, peerBaseUrl: string): Promise<{ ok: true, rejected: string[] } | ContractRefusal> {
        if (!isFreshExpiry(announcement.expiry) || !safeVerifyData(eventAnnouncementPayload(announcement), announcement.publicKey, announcement.signature)) {
            return refuse(400, 'Invalid signature');
        }
        let typeOwner: string | undefined;
        if (announcement.membershipToken && this.verifier) {
            const membership = await this.verifier.verifyMembership(announcement.membershipToken);
            if (membership?.publicKey === announcement.publicKey) {
                typeOwner = membership.organizationId;
            }
        }
        // An event type whose fields name a struct this node doesn't know waits until it learns the struct.
        const unknownStructs: string[] = [];
        const eventTypes: AnnouncedEventType[] = [];
        for (const eventType of announcement.eventTypes) {
            if (await this.namesUnknownStruct(eventType.fields)) {
                unknownStructs.push(`${qualifiedName(eventType.path, eventType.name)}@${eventType.version}`);
            } else {
                eventTypes.push(eventType);
            }
        }
        const rejected = await this.repository.replaceLearned(peerBaseUrl, eventTypes, typeOwner, announcement.subscriptions);
        return { ok: true, rejected: [...unknownStructs, ...rejected] };
    }

    /** Whether any of the fields' types names a struct this node doesn't know. */
    private async namesUnknownStruct(fields: { type: string }[]): Promise<boolean> {
        const refs = fields.flatMap(field => {
            try {
                return typeStructReferences(parseTypeString(field.type));
            } catch {
                return [];
            }
        });
        if (refs.length === 0) {
            return false;
        }
        return !this.structs || (await this.structs.unknownReferences(refs)).length > 0;
    }
}
