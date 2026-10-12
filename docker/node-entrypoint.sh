#!/bin/sh
set -eu

exec node --experimental-strip-types server.ts
