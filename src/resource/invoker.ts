import { AsyncLocalStorage } from "node:async_hooks";
import type {
    Resource,
    ResourceFunctionCallParameter,
    ResourceInvoker,
} from "requestscript";
import type { PaymentRuntime, PaymentSession } from "../payment/runtime.js";
import type {
    RunInvocation,
    RunResult,
    ExecutionRecord,
} from "../protocol/types.js";
import { resourceId } from "../protocol/typed-data.js";
import { proveRunAccess } from "../protocol/access.js";
import { wireJson } from "../protocol/canonical.js";
import {
    claimSchema,
    dispatchAcknowledgementSchema,
} from "../protocol/schema.js";
import {
    validateClaim,
    validateDispatchAcknowledgement,
    ProtocolError,
} from "../payment/validation.js";
import { hostToWire, normalizeParameters, normalizeResult } from "./values.js";
const resourceExecution = new AsyncLocalStorage<boolean>();
export function assertTopLevelInvocation(): void {
    if (resourceExecution.getStore())
        throw new ProtocolError(
            "Nested Resource invocations are not supported",
            403,
        );
}
export class CombinationResourceInvoker implements ResourceInvoker {
    constructor(
        private readonly payment?: PaymentRuntime,
        private readonly session?: PaymentSession,
        private readonly fetcher: typeof fetch = fetch,
    ) {}
    async invoke(
        resource: Resource,
        functionName: string,
        parameters: ResourceFunctionCallParameter[],
    ): Promise<unknown> {
        assertTopLevelInvocation();
        const fn = resource.functions.find((fn) => fn.name === functionName);
        if (!fn)
            throw new ProtocolError(`Unknown function: ${functionName}`, 404);
        const normalized = normalizeParameters(fn, parameters);
        const wireParameters = normalized.map((p) => ({
            name: p.name,
            value: hostToWire(p.value),
        }));
        const grant =
            this.payment && this.session
                ? await this.payment.issueGrant(
                      this.session,
                      resource,
                      functionName,
                      wireParameters,
                  )
                : undefined;
        const body: RunInvocation = {
            version: 1,
            kind: "invocation",
            resourceId: resourceId(`${resource.path}.${resource.name}`),
            resourceKey: `${resource.path}.${resource.name}`,
            functionName,
            parameters: wireParameters,
            payment:
                grant && this.session
                    ? { authorization: this.session.authorization, grant }
                    : undefined,
        };
        const trace = grant
            ? {
                  invocationId: (
                      await import("../protocol/typed-data.js")
                  ).typedHash("InvocationGrant", grant),
                  resourceId: body.resourceId,
                  dispatchedAt: BigInt(
                      Math.floor(Date.now() / 1000),
                  ).toString(),
                  completedAt: undefined as string | undefined,
              }
            : undefined;
        if (trace) this.session?.trace.push(trace);
        const result = await this.dispatch(body, resource, normalized);
        if (trace)
            trace.completedAt = BigInt(
                Math.floor(Date.now() / 1000),
            ).toString();
        if (this.session)
            for (const record of result.executions) {
                this.session.executions.push(record);
                this.session.remainingEstimate -=
                    record.claim.receipt.message.grossPriceUsdc;
            }
        return normalizeResult(fn, result.returnValue);
    }
    async dispatch(
        body: RunInvocation,
        resource: Resource,
        parameters = body.parameters,
    ): Promise<RunResult> {
        assertTopLevelInvocation();
        if (body.resourceId !== resourceId(`${resource.path}.${resource.name}`))
            throw new ProtocolError("Resource identifier mismatch");
        const fn = resource.functions.find(
            (fn) => fn.name === body.functionName,
        );
        if (!fn) throw new ProtocolError("Unknown function", 404);
        if (resource.metadata.baseUrl) {
            let outgoing: import("../protocol/types.js").RunBody = body;
            if (body.payment) {
                const signer = this.payment?.options.executionSigner;
                if (!signer)
                    throw new ProtocolError(
                        "Execution-authority signing key unavailable",
                        503,
                    );
                outgoing = await proveRunAccess(
                    body,
                    signer,
                    this.payment!.chain.domain,
                    String(resource.metadata.baseUrl),
                );
            }
            const response = await this.fetcher(
                `${String(resource.metadata.baseUrl).replace(/\/$/, "")}/v1/run`,
                {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: wireJson(outgoing),
                    signal: AbortSignal.timeout(60_000),
                },
            );
            const data = (await response.json()) as RunResult & {
                error?: string;
            };
            if (!response.ok)
                throw new ProtocolError(
                    data.error ?? "Remote invocation failed",
                    response.status,
                );
            if (!Array.isArray(data.executions))
                throw new ProtocolError("Invalid provider response", 502);
            const executions: ExecutionRecord[] = data.executions.map(
                (record) => ({
                    claim: claimSchema.parse(record.claim),
                    dispatchAcknowledgement: record.dispatchAcknowledgement
                        ? dispatchAcknowledgementSchema.parse(
                              record.dispatchAcknowledgement,
                          )
                        : undefined,
                    evidenceId: record.evidenceId,
                    providerEndpoint: String(resource.metadata.baseUrl),
                    returnValue: record.returnValue,
                }),
            );
            if (body.payment) {
                if (!this.payment || executions.length !== 1)
                    throw new ProtocolError("Missing provider receipt", 502);
                const { hashValue } = await import("../protocol/canonical.js");
                const { typedHash } = await import("../protocol/typed-data.js");
                await validateDispatchAcknowledgement(
                    this.payment.chain,
                    executions[0],
                );
                await validateClaim(
                    this.payment.chain,
                    executions[0].claim,
                    undefined,
                    false,
                );
                if (
                    executions[0].claim.receipt.message.responseHash !==
                        hashValue(data.returnValue) ||
                    typedHash("InvocationGrant", executions[0].claim.grant) !==
                        typedHash("InvocationGrant", body.payment.grant)
                )
                    throw new ProtocolError(
                        "Provider response does not match invocation",
                        502,
                    );
            } else if (executions.length)
                throw new ProtocolError("Unexpected payment receipt", 502);
            return { returnValue: data.returnValue, executions };
        }
        const execute = async () =>
            resourceExecution.run(true, async () =>
                normalizeResult(
                    fn,
                    await fn.exec(normalizeParameters(fn, parameters)),
                ),
            );
        if (this.payment)
            return this.payment.execute(body, resource, execute, this.session);
        if (body.payment || resource.metadata.monetization)
            throw new ProtocolError("Payment support is unavailable", 503);
        return { returnValue: hostToWire(await execute()), executions: [] };
    }
}
