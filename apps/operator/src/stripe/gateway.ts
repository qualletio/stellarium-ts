import Stripe from 'stripe';

/** The parts of a Stripe event the operator reads. `account` is set on events from connected accounts. */
export interface StripeEvent {
    id: string;
    type: string;
    account?: string | null;
    data: { object: Record<string, unknown> };
}

/**
 * A Stripe request that failed. `definitive` errors (an invalid request, a refused permission) won't
 * succeed on retry. Others (network, rate limit, Stripe outage) may already have taken effect.
 */
export class StripeRequestError extends Error {
    /** The Stripe SDK's error class name, such as `StripePermissionError`. */
    readonly type?: string;

    constructor(message: string, public readonly definitive: boolean, options?: ErrorOptions & { type?: string }) {
        super(message, options);
        this.type = options?.type;
    }
}

/** The Stripe calls the operator makes, so tests can supply a fake. Requests throw `StripeRequestError`. */
export interface StripeGateway {
    createCustomer(params: { organizationId: string, name: string }): Promise<{ id: string }>;
    /** A one-off card payment of `amountCents` for credit, paid through Stripe Checkout. */
    createCheckoutSession(params: {
        customer: string, amountCents: number, organizationId: string, topUpId: number, successUrl: string, cancelUrl: string,
    }): Promise<{ id: string, url: string }>;
    createPortalSession(params: { customer: string, returnUrl: string }): Promise<{ url: string }>;
    /** A US Express account that can receive transfers. */
    createExpressAccount(params: { organizationId: string }): Promise<{ id: string }>;
    createAccountLink(params: { account: string, refreshUrl: string, returnUrl: string }): Promise<{ url: string }>;
    createLoginLink(account: string): Promise<{ url: string }>;
    /** Retried with the same `idempotencyKey`, it creates at most one transfer. */
    createTransfer(params: { destination: string, amountCents: number, payoutId: number, idempotencyKey: string }): Promise<{ id: string }>;
    /** Verifies a webhook's signature with `secret`. Throws if it doesn't match. */
    constructEvent(payload: Buffer, signature: string, secret: string): StripeEvent;
}

const DEFINITIVE_ERROR_TYPES = new Set(['StripeInvalidRequestError', 'StripePermissionError', 'StripeCardError', 'StripeAuthenticationError']);

/** Runs an SDK call, turning its failure into a `StripeRequestError`. */
async function request<T>(call: () => Promise<T>): Promise<T> {
    try {
        return await call();
    } catch (error) {
        const type = (error as { type?: unknown }).type;
        throw new StripeRequestError((error as Error).message, typeof type === 'string' && DEFINITIVE_ERROR_TYPES.has(type), {
            cause: error, type: typeof type === 'string' ? type : undefined,
        });
    }
}

/** The Stripe SDK behind `StripeGateway`. */
export class StripeSdkGateway implements StripeGateway {
    private readonly stripe: Stripe;

    constructor(secretKey: string) {
        this.stripe = new Stripe(secretKey);
    }

    async createCustomer({ organizationId, name }: { organizationId: string, name: string }) {
        const customer = await request(() => this.stripe.customers.create({ name, metadata: { organizationId } }, { idempotencyKey: `customer_${organizationId}` }));
        return { id: customer.id };
    }

    async createCheckoutSession(params: { customer: string, amountCents: number, organizationId: string, topUpId: number, successUrl: string, cancelUrl: string }) {
        const metadata = { organizationId: params.organizationId, topUpId: String(params.topUpId) };
        const session = await request(() => this.stripe.checkout.sessions.create({
            mode: 'payment',
            customer: params.customer,
            // Payment methods come from the Stripe dashboard's settings. A delayed method (such as ACH)
            // completes the session unpaid, and the top-up is credited on async_payment_succeeded.
            line_items: [{
                quantity: 1,
                price_data: { currency: 'usd', unit_amount: params.amountCents, product_data: { name: 'Stellarium credit' } },
            }],
            metadata,
            payment_intent_data: { metadata },
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
        }, { idempotencyKey: `top_up_${params.topUpId}` }));
        if (!session.url) throw new Error('Stripe returned a Checkout Session without a URL');
        return { id: session.id, url: session.url };
    }

    async createPortalSession({ customer, returnUrl }: { customer: string, returnUrl: string }) {
        const session = await request(() => this.stripe.billingPortal.sessions.create({ customer, return_url: returnUrl }));
        return { url: session.url };
    }

    async createExpressAccount({ organizationId }: { organizationId: string }) {
        const account = await request(() => this.stripe.accounts.create({
            type: 'express',
            country: 'US',
            capabilities: { transfers: { requested: true } },
            metadata: { organizationId },
        }, { idempotencyKey: `account_${organizationId}` }));
        return { id: account.id };
    }

    async createAccountLink({ account, refreshUrl, returnUrl }: { account: string, refreshUrl: string, returnUrl: string }) {
        const link = await request(() => this.stripe.accountLinks.create({ account, type: 'account_onboarding', refresh_url: refreshUrl, return_url: returnUrl }));
        return { url: link.url };
    }

    async createLoginLink(account: string) {
        const link = await request(() => this.stripe.accounts.createLoginLink(account));
        return { url: link.url };
    }

    async createTransfer({ destination, amountCents, payoutId, idempotencyKey }: { destination: string, amountCents: number, payoutId: number, idempotencyKey: string }) {
        const transfer = await request(() => this.stripe.transfers.create({
            amount: amountCents, currency: 'usd', destination, metadata: { payoutId: String(payoutId) },
        }, { idempotencyKey }));
        return { id: transfer.id };
    }

    constructEvent(payload: Buffer, signature: string, secret: string): StripeEvent {
        return this.stripe.webhooks.constructEvent(payload, signature, secret) as unknown as StripeEvent;
    }
}
