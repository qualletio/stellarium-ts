import { ClientCredentials, type CredentialSource, StaticCredential } from './auth.js';
import { errorFrom, StellariumError } from './errors.js';
import type {
    Contract,
    ContractStateVariable,
    DeployedContract,
    DeployedEventType,
    EventType,
    NodeIdentity,
    Page,
    PageOptions,
    Peer,
    RequestOptions,
    Resource,
    RunResult,
    Struct,
} from './types.js';

/** How the client authenticates to the node. Omit it to use only the routes anyone may call. */
export type ClientAuth =
    /** The node's `API_KEY`. Runs are free, and the node's own organization pays their calls. */
    | { apiKey: string }
    /** A run token, or a function returning one, from wherever the caller gets them. */
    | { token: string | ((signal?: AbortSignal) => string | Promise<string>) }
    /**
     * An organization's API client: the client fetches and renews run tokens from the operator, by default the
     * Stellarium network's (`https://operator.stellarium.sh/v1`).
     */
    | { clientId: string, clientSecret: string, operatorUrl?: string }
    /** Any other source of bearer credentials. */
    | { credentials: CredentialSource };

export type StellariumClientOptions = {
    /** The node's base URL, as listings show it, e.g. `https://node.example.com`. */
    nodeUrl: string;
    /** Defaults to the global `fetch`. */
    fetch?: typeof fetch;
    /** Sent with every request. */
    headers?: Record<string, string>;
} & (ClientAuth | { [K in 'apiKey' | 'token' | 'clientId' | 'credentials']?: never });

interface Call {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    auth?: boolean;
    signal?: AbortSignal;
}

/** A RequestScript source, with an optional description shown in the node's listings. */
export interface DeployOptions extends RequestOptions {
    description?: string;
}

/**
 * A client for one Stellarium node: runs RequestScript on it, reads what it knows of the network, and deploys
 * contracts, event types and structs to it.
 *
 * ```ts
 * const client = new StellariumClient({
 *     nodeUrl: 'https://node.example.com',
 *     clientId: process.env.STELLARIUM_CLIENT_ID!,
 *     clientSecret: process.env.STELLARIUM_CLIENT_SECRET!,
 * });
 * const { returnValue } = await client.run(`request Hello { return "hi" }`);
 * ```
 */
export class StellariumClient {
    readonly nodeUrl: string;
    private readonly fetch: typeof fetch;
    private readonly credentials?: CredentialSource;
    private readonly headers: Record<string, string>;

    readonly resources: {
        /** One page of the resources a script on this node can use: its own, then those it learned from peers. */
        list(options?: PageOptions & RequestOptions): Promise<Page<Resource>>;
        all(options?: RequestOptions): AsyncIterable<Resource>;
        /** A resource by path and name, e.g. `get('com.example', 'Weather')`, or undefined. Reads every page. */
        get(path: string, name: string, options?: RequestOptions): Promise<Resource | undefined>;
    };

    readonly peers: {
        list(options?: PageOptions & RequestOptions): Promise<Page<Peer>>;
        all(options?: RequestOptions): AsyncIterable<Peer>;
    };

    readonly contracts: {
        /** Deploys a version of a contract, which becomes one of the node's resources. */
        deploy(source: string, options?: DeployOptions): Promise<DeployedContract>;
        /** Every version of every contract on the node, with its source. */
        list(options?: PageOptions & RequestOptions): Promise<Page<Contract>>;
        all(options?: RequestOptions): AsyncIterable<Contract>;
        /** A contract's state variables, every scope. Only its owner and the node's admin may read them. */
        state(ref: string, options?: RequestOptions): Promise<ContractStateVariable[]>;
        /** Deletes `path.Name@version`, or every version of `path.Name`. */
        delete(ref: string, options?: RequestOptions): Promise<void>;
    };

    readonly events: {
        /** Declares a version of an event type, owned by the node's organization. */
        deploy(source: string, options?: DeployOptions): Promise<DeployedEventType>;
        list(options?: PageOptions & RequestOptions): Promise<Page<EventType>>;
        all(options?: RequestOptions): AsyncIterable<EventType>;
        delete(ref: string, options?: RequestOptions): Promise<void>;
    };

    readonly structs: {
        /** Declares a version of a struct. Declaring the same fields again changes nothing. */
        deploy(source: string, options?: DeployOptions): Promise<Struct>;
        list(options?: PageOptions & RequestOptions): Promise<Page<Struct>>;
        all(options?: RequestOptions): AsyncIterable<Struct>;
        /** `path.Name@version`, or the latest version of `path.Name`; undefined when the node doesn't know it. */
        get(ref: string, options?: RequestOptions): Promise<Struct | undefined>;
    };

    constructor(options: StellariumClientOptions) {
        if (!/^https?:\/\//.test(options.nodeUrl ?? '')) {
            throw new TypeError('nodeUrl must be an http(s) URL');
        }
        this.nodeUrl = options.nodeUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
        this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.headers = options.headers ?? {};
        this.credentials = credentialsFor(options, this.fetch);

        const paged = <T>(path: string, key: string) => ({
            list: (page: PageOptions & RequestOptions = {}) => this.page<T>(path, key, page),
            all: (request: RequestOptions = {}) => this.iterate<T>(path, key, request),
        });

        const resources = paged<Resource>('/resources', 'resources');
        this.resources = {
            ...resources,
            get: async (path, name, request = {}) => {
                for await (const resource of resources.all(request)) {
                    if (resource.path === path && resource.name === name) return resource;
                }
                return undefined;
            },
        };
        this.peers = paged<Peer>('/peers', 'peers');
        this.contracts = {
            ...paged<Contract>('/contracts', 'contracts'),
            deploy: (source, { description, signal } = {}) =>
                this.call({ method: 'POST', path: '/contracts', body: { source, description }, auth: true, signal }),
            state: async (ref, { signal } = {}) =>
                (await this.call<{ variables: ContractStateVariable[] }>({ method: 'GET', path: `/contracts/${encodeURIComponent(ref)}/state`, auth: true, signal })).variables,
            delete: async (ref, { signal } = {}) => {
                await this.call({ method: 'DELETE', path: `/contracts/${encodeURIComponent(ref)}`, auth: true, signal });
            },
        };
        this.events = {
            ...paged<EventType>('/events', 'eventTypes'),
            deploy: (source, { description, signal } = {}) =>
                this.call({ method: 'POST', path: '/events', body: { source, description }, auth: true, signal }),
            delete: async (ref, { signal } = {}) => {
                await this.call({ method: 'DELETE', path: `/events/${encodeURIComponent(ref)}`, auth: true, signal });
            },
        };
        this.structs = {
            ...paged<Struct>('/structs', 'structs'),
            deploy: (source, { description, signal } = {}) =>
                this.call({ method: 'POST', path: '/structs', body: { source, description }, auth: true, signal }),
            get: async (ref, { signal } = {}) => {
                try {
                    return await this.call<Struct>({ method: 'GET', path: `/structs/${encodeURIComponent(ref)}`, signal });
                } catch (error) {
                    if (error instanceof StellariumError && error.status === 404) return undefined;
                    throw error;
                }
            },
        };
    }

    /**
     * Runs a RequestScript `request` on the node and answers its return value. A run token from another
     * organization's API client is billed to that organization: the node's listed price per million tokens
     * executed, plus the paid calls the script makes.
     *
     * Throws a `StellariumError`: 400 when the script doesn't parse, 401 for a refused credential, 402 or 403 when
     * the operator refuses to bill the run, and 422 when the script fails while running (see `details`).
     */
    async run<T = unknown>(source: string, options: RequestOptions = {}): Promise<RunResult<T>> {
        return this.call<RunResult<T>>({ method: 'POST', path: '/run', body: { source }, auth: true, signal: options.signal });
    }

    /** The node's base URL and public key. */
    async self(options: RequestOptions = {}): Promise<NodeIdentity> {
        return this.call({ method: 'GET', path: '/self', signal: options.signal });
    }

    private async page<T>(path: string, key: string, { offset, limit, signal }: PageOptions & RequestOptions): Promise<Page<T>> {
        const body = await this.call<Record<string, unknown>>({ method: 'GET', path, query: { offset, limit }, signal });
        return { items: (body[key] ?? []) as T[], nextOffset: (body.nextOffset as number | null | undefined) ?? null };
    }

    private async *iterate<T>(path: string, key: string, { signal }: RequestOptions): AsyncGenerator<T> {
        let offset: number | null = 0;
        while (offset !== null) {
            const page: Page<T> = await this.page<T>(path, key, { offset, limit: 100, signal });
            yield* page.items;
            offset = page.nextOffset;
        }
    }

    private async call<T>(call: Call): Promise<T> {
        let { response, credential } = await this.send(call);
        // A run token can be cut short; try once more with a fresh credential. Refused requests never ran.
        if (response.status === 401 && credential !== undefined && this.credentials?.refused?.(credential)) {
            await response.body?.cancel();
            ({ response } = await this.send(call));
        }
        if (!response.ok) throw await errorFrom(response);
        if (response.status === 204) return undefined as T;
        return await response.json() as T;
    }

    private async send(call: Call): Promise<{ response: Response, credential?: string }> {
        const url = new URL(`${this.nodeUrl}/v1${call.path}`);
        for (const [name, value] of Object.entries(call.query ?? {})) {
            if (value !== undefined) url.searchParams.set(name, String(value));
        }
        const headers: Record<string, string> = { Accept: 'application/json', ...this.headers };
        let credential: string | undefined;
        if (call.auth) {
            if (!this.credentials) {
                throw new TypeError(`${call.method} ${call.path} needs credentials: pass apiKey, token, or clientId and clientSecret`);
            }
            credential = await this.credentials.credential(call.signal);
            headers.Authorization = `Bearer ${credential}`;
        }
        if (call.body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await this.fetch(url, {
            method: call.method,
            headers,
            body: call.body === undefined ? undefined : JSON.stringify(call.body),
            signal: call.signal,
        });
        return { response, credential };
    }
}

function credentialsFor(options: StellariumClientOptions, fetch: typeof globalThis.fetch): CredentialSource | undefined {
    const given = ['apiKey', 'token', 'clientId', 'credentials'].filter((key) => (options as Record<string, unknown>)[key] !== undefined);
    if (given.length > 1) {
        throw new TypeError(`Pass one of apiKey, token, clientId or credentials, not ${given.join(' and ')}`);
    }
    if ('credentials' in options && options.credentials) return options.credentials;
    if ('apiKey' in options && options.apiKey !== undefined) return new StaticCredential(options.apiKey);
    if ('token' in options && options.token !== undefined) return new StaticCredential(options.token);
    if ('clientId' in options && options.clientId !== undefined) {
        return new ClientCredentials({ operatorUrl: options.operatorUrl, clientId: options.clientId, clientSecret: options.clientSecret, fetch });
    }
    return undefined;
}
