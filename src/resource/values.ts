import {
    Decimal,
    parseTypeString,
    type TypeNode,
    type ResourceFunction,
    type ResourceFunctionCallParameter,
} from "requestscript";
import { ProtocolError } from "../payment/validation.js";
function convert(value: unknown, type: TypeNode): unknown {
    if (value === null) return null;
    switch (type.kind) {
        case "string":
            if (typeof value === "string") return value;
            break;
        case "boolean":
            if (typeof value === "boolean") return value;
            break;
        case "int32":
            if (
                typeof value === "number" &&
                Number.isInteger(value) &&
                value >= -2147483648 &&
                value <= 2147483647
            )
                return value;
            break;
        case "int64": {
            if (
                typeof value === "bigint" ||
                (typeof value === "string" &&
                    /^-?(0|[1-9][0-9]*)$/.test(value)) ||
                (typeof value === "number" && Number.isSafeInteger(value))
            ) {
                const n = BigInt(value);
                if (n >= -(2n ** 63n) && n < 2n ** 63n) return n;
            }
            break;
        }
        case "decimal": {
            if (
                value instanceof Decimal ||
                typeof value === "string" ||
                typeof value === "bigint" ||
                (typeof value === "number" && Number.isFinite(value))
            ) {
                try {
                    const decimal =
                        value instanceof Decimal
                            ? value
                            : Decimal.fromString(String(value));
                    if (
                        (type.intDigits === undefined ||
                            decimal.integerDigits() <= type.intDigits) &&
                        (type.fracDigits === undefined ||
                            decimal.fractionDigits() <= type.fracDigits)
                    )
                        return decimal;
                } catch {
                    /* Type failure below. */
                }
            }
            break;
        }
        case "list":
            if (Array.isArray(value))
                return value.map((item) => convert(item, type.element));
            break;
        case "object":
            if (
                typeof value === "object" &&
                !Array.isArray(value) &&
                !(value instanceof Decimal)
            )
                return value;
            break;
    }
    throw new ProtocolError(
        "Resource value does not conform to its declared type",
        422,
    );
}
export function hostToWire(value: unknown): unknown {
    if (value instanceof Decimal) return value.toString();
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return value.map(hostToWire);
    if (value !== null && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, hostToWire(v)]),
        );
    if (value === undefined) return null;
    return value;
}
export function normalizeParameters(
    fn: ResourceFunction,
    parameters: ResourceFunctionCallParameter[],
): ResourceFunctionCallParameter[] {
    if (
        parameters.length !== fn.parameters.length ||
        new Set(parameters.map((p) => p.name)).size !== parameters.length
    )
        throw new ProtocolError("Invalid function parameters");
    return fn.parameters.map((def) => {
        const input = parameters.find((p) => p.name === def.name);
        if (!input) throw new ProtocolError(`Missing parameter: ${def.name}`);
        return {
            name: def.name,
            value: convert(input.value, parseTypeString(def.type)),
        };
    });
}
export function normalizeResult(
    fn: ResourceFunction,
    result: unknown,
): unknown {
    if (fn.returnType === "void") return null;
    return convert(result, parseTypeString(fn.returnType));
}
