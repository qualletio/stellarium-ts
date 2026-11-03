import { compareVersions } from "requestscript";
import type { NodeDatabase } from "../db/database.js";
import type { AnnouncedEventType, EventEnvelope, EventSubscription, EventTypeDefinition } from "./types.js";

interface EventTypeRow {
    path: string;
    name: string;
    version: string;
    fields: string;
    restricted: number;
    owner_organization_id: string;
    base_url: string;
    local: number;
    description: string | null;
    created_at: string;
}

function toEventType(row: EventTypeRow): EventTypeDefinition {
    return {
        path: row.path,
        name: row.name,
        version: row.version,
        fields: JSON.parse(row.fields),
        restricted: Number(row.restricted) === 1,
        ownerOrganizationId: row.owner_organization_id,
        baseUrl: row.base_url,
        description: row.description,
        createdAt: row.created_at,
    };
}

/** An event contract on this node. */
export interface EventConsumer {
    path: string;
    name: string;
    eventPath: string;
    eventName: string;
    eventVersion: string;
    ownerOrganizationId: string | null;
    mandateId: string | null;
}

interface EventConsumerRow {
    path: string;
    name: string;
    event_path: string;
    event_name: string;
    event_version: string;
    owner_organization_id: string | null;
    mandate_id: string | null;
}

function toConsumer(row: EventConsumerRow): EventConsumer {
    return {
        path: row.path,
        name: row.name,
        eventPath: row.event_path,
        eventName: row.event_name,
        eventVersion: row.event_version,
        ownerOrganizationId: row.owner_organization_id,
        mandateId: row.mandate_id,
    };
}

/** An event waiting to be delivered to a peer, or to be run by one of this node's event contracts. */
export interface QueuedDelivery {
    envelope: EventEnvelope;
    attempts: number;
}

export interface OutboxItem extends QueuedDelivery {
    id: number;
    targetBaseUrl: string;
}

export interface InboxItem extends QueuedDelivery {
    consumerPath: string;
    consumerName: string;
}

/** A queued event, as the admin routes list it. */
export interface QueueRow {
    eventId: string;
    type: string;
    target: string;
    status: string;
    attempts: number;
    lastError: string | null;
    updatedAt: string;
}

/** One event to queue: for this node's event contracts, and for the peers subscribed to it. */
export interface QueuedEvent {
    envelope: EventEnvelope;
    consumers: { path: string, name: string }[];
    targets: string[];
}

export type SaveEventTypeRefusal = 'version_exists' | 'owned_elsewhere';

/** The event types this node knows, its event contracts, its peers' event contracts, and its event queues. */
export class EventRepository {
    constructor(private readonly db: NodeDatabase) {}

    // Event types

    /**
     * Saves a version of an event type this node declares. Refused when the type was learned from another
     * node, or belongs to another organization.
     */
    async saveLocalType(type: Omit<EventTypeDefinition, 'createdAt'>, source: string): Promise<{ ok: true } | { ok: false, refused: SaveEventTypeRefusal }> {
        return this.db.transaction(async (tx) => {
            const existing = await tx.all<EventTypeRow[]>('SELECT * FROM event_type WHERE path = ? AND name = ?', [type.path, type.name]);
            if (existing.some(row => Number(row.local) !== 1 || row.owner_organization_id !== type.ownerOrganizationId)) {
                return { ok: false as const, refused: 'owned_elsewhere' as const };
            }
            if (existing.some(row => row.version === type.version)) {
                return { ok: false as const, refused: 'version_exists' as const };
            }
            await tx.run(
                'INSERT INTO event_type (path, name, version, fields, restricted, owner_organization_id, base_url, local, source, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
                [type.path, type.name, type.version, JSON.stringify(type.fields), type.restricted ? 1 : 0, type.ownerOrganizationId, type.baseUrl, source, type.description, new Date().toISOString()],
            );
            return { ok: true as const };
        });
    }

    /** Deletes a version, or every version, of an event type this node declared. False when there was none. */
    async deleteLocalType(path: string, name: string, version?: string): Promise<boolean> {
        const result = version === undefined
            ? await this.db.run('DELETE FROM event_type WHERE path = ? AND name = ? AND local = 1', [path, name])
            : await this.db.run('DELETE FROM event_type WHERE path = ? AND name = ? AND version = ? AND local = 1', [path, name, version]);
        return result.changes > 0;
    }

    /** The event type at `version`, or its latest version. */
    async resolveType(path: string, name: string, version?: string): Promise<EventTypeDefinition | undefined> {
        const rows = await this.db.all<EventTypeRow[]>('SELECT * FROM event_type WHERE path = ? AND name = ?', [path, name]);
        if (version !== undefined) {
            const row = rows.find(candidate => candidate.version === version);
            return row && toEventType(row);
        }
        const latest = rows.sort((a, b) => compareVersions(b.version, a.version))[0];
        return latest && toEventType(latest);
    }

    /** Whether this node declared `path.name`, at any version. */
    async isLocalType(path: string, name: string): Promise<boolean> {
        return (await this.db.get('SELECT 1 AS found FROM event_type WHERE path = ? AND name = ? AND local = 1 LIMIT 1', [path, name])) !== undefined;
    }

    /** One page of every event type this node knows, its own first. */
    async listTypes(offset: number, limit: number): Promise<EventTypeDefinition[]> {
        const rows = await this.db.all<EventTypeRow[]>('SELECT * FROM event_type ORDER BY local DESC, path, name, created_at, version LIMIT ? OFFSET ?', [limit, offset]);
        return rows.map(toEventType);
    }

    /** Every version of every event type this node declared, for its announcement. */
    async localTypes(): Promise<AnnouncedEventType[]> {
        const rows = await this.db.all<EventTypeRow[]>('SELECT * FROM event_type WHERE local = 1 ORDER BY path, name, version');
        return rows.map(row => {
            const { path, name, version, fields, restricted, ownerOrganizationId, description } = toEventType(row);
            return { path, name, version, fields, restricted, ownerOrganizationId, description };
        });
    }

    /**
     * Replaces what this node learned from the peer at `baseUrl`: its event types, the ones `typeOwner` allows,
     * and its event contracts. A type this node declared, or learned from another peer, keeps its first
     * declarer. Returns the types refused, as path.Name@version.
     */
    async replaceLearned(baseUrl: string, types: AnnouncedEventType[], typeOwner: string | undefined, subscriptions: EventSubscription[]): Promise<string[]> {
        return this.db.transaction(async (tx) => {
            await tx.run('DELETE FROM event_type WHERE base_url = ? AND local = 0', [baseUrl]);
            await tx.run('DELETE FROM event_subscription WHERE base_url = ?', [baseUrl]);
            const rejected: string[] = [];
            const now = new Date().toISOString();
            for (const type of types) {
                const label = `${type.path}.${type.name}@${type.version}`;
                const taken = await tx.get('SELECT 1 AS found FROM event_type WHERE path = ? AND name = ? AND (local = 1 OR base_url <> ?) LIMIT 1', [type.path, type.name, baseUrl]);
                if (taken || typeOwner === undefined || type.ownerOrganizationId !== typeOwner) {
                    rejected.push(label);
                    continue;
                }
                await tx.run(
                    'INSERT INTO event_type (path, name, version, fields, restricted, owner_organization_id, base_url, local, source, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?) ON CONFLICT DO NOTHING',
                    [type.path, type.name, type.version, JSON.stringify(type.fields), type.restricted ? 1 : 0, type.ownerOrganizationId, baseUrl, type.description, now],
                );
            }
            for (const subscription of subscriptions) {
                await tx.run(
                    'INSERT INTO event_subscription (base_url, event_path, event_name, event_version, consumer, owner_organization_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
                    [baseUrl, subscription.eventPath, subscription.eventName, subscription.eventVersion, subscription.consumer, subscription.ownerOrganizationId],
                );
            }
            return rejected;
        });
    }

    // Event contracts

    async saveConsumer(consumer: EventConsumer): Promise<void> {
        await this.db.run(
            `INSERT INTO event_consumer (path, name, event_path, event_name, event_version, owner_organization_id, mandate_id) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (path, name) DO UPDATE SET event_path = excluded.event_path, event_name = excluded.event_name, event_version = excluded.event_version,
                 owner_organization_id = excluded.owner_organization_id, mandate_id = excluded.mandate_id`,
            [consumer.path, consumer.name, consumer.eventPath, consumer.eventName, consumer.eventVersion, consumer.ownerOrganizationId, consumer.mandateId],
        );
    }

    async consumer(path: string, name: string): Promise<EventConsumer | undefined> {
        const row = await this.db.get<EventConsumerRow>('SELECT * FROM event_consumer WHERE path = ? AND name = ?', [path, name]);
        return row && toConsumer(row);
    }

    async deleteConsumer(path: string, name: string): Promise<void> {
        await this.db.run('DELETE FROM event_consumer WHERE path = ? AND name = ?', [path, name]);
    }

    async consumers(): Promise<EventConsumer[]> {
        return (await this.db.all<EventConsumerRow[]>('SELECT * FROM event_consumer ORDER BY path, name')).map(toConsumer);
    }

    /** This node's event contracts for one version of an event type. */
    async consumersOf(path: string, name: string, version: string): Promise<EventConsumer[]> {
        const rows = await this.db.all<EventConsumerRow[]>('SELECT * FROM event_consumer WHERE event_path = ? AND event_name = ? AND event_version = ? ORDER BY path, name', [path, name, version]);
        return rows.map(toConsumer);
    }

    /** Peers' event contracts for one version of an event type, with the peers' base URLs. */
    async subscribersOf(path: string, name: string, version: string): Promise<(EventSubscription & { baseUrl: string })[]> {
        const rows = await this.db.all<{ base_url: string, consumer: string, owner_organization_id: string | null }[]>(
            'SELECT base_url, consumer, owner_organization_id FROM event_subscription WHERE event_path = ? AND event_name = ? AND event_version = ? ORDER BY base_url, consumer',
            [path, name, version],
        );
        return rows.map(row => ({ baseUrl: row.base_url, eventPath: path, eventName: name, eventVersion: version, consumer: row.consumer, ownerOrganizationId: row.owner_organization_id }));
    }

    // Queues

    /** Queues events for this node's event contracts and for delivery to peers, all or none. */
    async enqueue(events: QueuedEvent[], now: number = Date.now()): Promise<void> {
        const stamp = new Date(now).toISOString();
        await this.db.transaction(async (tx) => {
            for (const { envelope, consumers, targets } of events) {
                const serialized = JSON.stringify(envelope);
                for (const consumer of consumers) {
                    await tx.run(
                        'INSERT INTO event_inbox (event_id, consumer_path, consumer_name, envelope, status, attempts, next_attempt_at, last_error, received_at, updated_at) VALUES (?, ?, ?, ?, \'pending\', 0, ?, NULL, ?, ?) ON CONFLICT DO NOTHING',
                        [envelope.id, consumer.path, consumer.name, serialized, now, stamp, stamp],
                    );
                }
                for (const target of targets) {
                    await tx.run(
                        'INSERT INTO event_outbox (event_id, target_base_url, envelope, status, attempts, next_attempt_at, last_error, created_at, updated_at) VALUES (?, ?, ?, \'pending\', 0, ?, NULL, ?, ?) ON CONFLICT DO NOTHING',
                        [envelope.id, target, serialized, now, stamp, stamp],
                    );
                }
            }
        });
    }

    /**
     * Claims up to `limit` deliveries that are due, marking them 'sending', so another worker sharing the
     * database doesn't send them too.
     */
    async claimOutbox(now: number, limit: number): Promise<OutboxItem[]> {
        const due = await this.db.all<{ id: number, target_base_url: string, envelope: string, attempts: number }[]>(
            'SELECT id, target_base_url, envelope, attempts FROM event_outbox WHERE status = \'pending\' AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT ?',
            [now, limit],
        );
        const claimed: OutboxItem[] = [];
        for (const row of due) {
            const result = await this.db.run('UPDATE event_outbox SET status = \'sending\', updated_at = ? WHERE id = ? AND status = \'pending\'', [new Date(now).toISOString(), row.id]);
            if (result.changes === 1) {
                claimed.push({ id: Number(row.id), targetBaseUrl: row.target_base_url, envelope: JSON.parse(row.envelope), attempts: Number(row.attempts) });
            }
        }
        return claimed;
    }

    /** Records a claimed delivery's outcome: delivered, to retry at `nextAttemptAt`, or failed for good. */
    async settleOutbox(id: number, outcome: { status: 'delivered' } | { status: 'pending' | 'failed', attempts: number, nextAttemptAt: number, error: string }, now: number = Date.now()): Promise<void> {
        const stamp = new Date(now).toISOString();
        if (outcome.status === 'delivered') {
            await this.db.run('UPDATE event_outbox SET status = \'delivered\', last_error = NULL, updated_at = ? WHERE id = ?', [stamp, id]);
            return;
        }
        await this.db.run(
            'UPDATE event_outbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
            [outcome.status, outcome.attempts, outcome.nextAttemptAt, outcome.error, stamp, id],
        );
    }

    /** Claims up to `limit` events that are due to be run by this node's event contracts, marking them 'running'. */
    async claimInbox(now: number, limit: number): Promise<InboxItem[]> {
        const due = await this.db.all<{ event_id: string, consumer_path: string, consumer_name: string, envelope: string, attempts: number }[]>(
            'SELECT event_id, consumer_path, consumer_name, envelope, attempts FROM event_inbox WHERE status = \'pending\' AND next_attempt_at <= ? ORDER BY next_attempt_at, received_at LIMIT ?',
            [now, limit],
        );
        const claimed: InboxItem[] = [];
        for (const row of due) {
            const result = await this.db.run(
                'UPDATE event_inbox SET status = \'running\', updated_at = ? WHERE event_id = ? AND consumer_path = ? AND consumer_name = ? AND status = \'pending\'',
                [new Date(now).toISOString(), row.event_id, row.consumer_path, row.consumer_name],
            );
            if (result.changes === 1) {
                claimed.push({ consumerPath: row.consumer_path, consumerName: row.consumer_name, envelope: JSON.parse(row.envelope), attempts: Number(row.attempts) });
            }
        }
        return claimed;
    }

    /** Records a claimed event's outcome: done, to retry at `nextAttemptAt`, or failed for good. */
    async settleInbox(item: InboxItem, outcome: { status: 'done' } | { status: 'pending' | 'failed', attempts: number, nextAttemptAt: number, error: string }, now: number = Date.now()): Promise<void> {
        const stamp = new Date(now).toISOString();
        const key = [item.envelope.id, item.consumerPath, item.consumerName];
        if (outcome.status === 'done') {
            await this.db.run('UPDATE event_inbox SET status = \'done\', attempts = attempts + 1, last_error = NULL, updated_at = ? WHERE event_id = ? AND consumer_path = ? AND consumer_name = ?', [stamp, ...key]);
            return;
        }
        await this.db.run(
            'UPDATE event_inbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE event_id = ? AND consumer_path = ? AND consumer_name = ?',
            [outcome.status, outcome.attempts, outcome.nextAttemptAt, outcome.error, stamp, ...key],
        );
    }

    /**
     * Returns deliveries and events claimed before `staleBefore` to 'pending': their worker stopped before it
     * settled them. Deletes what was settled before `settledBefore`.
     */
    async maintain(staleBefore: number, settledBefore: number): Promise<void> {
        const stale = new Date(staleBefore).toISOString();
        const settled = new Date(settledBefore).toISOString();
        await this.db.run('UPDATE event_outbox SET status = \'pending\' WHERE status = \'sending\' AND updated_at < ?', [stale]);
        await this.db.run('UPDATE event_inbox SET status = \'pending\' WHERE status = \'running\' AND updated_at < ?', [stale]);
        await this.db.run('DELETE FROM event_outbox WHERE status IN (\'delivered\', \'failed\') AND updated_at < ?', [settled]);
        await this.db.run('DELETE FROM event_inbox WHERE status IN (\'done\', \'failed\') AND updated_at < ?', [settled]);
    }

    /** One page of the deliveries to peers, newest first, optionally with one status. */
    async listOutbox(status: string | undefined, offset: number, limit: number): Promise<QueueRow[]> {
        const rows = await this.db.all<{ event_id: string, target_base_url: string, envelope: string, status: string, attempts: number, last_error: string | null, updated_at: string }[]>(
            `SELECT event_id, target_base_url, envelope, status, attempts, last_error, updated_at FROM event_outbox ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT ? OFFSET ?`,
            status ? [status, limit, offset] : [limit, offset],
        );
        return rows.map(row => ({ eventId: row.event_id, type: (JSON.parse(row.envelope) as EventEnvelope).type, target: row.target_base_url, status: row.status, attempts: Number(row.attempts), lastError: row.last_error, updatedAt: row.updated_at }));
    }

    /** One page of the events this node's event contracts ran or will run, newest first, optionally with one status. */
    async listInbox(status: string | undefined, offset: number, limit: number): Promise<QueueRow[]> {
        const rows = await this.db.all<{ event_id: string, consumer_path: string, consumer_name: string, envelope: string, status: string, attempts: number, last_error: string | null, updated_at: string }[]>(
            `SELECT event_id, consumer_path, consumer_name, envelope, status, attempts, last_error, updated_at FROM event_inbox ${status ? 'WHERE status = ?' : ''} ORDER BY received_at DESC, event_id LIMIT ? OFFSET ?`,
            status ? [status, limit, offset] : [limit, offset],
        );
        return rows.map(row => ({ eventId: row.event_id, type: (JSON.parse(row.envelope) as EventEnvelope).type, target: `${row.consumer_path}.${row.consumer_name}`, status: row.status, attempts: Number(row.attempts), lastError: row.last_error, updatedAt: row.updated_at }));
    }
}
