#!/bin/sh
set -eu

export ESCROW_PROGRAM_ID="${ESCROW_PROGRAM_ID:-11111111111111111111111111111111}"
export OPERATOR_API_TOKEN="${OPERATOR_API_TOKEN:-local-dev-token}"
export SOLANA_RPC_URL="${SOLANA_RPC_URL:-http://host.docker.internal:8899}"
export DATABASE_URL="${DATABASE_URL:-postgresql://stellarium:local-only-password@postgres:5432/stellarium}"

if [ -z "${PRIVATE_KEY:-}" ]; then
  PRIVATE_KEY="$(node --input-type=module -e '
    import { Keypair } from "@solana/web3.js";
    process.stdout.write(JSON.stringify(Array.from(Keypair.generate().secretKey)));
  ')"
  export PRIVATE_KEY
  echo "Generated a local operator keypair"
fi

exec node dist/server.js
