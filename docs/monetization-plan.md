# Monetization Plan

To build the system from zero Solana experience, follow [the step-by-step implementation guide](implementation-guide.md).

## Target settlement architecture

Stellarium's proposed target is a ZK payment rollup settling directly to Solana, with a centralized Stellarium operator sequencing requests and posting batch data and proofs. There is no validator committee. See [the ZK rollup plan](zk-rollup-plan.md) for funding, reservations, proof obligations, data availability, withdrawals, recovery, and delivery milestones. Provider API correctness remains trusted; Solana verifies proofs of payment accounting, and operator authorization alone cannot release escrow funds.

The interfaces below describe the earlier API sketch and require alignment with the rollup's canonical encodings. Lamport values must use decimal-string JSON transport and checked u64 arithmetic internally, rather than unrestricted JavaScript numbers. The direct per-receipt Solana settlement section below is historical context and is superseded by the rollup plan; it must not be implemented as the new settlement authority.

## Terms

| Term           | Definition                                                        |
| -------------- | ----------------------------------------------------------------- |
| Resource Owner | The controller of a Resource. Defines the Resource on their node. |

## Steps

A resource function may declare a `PaymentManifest` containing the cost of one invocation. If the function has no payment manifest, the caller invokes it directly and skips the payment process: no escrow funding, voucher, reservation, payment receipt, rollup submission, or Solana settlement is required for that call.

This decision is per function, so a provider may expose both paid and free functions. A script containing only free calls needs no payment setup. In a mixed script, only functions with a manifest consume the payment budget and enter rollup accounting. Ordinary API authentication, execution limits, and retry handling still apply to free calls.

The provider checks its own registered function declaration before execution. A caller cannot make a paid function free by omitting metadata or its voucher. If cached discovery says a function is free but the provider now requires payment, reject before execution and return the current manifest; obtain explicit payment authorization before retrying.

```typescript
interface Resource {
  functions: {
    // ...
    paymentManifest?: PaymentManifest;
  }[];
}
```

```typescript
interface PaymentManifest {
  cost: number; // The total cost in Lamports.
  recipientAddress: string; // The owner to pay for the resource function call.
}
```

For paid calls, a caller provides a payment authorization within the RequestScript request to declare the budget and escrow funding. The remaining payment steps apply only to functions declaring a payment manifest.

```typescript
interface RunRequest {
  requestId: string;
  source: string; // the RequestScript code to run.
  paymentVoucher?: {
    budget: number; // the total budget for the request in Lamports.
    escrowAddress: string; // the escrow Solana address that will pay for the request.
    signature: string; // the signature of the entire request data.
    expiry: string; // the expiration date that the cost manifest expires in.
  };
}
```

When the user elects to run a request containing paid functions, they attach a payment authorization to the request.
This voucher sets the total budget for the request (if there are multiple resources to pay) as well as sharing the escrow account, signature, and expiry.
The escrow account is prefunded by the user.

The user will directly call the node that has the resource:

```typescript
interface ResourceFunctionRequest {
  requestId: string; // The requestId from the parent RunRequest.
  invocationId: string; // Idempotency Key for this request.
  resource: string;
  functionName: string;
  parameters: {
    name: string;
    value: string; // String representation of the value. must be parsed using the type field.
    type: string;
  }[];
  // Required for a function with a payment manifest; omitted for a free call.
  paymentVoucher?: {
    escrowAddress: string; // The escrow address to pay from.
    recipientAddress: string;
    amount: number; // Budget is the amount set in the resource owner's PaymentManifest.
    expiresAt: string;
    signature: string; // The signature covers the entire request data.
    hash: string;
  };
}
```

The provider compares the voucher’s amount against its current accepted price. On rejection, return the now-updated paymentManifest. The caller must issue a new voucher to approve it; the provider cannot change an existing signed amount.

If the resource invocation is successful, the provider mints a `PaymentReceipt`:

```typescript
interface PaymentReceipt {
  requestId: string;
  invocationId: string;
  resource: string;
  functionName: string;
  escrowAddress: string;
  recipientAddress: string; // The address signing the receipt.
  amount: bigint;
  expiresAt: string;
  voucherHash: string;
  voucherSignature: string; // The signature of the voucher signed by the client.
  signature: string; // The signature covers the entire receipt data. Signed by the recipientAddress.
}
```

## Solana Programs

### Escrow

The escrow program handles the creation of the escrow account.
It sets the owner of the address to the settlement program.

### Settlement

The settlement program verifies the `PaymentReceipt` and stores the resulting `requestId`, `invocationId`, `receiptHash` in an address.

#### Verification Steps

- Check that the combination of `requestId` and `invocationId` and `receiptHash` do not already exist in an address.
- Check that the amount does not exceed the escrow budget.
- Verifies the voucher signature using the `PaymentReceipt` fields.
- If all verifications pass, transfer the `amount` to the `recipientAddress`.
