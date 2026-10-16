export interface PaymentSubmission {
    voucher: {
        requestId: string; 
        invocationId: string; 
        amount: number;
        recipientAddress: string; 
        signature: string; 
        expiresAt: string; 
        invocationHash: string;
        publicKey: string;
    }
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
            console.error(`Failed to settle payment: ${response.statusText} body: ${await response.text()}`);
        }
    }
}
