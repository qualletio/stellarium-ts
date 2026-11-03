/** How many events deep a chain may go: an event consumed by a contract that emits, and so on. */
export const MAX_EVENT_DEPTH = 4;
/** The most events one run may emit. */
export const DEFAULT_MAX_EVENTS_PER_RUN = 16;
/** The most one event's data may take, as JSON. */
export const DEFAULT_MAX_EVENT_DATA_BYTES = 32 * 1024;
/**
 * How long after it was published an event is still delivered and accepted. The publisher stops retrying, and
 * receivers refuse it, after this, so a node removed from its organization can't publish for long on an old token.
 */
export const EVENT_MAX_AGE_MS = 1000 * 60 * 60 * 24;

/** A field of an event type: its name and RequestScript type string. */
export interface EventField {
    name: string;
    type: string;
}

/** An event type this node knows: declared here, or learned from the node that declared it. */
export interface EventTypeDefinition {
    path: string;
    name: string;
    version: string;
    fields: EventField[];
    /** Delivered only to event contracts deployed by its owner. */
    restricted: boolean;
    /** The organization that owns it, the only one whose nodes and scripts may emit it. */
    ownerOrganizationId: string;
    /** The node that declared it. */
    baseUrl: string;
    description: string | null;
    createdAt: string;
}

/** A peer's event contract, as its announcement says. */
export interface EventSubscription {
    eventPath: string;
    eventName: string;
    eventVersion: string;
    /** The event contract, as path.Name. */
    consumer: string;
    /** Who deployed the event contract, which restricted events must match. Null when the node doesn't know its organization. */
    ownerOrganizationId: string | null;
}

/**
 * The chain an event belongs to. `depth` is how many events deep it is, 1 for an event a script emitted on its
 * own. `types` are the event types (path.Name) before it, and `contracts` the contracts (path.Name) that emitted
 * or consumed them. A contract in the chain can't emit a type in it, or call a contract in it.
 */
export interface EventLineage {
    depth: number;
    types: string[];
    contracts: string[];
}

/** One published event, as nodes deliver it to each other. */
export interface EventEnvelope {
    /** Unique per event. Receivers run each consumer once per id. */
    id: string;
    /** path.Name */
    type: string;
    version: string;
    ownerOrganizationId: string;
    data: Record<string, unknown>;
    publishedAt: string;
    depth: number;
    lineage: { types: string[], contracts: string[] };
    publisherPublicKey: string;
    /** The operator's statement that the publisher belongs to `ownerOrganizationId`. */
    membershipToken: string;
    /** Over `eventEnvelopePayload`, by `publisherPublicKey`. */
    signature: string;
}

/**
 * What an event's signature covers: every field but the signature, in this order. `signData` signs
 * `JSON.stringify` output, so the order is part of the signed bytes.
 */
export function eventEnvelopePayload(envelope: Omit<EventEnvelope, 'signature'>) {
    return {
        id: envelope.id,
        type: envelope.type,
        version: envelope.version,
        ownerOrganizationId: envelope.ownerOrganizationId,
        data: envelope.data,
        publishedAt: envelope.publishedAt,
        depth: envelope.depth,
        lineage: { types: envelope.lineage.types, contracts: envelope.lineage.contracts },
        publisherPublicKey: envelope.publisherPublicKey,
        membershipToken: envelope.membershipToken,
    };
}

/** An event type, as a node announces the ones it declared. */
export interface AnnouncedEventType {
    path: string;
    name: string;
    version: string;
    fields: EventField[];
    restricted: boolean;
    ownerOrganizationId: string;
    description: string | null;
}

/**
 * A node's event types and event contracts, signed by its key. Receivers accept event types only when the
 * operator's membership token says the node belongs to their owner.
 */
export interface EventAnnouncement {
    publicKey: string;
    /** Absent when the node has no session with an operator, which also means it declares no event types. */
    membershipToken: string | null;
    eventTypes: AnnouncedEventType[];
    subscriptions: EventSubscription[];
    expiry: string;
    signature: string;
}

export function eventAnnouncementPayload(announcement: Omit<EventAnnouncement, 'signature' | 'publicKey'>) {
    return {
        membershipToken: announcement.membershipToken,
        eventTypes: announcement.eventTypes,
        subscriptions: announcement.subscriptions,
        expiry: announcement.expiry,
    };
}

/** `path.Name` */
export function qualifiedName(path: string, name: string): string {
    return `${path}.${name}`;
}
