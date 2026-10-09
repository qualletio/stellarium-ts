import { describe, expect, it, vi } from "vitest";
import type { Resource } from "requestscript";
import { CombinationResourceInvoker } from "./invoker.js";
const resource = (exec = async () => "ok"): Resource => ({
    path: "example",
    name: "Test",
    metadata: {},
    functions: [
        {
            name: "call",
            parameters: [{ name: "value", type: "string" }],
            returnType: "string",
            exec,
        },
    ],
});
describe("direct Resource invocation", () => {
    it("forwards arguments as JSON data, without generating executable source", async () => {
        const target = resource();
        target.metadata.baseUrl = "https://peer.example";
        const fetcher = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ returnValue: "ok", executions: [] }),
                    { status: 200 },
                ),
        );
        const input = '" ); return malicious() // ${secret}';
        await new CombinationResourceInvoker(
            undefined,
            undefined,
            fetcher as typeof fetch,
        ).invoke(target, "call", [{ name: "value", value: input }]);
        const [url, options] = fetcher.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];
        expect(url).toBe("https://peer.example/v1/run");
        expect(JSON.parse(options.body as string)).toMatchObject({
            kind: "invocation",
            parameters: [{ name: "value", value: input }],
        });
        expect(JSON.parse(options.body as string)).not.toHaveProperty("source");
    });
    it("rejects nested calls across asynchronous function execution", async () => {
        const invoker = new CombinationResourceInvoker();
        const target = resource(async () => {
            await Promise.resolve();
            return (await invoker.invoke(resource(), "call", [
                { name: "value", value: "nested" },
            ])) as string;
        });
        await expect(
            invoker.invoke(target, "call", [{ name: "value", value: "root" }]),
        ).rejects.toThrow("Nested Resource");
    });
    it("rejects a nested remote invocation before making an HTTP request", async () => {
        const fetcher = vi.fn();
        const invoker = new CombinationResourceInvoker(
            undefined,
            undefined,
            fetcher as typeof fetch,
        );
        const remote = resource();
        remote.metadata.baseUrl = "https://peer.example";
        const root = resource(
            async () =>
                invoker.invoke(remote, "call", [
                    { name: "value", value: "nested" },
                ]) as Promise<string>,
        );
        await expect(
            invoker.invoke(root, "call", [{ name: "value", value: "root" }]),
        ).rejects.toThrow("Nested Resource");
        expect(fetcher).not.toHaveBeenCalled();
    });
    it("validates output before returning a successful invocation", async () => {
        const target = resource();
        target.functions[0].exec = async () => 17;
        await expect(
            new CombinationResourceInvoker().invoke(target, "call", [
                { name: "value", value: "input" },
            ]),
        ).rejects.toThrow("declared type");
    });
});
