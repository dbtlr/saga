# SGA-132 Phase 1 Dogfood Acceptance

Date: 2026-06-22
Branch: `sga-132-phase1-dogfood`
Base: `5388abc`

This run used synthetic redacted transcript fixtures in a temp project and an isolated local
Postgres database. Local absolute paths, host labels, and database credentials are omitted or
redacted.

## Environment

- Local dev Postgres was already running on port `55433` in `saga-postgres-1`.
- `pnpm deps:up` failed because port `55433` was already allocated; the existing healthy local
  Postgres container was reused.
- Host `psql` was unavailable, so database probes used `docker exec saga-postgres-1 psql ...`.
- The documented `pnpm --filter @saga/cli exec saga --help` path failed with `Command "saga" not
found`; the equivalent repo entrypoint used for validation was:
  `apps/cli/node_modules/.bin/tsx apps/cli/src/main.ts`.
  After `SGA-142`, the replayable local command is `pnpm --filter @saga/cli saga --help`.

## Commands And Results

Pass:

- `pnpm install`
- `DATABASE_URL=[redacted-dev-postgres-url] apps/service/node_modules/.bin/tsx apps/service/src/migrate.ts`
  - Fresh dogfood DB reported `Saga database migrations current: 7/7 applied`.
- `saga init "SGA 132 Dogfood Fixed"` through the repo `tsx` entrypoint.
- `saga sessions import ... --harness codex ... --locator fixture://sga-132/codex-fixture.jsonl`
- `saga sessions import ... --harness claude ... --locator fixture://sga-132/claude-fixture.jsonl`
- `saga sessions import ... --harness codex --host-id sga132-other-host ...`
- `saga sessions recent --limit 10`
- `saga sessions show <codex-session> --raw-records 2 --turns 10 --segments 10`
- `saga sessions show <claude-session> --raw-records 2 --turns 10 --segments 10`
- `saga recall search SGA132_CODEX_SENTINEL --no-embeddings`
- `saga recall show <codex-segment> --window 1`
- `saga recall search SGA132_CLAUDE_SENTINEL --no-embeddings`
- `saga recall show <claude-segment> --window 1`
- `saga recall search SGA132_SECOND_HOST_RECALL --no-embeddings`
- Embedding index API probe with `indexSessionSegmentEmbeddings(...)`
- `saga doctor`
- `saga harness status`
- `SAGA_TEST_DATABASE_URL=[redacted-dev-postgres-url] pnpm exec vp test run packages/db/src/raw-session-import.postgres.test.ts -t "keeps same-handle host users distinct"`

Expected skip:

- Vector indexing and vector recall: skipped because `OPENAI_API_KEY` was not present in the
  process environment, and Codex auth contained login/account tokens but no cached
  `OPENAI_API_KEY`.

Known command failure:

- `pnpm --filter @saga/cli exec saga --help`: failed with `Command "saga" not found`.
  Follow-up: `SGA-142`. The replayable local command is
  `pnpm --filter @saga/cli saga --help`.

## Evidence

Manual imports:

- Codex fixture import inserted one active Raw Session Record with one Activity Interval, two turns,
  and two segments.
- Claude fixture import inserted one active Raw Session Record with one Activity Interval, two turns,
  and two segments.
- `sessions recent --limit 10` returned all three imported raw records after the second-host probe,
  each with `1 intervals, 2 turns, 2 segments`.

Direct Postgres counts after the fixed run:

| Table                 | Count |
| --------------------- | ----: |
| `sessions`            |     3 |
| `activity_intervals`  |     3 |
| `raw_session_records` |     3 |
| `session_turns`       |     6 |
| `session_segments`    |     6 |

Lexical recall:

- `SGA132_CODEX_SENTINEL` returned the Codex user segment as the top match and `recall show
--window 1` expanded the surrounding assistant turn containing `SGA132_CONTEXT_WINDOW`.
- `SGA132_CLAUDE_SENTINEL` returned the Claude user segment as the top match and `recall show
--window 1` expanded the surrounding assistant turn containing `SGA132_CLAUDE_CONTEXT`.
- Exact sentinel searches also returned lower-ranked fuzzy matches from other `SGA132_*` fixture
  segments because default trigram matching is permissive.

Embedding workflow:

```json
{
  "status": "skipped",
  "eligibleCount": 6,
  "indexedCount": 0,
  "skippedCount": 6,
  "skippedReason": "login-without-api-key",
  "lexicalFallback": "active",
  "provider": {
    "dimensions": 1536,
    "id": "openai",
    "model": "text-embedding-3-small"
  }
}
```

Cross-host recall:

- A second Codex fixture imported with `--host-id sga132-other-host`.
- `recall search SGA132_SECOND_HOST_RECALL --no-embeddings` returned the second-host session and
  source `codex://host/sga132-other-host`.
- Direct Postgres host split after the fix:

| Host subject               | Sessions |
| -------------------------- | -------: |
| `[redacted-local-host-id]` |        2 |
| `sga132-other-host`        |        1 |

## Bug Fixed During Validation

The first cross-host probe exposed that same-handle imports from a second host overwrote/collapsed
host-user attribution. Root cause: `users` was unique on `(workspace_id, identity_source, handle)`,
and raw-session import upserted that row while changing `external_subject`.

Fix:

- Changed the user uniqueness boundary to `(workspace_id, identity_source, handle,
external_subject)`.
- Updated raw-session import upsert conflict target to match.
- Added a Postgres regression test proving same-handle users remain distinct across host subjects.
- Added migration `0006_marvelous_captain_marvel.sql`.

## Ambient Harness Feasibility

- `codex` CLI was installed (`codex-cli 0.116.0`).
- `claude` CLI was installed (`2.1.183 (Claude Code)`).
- In the SGA-132 worktree, `saga harness status` reported both Codex and Claude as missing:
  no workspace binding, no hook files, and no hook coverage.
- Codex real ambient capture was not run because this worktree did not have installed/trusted hooks.
- Claude real ambient capture was not run because this worktree did not have installed hooks, and
  `saga harness status claude` reports activation as `not-applicable`; runtime activation
  verification currently exists only for Codex.

Follow-ups filed:

- `SGA-142` Make the documented local saga CLI invocation replayable.
- `SGA-143` Add Claude ambient activation evidence to harness status.

## Acceptance Matrix

| Criterion                                                                 | Result         | Evidence                                                                                             |
| ------------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| Import one Codex transcript                                               | Pass           | Codex Raw Session Record inserted from `fixture://sga-132/codex-fixture.jsonl`.                      |
| Import one Claude transcript                                              | Pass           | Claude Raw Session Record inserted from `fixture://sga-132/claude-fixture.jsonl`.                    |
| Verify sessions, Activity Intervals, Raw Session Records, turns, segments | Pass           | `sessions recent/show` and direct counts: `3/3/3/6/6` after cross-host probe.                        |
| Search lexically                                                          | Pass           | Codex, Claude, and second-host sentinels returned matching segments.                                 |
| Expand context                                                            | Pass           | `recall show --window 1` returned anchor and surrounding turn for Codex and Claude.                  |
| Enable embeddings when key available                                      | Skipped        | No env `OPENAI_API_KEY`; Codex auth lacks cached key.                                                |
| Verify vector recall when embeddings available                            | Skipped        | Embedding indexing skipped with lexical fallback active.                                             |
| Run real ambient Codex session                                            | Skipped        | Harness missing/untrusted in this worktree.                                                          |
| Run real ambient Claude session                                           | Skipped        | Harness missing; Claude activation verification not implemented.                                     |
| Prove Postgres-backed recall across hosts when available                  | Pass after fix | Second host import recalled; host split is `2` local synthetic sessions and `1` second-host session. |
