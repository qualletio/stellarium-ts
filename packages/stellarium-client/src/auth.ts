import { errorFrom, StellariumError } from './errors.js';

/** Something that yields a bearer credential for a node: an API key or a run token. */
export interface CredentialSource {
    /** The credential to send. Called before every authenticated request, so it should cache. */
    credential(signal?: AbortSignal): Promise<string>;
    /**
     * Called when the node refused the credential. Returns true when a fresh one may succeed, and the request is
     * then retried once.
     */
    refused?(credential: string): boolean;
}

/** The Stellarium network's operator. */
export const DEFAULT_OPERATOR_URL = 'https://operator.stellarium.sh/v1';

export interface ClientCredentialsOptions {
    /**
     * The operator's API, as nodes' `OPERATOR_URL`: `https://<operator host>/v1`, with `/v1` added when missing.
     * Defaults to the Stellarium network's operator.
     */
    operatorUrl?: string;
    /** An API client's id (`cli_...`), from the dashboard's API clients page. */
    clientId: string;
    /** The client's secret (`cs_...`). It is shown once, when the client is created. */
    clientSecret: string;
    /** Run tokens are fetched again this long before they expire. Defaults to 60 seconds. */
    refreshMarginMs?: number;
    fetch?: typeof fetch;
}

/** The operator's API root, with `/v1` and without a trailing slash. */
export function operatorApiUrl(operatorUrl: string): string {
    const trimmed = operatorUrl.replace(/\/+$/, '');
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

/**
 * Run tokens for an organization's API client, from the operator's OAuth client credentials grant. A token is
 * cached until shortly before it expires, and concurrent requests share one fetch.
 */
export class ClientCredentials implements CredentialSource {
    private readonly tokenUrl: string;
    private readonly refreshMarginMs: number;
    private readonly fetch: typeof fetch;
    private cached?: { token: string, expiresAt: number };
    private pending?: Promise<string>;

    constructor(private readonly options: ClientCredentialsOptions) {
        if (!options.clientId || !options.clientSecret) {
            throw new TypeError('clientId and clientSecret are required');
        }
        this.tokenUrl = `${operatorApiUrl(options.operatorUrl ?? DEFAULT_OPERATOR_URL)}/oauth/token`;
        this.refreshMarginMs = options.refreshMarginMs ?? 60_000;
        this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    }

    async credential(signal?: AbortSignal): Promise<string> {
        if (this.cached && Date.now() < this.cached.expiresAt - this.refreshMarginMs) {
            return this.cached.token;
        }
        // The shared fetch isn't tied to one caller's signal, so one caller aborting doesn't fail the others.
        this.pending ??= this.fetchToken().finally(() => { this.pending = undefined; });
        return signal ? abortable(this.pending, signal) : this.pending;
    }

    /** A token the node refused may have been cut short (a revoked client, or clock skew), so the next request fetches a new one. */
    refused(credential: string): boolean {
        // Another request may have refreshed it already.
        if (this.cached?.token === credential) this.cached = undefined;
        return true;
    }

    private async fetchToken(): Promise<string> {
        const response = await this.fetch(this.tokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.options.clientId,
                client_secret: this.options.clientSecret,
            }).toString(),
        });
        if (!response.ok) throw await errorFrom(response);
        const body = await response.json() as { access_token?: unknown, expires_in?: unknown };
        if (typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') {
            throw new StellariumError(response.status, 'Invalid token response', 'The operator answered without an access_token and expires_in', undefined, body);
        }
        this.cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
        return body.access_token;
    }
}

/** A fixed API key, or a run token from wherever the caller gets one. */
export class StaticCredential implements CredentialSource {
    constructor(private readonly source: string | ((signal?: AbortSignal) => string | Promise<string>)) {}

    async credential(signal?: AbortSignal): Promise<string> {
        return typeof this.source === 'string' ? this.source : this.source(signal);
    }

    /** A function may hand out a new token, so it's worth asking again. A fixed string won't change. */
    refused(): boolean {
        return typeof this.source === 'function';
    }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
            (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
        );
    });
}
