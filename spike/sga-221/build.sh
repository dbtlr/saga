#!/usr/bin/env bash
# SGA-221 spike: build the bun-compiled single-binary saga.
#
# Two steps:
#   1. Regenerate packages/db/src/embedded-migrations.ts via
#      scripts/gen-embedded-migrations.mjs — the drizzle migrations inlined as
#      plain TS string literals (dual-runtime-safe static bundle). A compiled
#      binary has no repo tree, so the on-disk packages/db/drizzle/*.sql files
#      are unreachable; database.ts derives hashes from these literals and
#      materializes them to a private temp dir only when migrate() runs.
#   2. bun build --compile the CLI entry (apps/cli/src/main.ts) into ./saga.
#
# Requires bun on PATH (mise: `mise install bun` pins 1.3.14 for this repo family).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
command -v bun >/dev/null || { echo "bun not on PATH (try: mise install bun)"; exit 1; }

echo "[1/2] regenerate packages/db/src/embedded-migrations.ts"
( cd "$REPO" && node scripts/gen-embedded-migrations.mjs )
( cd "$REPO" && bun run format >/dev/null 2>&1 || true )

echo "[2/2] bun build --compile"
( cd "$REPO" && bun build --compile apps/cli/src/main.ts --outfile "$HERE/saga" )
ls -lh "$HERE/saga" | awk '{print "  binary:", $5, $NF}'
