export interface PaymentSubmission {
    voucher: {
        requestId: string; 
        invocationId: string; 
        amount: number;
        recipientAddress: string; 
        signature: string; 
        expiresAt: string; 
        publicKey: string;
    }
    // These fields are signed by createPaymentVoucher but absent from its result.
    resourcePath: string;
    resourceName: string;
    parameters: unknown[];
}

export class OperatorClient {
    constructor(private readonly url: string) {}

    async settlePayment(payment: PaymentSubmission): Promise<void> {
        const response = await fetch(`${this.url}/payment`, {
            method: 'POST',
            body: JSON.stringify(payment),
            headers: {
                'Content-Type': 'application/json',
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to settle payment: ${response.statusText}`);
        }
    }
}
