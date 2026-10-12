#!/bin/sh
set -eu

if [ -z "${SIGNING_PUBLIC_KEY:-}" ] || [ -z "${SIGNING_PRIVATE_KEY:-}" ]; then
  keys="$(node --input-type=module -e '
    import { generateKeyPairSync } from "node:crypto";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
    process.stdout.write(`${pub}\n${priv}`);
  ')"
  SIGNING_PUBLIC_KEY="$(printf '%s\n' "$keys" | sed -n '1p')"
  SIGNING_PRIVATE_KEY="$(printf '%s\n' "$keys" | sed -n '2p')"
  export SIGNING_PUBLIC_KEY SIGNING_PRIVATE_KEY
  echo "Generated local Ed25519 signing keys"
fi

exec node --experimental-strip-types server.ts
