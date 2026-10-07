import { generateKeyPairSync } from "node:crypto";
import { signData, verifyData } from "./utils.js";
import { describe, expect, test } from "vitest";

export interface Base64KeyPair {
  publicKey: string;  // SPKI DER, Base64URL
  privateKey: string; // PKCS#8 DER, Base64URL — keep secret
}

export function generateBase64KeyPair(): Base64KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: {
      type: "spki",
      format: "der",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "der",
    },
  });

  return {
    publicKey: publicKey.toString("base64url"),
    privateKey: privateKey.toString("base64url"),
  };
}

describe('crypto', () => {
    describe('signData and verifyData', () => {
        test('should sign and verify data', () => {
            const data = {
                message: 'Hello, world!',
            };
            const { privateKey, publicKey } = generateBase64KeyPair();
            const signature = signData(data, privateKey);
            expect(verifyData(data, publicKey, signature)).toBe(true);
        });
    });
});
