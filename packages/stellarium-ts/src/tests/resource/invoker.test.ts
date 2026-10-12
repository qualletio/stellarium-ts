import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vitest";
import { verifyData } from "../../crypto/utils.js";
import { CombinationResourceInvoker, paymentVoucherPayload } from "../../resource/invoker.js";
import type { ResourceRepository } from "../../resource/repository.js";

function generateBase64KeyPair() {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "der" },
        privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    return {
        publicKey: publicKey.toString("base64url"),
        privateKey: privateKey.toString("base64url"),
    };
}

describe("payment voucher", () => {
    test("verifies the signed invocation payload, not the voucher object", () => {
        const { publicKey, privateKey } = generateBase64KeyPair();
        const invoker = new CombinationResourceInvoker({} as ResourceRepository, 100_000, publicKey, privateKey);
        const parameters = [{ name: "city", value: "Oslo" }];
        const voucher = invoker.createPaymentVoucher(
            "4HkmXgXCJ8tw1ih5VFHetRt4kWdo1VLBVmV7B5p6ctK2",
            10000,
            "com.example",
            "Weather",
            parameters,
        );

        expect(verifyData(
            paymentVoucherPayload(voucher, "com.example", "Weather", parameters),
            voucher.publicKey,
            voucher.signature,
        )).toBe(true);
        expect(verifyData(voucher, voucher.publicKey, voucher.signature)).toBe(false);
    });
});
