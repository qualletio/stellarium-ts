import { parseScript } from "requestscript";
import { keccak256, stringToHex, type Hex } from "viem";
/** Sorted JSON with explicit bigint tagging; rejects values that cannot be represented faithfully. */
export function canonicalJson(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "string" || typeof value === "boolean")
        return JSON.stringify(value);
    if (typeof value === "bigint")
        return '{"$int":' + JSON.stringify(value.toString()) + "}";
    if (typeof value === "number") {
        if (
            !Number.isFinite(value) ||
            (Number.isInteger(value) && !Number.isSafeInteger(value))
        )
            throw new Error("Unsafe numeric value");
        return JSON.stringify(Object.is(value, -0) ? 0 : value);
    }
    if (Array.isArray(value))
        return "[" + value.map(canonicalJson).join(",") + "]";
    if (typeof value === "object") {
        if (
            Object.getPrototypeOf(value) !== Object.prototype &&
            Object.getPrototypeOf(value) !== null
        )
            throw new Error("Non-JSON object");
        const object = value as Record<string, unknown>;
        return (
            "{" +
            Object.keys(object)
                .sort()
                .map(
                    (key) =>
                        JSON.stringify(key) + ":" + canonicalJson(object[key]),
                )
                .join(",") +
            "}"
        );
    }
    throw new Error("Unsupported canonical value");
}
export const hashValue = (value: unknown): Hex =>
    keccak256(stringToHex(canonicalJson(value)));
function withoutLocations(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutLocations);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key !== "line")
                .map(([key, item]) => [key, withoutLocations(item)]),
        );
    return value;
}
export function hashRequest(source: string): Hex {
    const script = parseScript(source);
    if (script.declaration.kind !== "request")
        throw new Error("Only request declarations are supported");
    return hashValue(withoutLocations(script));
}
export function canonicalParameters(
    parameters: { name: string; value: unknown }[],
): { name: string; value: unknown }[] {
    const names = new Set<string>();
    for (const p of parameters) {
        if (names.has(p.name)) throw new Error("Duplicate parameter");
        names.add(p.name);
    }
    return [...parameters].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
}
export const hashParameters = (
    parameters: { name: string; value: unknown }[],
): Hex => hashValue(canonicalParameters(parameters));
/** Decimal strings are the transport representation for typed integer fields. */
export const wireJson = (value: unknown): string =>
    JSON.stringify(value, (_, item) =>
        typeof item === "bigint" ? item.toString() : item,
    );
