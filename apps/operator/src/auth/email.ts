import type { FastifyBaseLogger } from 'fastify';

export interface Email {
    to: string;
    subject: string;
    text: string;
}

/** Sends the dashboard's emails: verification, password reset and invitations. Logs failures rather than throwing. */
export interface Mailer {
    send(email: Email): Promise<void>;
}

/** Sends through Resend's HTTP API. `from` must be on a domain verified in Resend. */
export class ResendMailer implements Mailer {
    constructor(private readonly apiKey: string, private readonly from: string, private readonly log: FastifyBaseLogger) {}

    async send(email: Email): Promise<void> {
        try {
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: this.from, ...email }),
            });
            if (!response.ok) {
                this.log.error({ status: response.status, detail: await response.text(), subject: email.subject }, 'Resend refused an email');
            }
        } catch (error) {
            this.log.error({ err: error, subject: email.subject }, 'Failed to send an email');
        }
    }
}

/** For local development: writes each email, links included, to the log instead of sending it. */
export class LogMailer implements Mailer {
    constructor(private readonly log: FastifyBaseLogger) {}

    async send(email: Email): Promise<void> {
        this.log.info(email, 'Email not sent (RESEND_API_KEY is not set)');
    }
}
