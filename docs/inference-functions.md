# Inference Functions

Inference functions are a special type of Resource Function. The original functions are "Fixed" Functions: they have one output, a flat price, and no special configuration.

Inference functions are different--they denote a function that involves AI inference, and so needs additional parameters to work. This lets Stellarium track input tokens and output tokens, estimate usage, and accept dynamic, per-token pricing.

Resource providers declare several things in addition to the regular fields to make their function an inference function:

- `kind: "inference"` on the function.
- The function must take a `maxTokens: int32` parameter, which the caller uses to say the maximum number of output tokens allowed. (The function may take any number of other parameters as well.)
- The function's `exec` returns `{ value, usage: { inputTokens, outputTokens } }`. Scripts only see `value`.
- Payment manifest changes: a paid inference function declares `inputCostMicroUsdcPerMillionTokens` and `outputCostMicroUsdcPerMillionTokens` instead of `costMicroUsdc`. Either can be zero, for an AI like Jev that has no cost for outputs, for example.
- A paid inference function must declare an estimator, `estimateInputTokens(args) => Promise<number>`. Its body is written by the provider, like the function body, and may do things like call Anthropic's token-counting API.

## Paying for a call

A call's charge is `ceil((inputTokens × inputRate + outputTokens × outputRate) / 1,000,000)` micro-USDC.

To protect both callers and providers from wrong estimates:

1. The caller sends the call to the provider's `POST /v1/run/resource/estimate`. The provider runs its estimator and answers `{ inputTokens, maxAmount }`. `maxAmount` is the charge for the estimated input tokens plus `maxTokens` output tokens.
2. The caller checks that `maxAmount` follows from the advertised rates, and denies the call if it is over the node's `inferenceCostLimitMicroUsdc` (`INFERENCE_COST_LIMIT_MICRO_USDC`, defaulting to the cost limit). This protects it against overpaying.
3. The caller signs an inference voucher (`kind: "inference"`) carrying `maxAmount`, both rates and `maxTokens`, and calls the function.
4. The provider verifies the voucher: its rates must match the manifest and its `maxTokens` must match the call. It runs its estimator again before running inference, and refuses with `402` and `requiredMaxAmount` if the voucher doesn't cover the estimate.
5. The provider sends the voucher and the actual token counts to the operator for settlement. Output tokens are capped at `maxTokens`.
6. The operator verifies the voucher signature, refuses output beyond `maxTokens`, and charges the reported usage at the signed rates, never more than `maxAmount`.

Inference functions are visible to anyone looking at the `/v1/resources` endpoint, like https://stellariumregistry.xyz/: they carry `kind: "inference"` and their per-token payment manifest.
