import { Resource, ResourceFunctionCallParameter, ResourceInvoker } from "requestscript";
import { signData } from "../crypto/utils.js";
import { ResourceRepository } from "./repository.js";

export interface PaymentVoucher {
    requestId: string;
    invocationId: string;
    amount: number;
    recipientAddress: string;
    signature: string;
    expiresAt: string;
    publicKey: string;
}

/**
 * The object `createPaymentVoucher` signs. `signature` is excluded, and
 * `resourcePath`, `resourceName`, and `parameters` come from the invocation,
 * not from the voucher itself. Key order is part of the signed bytes.
 */
export function paymentVoucherPayload(
    voucher: Omit<PaymentVoucher, "signature">,
    resourcePath: string,
    resourceName: string,
    parameters: ResourceFunctionCallParameter[],
) {
    const { requestId, invocationId, amount, recipientAddress, expiresAt, publicKey } = voucher;
    return { requestId, invocationId, amount, recipientAddress, expiresAt, resourcePath, resourceName, parameters, publicKey };
}

export class CombinationResourceInvoker implements ResourceInvoker {

    constructor(private readonly resourceRepository: ResourceRepository, private readonly costLimitLamports: number, private readonly publicKey: string, private readonly privateKey: string) {}
    /**
     * Invoke a function on a resource.
     * If the resource has a baseUrl, it will be invoked as a remote function.
     * If the resource has a paymentManifest, it will create a payment voucher and pass it to the resource.
     * Otherwise, it will be invoked as a local function.
     * 
     * @param resource - The resource to invoke
     * @param functionName - The name of the function to invoke
     * @param parameters - The parameters to pass to the function
     * @returns The return value of the function
     */
    async invoke(resource: Resource, functionName: string, parameters: ResourceFunctionCallParameter[]): Promise<{ value: any, error: { message: string } | null}> {
        if (resource.metadata.baseUrl) {
            let requestBody: Record<string, any> = {
                resourcePath: resource.path,
                resourceName: resource.name,
                functionName,
                parameters,
            };
            const url = resource.metadata.baseUrl as string | undefined;
            if (!url) {
                throw new Error(`Resource ${resource.name} does not have a url`);
            }

            const resourceFunction = await this.resourceRepository.getResourceFunction(resource.path, resource.name, functionName);
            if (!resourceFunction) {
                throw new Error(`Function ${functionName} not found in resource ${resource.name}`);
            }

            let paymentVoucher: PaymentVoucher | undefined;
            if (resourceFunction.paymentManifest) {
                console.log(`Resource function ${resource.name}.${functionName} has a payment manifest, creating payment voucher...`);
                if (resourceFunction.paymentManifest.costLamports > this.costLimitLamports) {
                    throw new Error(`Function ${functionName} cost ${resourceFunction.paymentManifest.costLamports} lamports, which exceeds the cost limit of ${this.costLimitLamports} lamports`);
                }
                paymentVoucher = this.createPaymentVoucher(resourceFunction.paymentManifest.recipientAddress, resourceFunction.paymentManifest.costLamports, resource.path, resource.name, parameters);
                requestBody.paymentVoucher = paymentVoucher;
            }

            const result = await fetch(`${url}/v1/run/resource`, {
                method: 'POST',
                body: JSON.stringify(requestBody),
                headers: {
                    'Content-Type': 'application/json',
                },
            });

            if (!result.ok) {
                return { value: null, error: { message: `Failed to invoke ${resource.name}.${functionName}: ${result.statusText}` } };
            }

            const data = await result.json() as { value: any, error: { message: string } | null };
            return { value: data.value, error: data.error };
        } else {
            const fn = resource.functions.find(f => f.name === functionName);
            if (!fn) {
                return { value: null, error: { message: `Function ${functionName} not found in resource ${resource.name}` } };
            }

            const result = await fn.exec(parameters);
            return { value: result, error: null };
        }
    }

    createPaymentVoucher(recipientAddress: string, amount: number, resourcePath: string, resourceName: string, parameters: ResourceFunctionCallParameter[]): PaymentVoucher {
        const requestId = crypto.randomUUID();
        const invocationId = crypto.randomUUID();
        // Expire in 2 minutes
        const expiresAt = new Date(Date.now() + 1000 * 60 * 2).toISOString();
        const signature = signData(paymentVoucherPayload({ requestId, invocationId, amount, recipientAddress, expiresAt, publicKey: this.publicKey }, resourcePath, resourceName, parameters), this.privateKey);
        return { requestId, invocationId, amount, recipientAddress, signature, expiresAt, publicKey: this.publicKey };
    }
}
