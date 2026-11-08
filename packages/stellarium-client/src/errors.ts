import type { Usage } from './types.js';

/**
 * A request a node or the operator refused or failed. `status` is the HTTP status, and `error` the reason the
 * server gave: for example 401 for a bad API key or run token, 402 when the paying organization can't cover the
 * run, 422 when the script failed at runtime (`details` says why, and `usage` what it executed and was charged for).
 */
export class StellariumError extends Error {
    override readonly name = 'StellariumError';

    constructor(
        readonly status: number,
        readonly error: string,
        readonly details?: string,
        /** For a script that ran and failed: the tokens it executed. */
        readonly usage?: Usage,
        /** The response body as the server sent it. */
        readonly body?: unknown,
    ) {
        super(details ? `${error}: ${details}` : error);
    }

    /** The script parsed but failed while running. It is still charged for what it executed. */
    get isScriptFailure(): boolean {
        return this.status === 422;
    }
}

/** Reads a failed response into a `StellariumError`. */
export async function errorFrom(response: Response): Promise<StellariumError> {
    const text = await response.text().catch(() => '');
    let body: unknown = text;
    try {
        body = text ? JSON.parse(text) : undefined;
    } catch {
        // Not JSON, so the text is the best description there is.
    }
    if (body && typeof body === 'object') {
        const fields = body as { error?: unknown, error_description?: unknown, details?: unknown, usage?: unknown };
        const error = typeof fields.error === 'string' ? fields.error : response.statusText || `HTTP ${response.status}`;
        // OAuth errors (RFC 6749 §5.2) describe themselves in error_description.
        const details = typeof fields.details === 'string' ? fields.details
            : typeof fields.error_description === 'string' ? fields.error_description
            : undefined;
        const usage = isUsage(fields.usage) ? fields.usage : undefined;
        return new StellariumError(response.status, error, details, usage, body);
    }
    return new StellariumError(response.status, response.statusText || `HTTP ${response.status}`, typeof body === 'string' && body ? body : undefined, undefined, body);
}

function isUsage(value: unknown): value is Usage {
    return !!value && typeof value === 'object' && typeof (value as Usage).tokens === 'number';
}
