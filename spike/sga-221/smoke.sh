#!/usr/bin/env bash
# SGA-221 spike smoke: exercise the bun-compiled saga binary end-to-end against a
# FRESH throwaway database on the test server. Standing dev/prod runtime-divergence
# guard per ADR-0044.
#
# Requires: bun on PATH (compile step), node+worktree deps (fresh-DB + from-source
# migration), the test postgres at TEST_ADMIN_URL. Never touches the live install.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="${SAGA_BIN:-$REPO/spike/sga-221/saga}"
TEST_ADMIN_URL="${SAGA_TEST_ADMIN_URL:-postgres://saga:saga@localhost:55432/postgres}"
PORT="${SAGA_SMOKE_PORT:-47712}"
HOST="127.0.0.1"
DBNAME="saga_spike_$(date +%s)_$$"
DBURL="postgres://saga:saga@localhost:55432/${DBNAME}"
SAGA_HOME_DIR="$(mktemp -d)"
export SAGA_HOME="$SAGA_HOME_DIR"
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; exit 1; }

TSX_CLI="$REPO/apps/cli/node_modules/tsx/dist/cli.mjs"
# `postgres` resolves from packages/db (bun workspace); run as inline ESM with that cwd.
DBADMIN() { (cd "$REPO/packages/db" && node --input-type=module -e "
import postgres from 'postgres';
const sql = postgres('$TEST_ADMIN_URL', { max: 1 });
try {
  if ('$1' === 'create') await sql.unsafe('create database \"$DBNAME\"');
  else await sql.unsafe('drop database if exists \"$DBNAME\" with (force)');
} finally { await sql.end({ timeout: 5 }); }
"); }

cleanup() {
  [ -n "${SVC_PID:-}" ] && kill "$SVC_PID" 2>/dev/null || true
  DBADMIN drop 2>/dev/null || true
  rm -rf "$SAGA_HOME_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "== SGA-221 compiled-binary smoke =="
echo "binary: $BIN"
[ -x "$BIN" ] || fail "binary not found/executable at $BIN (build it first: bun build --compile apps/cli/src/main.ts --outfile $BIN)"

# 0. fresh DB + from-source migration -------------------------------------------------
echo "[0] create fresh DB '$DBNAME' and migrate from source"
DBADMIN create
# From-source migration via drizzle's on-disk migrator (bypasses @saga/db so it is
# runtime-agnostic). Resolves drizzle-orm + postgres from apps/cli's node_modules.
(cd "$REPO/apps/cli" && node --input-type=module -e "
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
const sql = postgres('$DBURL', { max: 1 });
try { await migrate(drizzle(sql), { migrationsFolder: '$REPO/packages/db/drizzle' }); }
finally { await sql.end({ timeout: 5 }); }
") >/tmp/saga-smoke-migrate.log 2>&1 \
  && pass "migrated fresh DB" || { cat /tmp/saga-smoke-migrate.log; fail "migration failed"; }

# 1. aliveness ------------------------------------------------------------------------
echo "[1] aliveness"
V="$("$BIN" --version)"; [ "$V" = "saga 0.0.0" ] && pass "--version => $V" || fail "--version => $V"
"$BIN" --help | grep -q "workspace memory" && pass "--help renders" || fail "--help"

# 2. startup latency: compiled vs tsx wrapper (N=10 medians) --------------------------
echo "[2] startup latency (median of 10)"
median() { printf '%s\n' "$@" | sort -n | awk '{a[NR]=$1}END{print (NR%2)?a[(NR+1)/2]:(a[NR/2]+a[NR/2+1])/2}'; }
cs=(); for i in $(seq 1 10); do cs+=("$({ /usr/bin/time -p "$BIN" --version >/dev/null; } 2>&1 | awk '/^real/{print $2}')"); done
ts=(); for i in $(seq 1 10); do ts+=("$({ /usr/bin/time -p node "$REPO/apps/cli/bin/saga.js" --version >/dev/null; } 2>&1 | awk '/^real/{print $2}')"); done
echo "  compiled median: $(median "${cs[@]}")s   tsx-wrapper median: $(median "${ts[@]}")s"

# 3. service run + /health + shutdown ------------------------------------------------
echo "[3] service run -> /health -> shutdown (port $PORT)"
SAGA_DATABASE_URL="$DBURL" SAGA_SERVICE_HOST="$HOST" SAGA_SERVICE_PORT="$PORT" "$BIN" service run >/tmp/saga-smoke-svc.log 2>&1 &
SVC_PID=$!
HEALTH=""
for i in $(seq 1 40); do
  HEALTH="$(curl -s "http://$HOST:$PORT/health" || true)"
  [ -n "$HEALTH" ] && break
  sleep 0.25
done
echo "  /health => $HEALTH"
echo "$HEALTH" | grep -q '"ok":true' && echo "$HEALTH" | grep -q '"jobs"' && pass "health ok + jobs block" || fail "health payload"
kill "$SVC_PID" 2>/dev/null; wait "$SVC_PID" 2>/dev/null || true; SVC_PID=""
curl -s -m 1 "http://$HOST:$PORT/health" >/dev/null 2>&1 && fail "still listening after shutdown" || pass "clean shutdown"

# 4. MCP stdio handshake --------------------------------------------------------------
echo "[4] MCP stdio initialize + tools/list"
MCP_OUT="$(printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | SAGA_DATABASE_URL="$DBURL" "$BIN" mcp 2>/dev/null)"
echo "$MCP_OUT" | grep -q '"protocolVersion"' && pass "initialize responded" || fail "no initialize response: $MCP_OUT"
for t in list_recent_sessions search_sessions get_session_context; do
  echo "$MCP_OUT" | grep -q "\"$t\"" && pass "tools/list advertises $t" || fail "missing tool $t"
done

echo "== smoke complete =="
