#!/bin/sh
set -eu

# Local development only: enroll the fixture nodes and give the caller credit, so paid calls work without Stripe.
if [ "${SEED_DEV:-}" = "1" ]; then
  node dist/seed.js
fi

exec node dist/server.js
