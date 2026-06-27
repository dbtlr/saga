# SGA-152 — Installation policy for remote embedding data flow

Transient design spec. Implements ADR 0032 (remote embeddings follow installation
policy). Delete on merge — durable conclusions live in the code, ADR 0032, and the
Session Log.

## Problem

Today "embeddings are available" is derived purely from credentials: `embeddings.ts`
maps Codex auth → `available | skipped`. ADR 0032 says remote embedding data flow is an
**installation-level organizational policy**, not a function of key presence:
`OPENAI_API_KEY` availability alone must not enable remote embeddings. The policy gate
covers both directions of data flow (corpus indexing and recall query embeddings), and
CLI/MCP/doctor must report whether recall is vector-aware, lexical-only by policy, or
lexical fallback due to missing credentials/provider.

## Scope

**In**

- Policy primitive: installation-scoped config file + resolver.
- Compose policy + auth into a three-state embedding decision.
- Enforce the gate at both embedding-generation points (indexing + recall query).
- Fail-closed default (deny) and graceful handling of unreadable/malformed config.
- doctor reporting of effective mode + policy source.
- An `embeddingPolicy` posture field on CLI/MCP recall output.

**Out → SGA-154** (Align CLI and MCP recall modes)

- Making MCP actually _generate_ query embeddings (vector-aware MCP).
- Per-search `vector / lexical / degraded` mode + fallback-reason records in CLI/MCP.
- Tightening MCP numeric schemas.

This task reports the installation **posture**; SGA-154 reports the **per-search actual
mode**.

**Out — deferred (seam only)**

- Workspace-level opt-out. Resolution is layered so a `workspace` layer slots in later
  with precedence `workspace > installation > default`, without touching call sites.

## Design

### 1. Policy primitive — `packages/runtime/src/embedding-policy.ts`

A resolver alongside `codex-auth.ts`, following its injectable shape
(`homeDir` / `readFile` / `env` options for testing).

- **File:** `~/.saga/config.json`, relocatable via `SAGA_HOME` (mirrors `CODEX_HOME`).
- **Schema:** `{ "embeddings": { "remote": "enabled" | "disabled" } }`. JSON matches
  house style (`.saga.local.json`); no new dependency.
- **Returns** `EmbeddingPolicy { remoteEmbeddings: "enabled" | "disabled"; source:
"installation-config" | "default"; detail: string }`.
- **Default-deny + fail-closed:** missing file, absent/invalid key, or unreadable /
  malformed JSON → `disabled`, `source: "default"`, with a human `detail`. We never send
  data remotely because we could not positively read an enabling policy.

### 2. Compose policy + auth — extend `packages/runtime/src/embeddings.ts`

Add composition that takes **both** policy and auth and yields the product state:

| policy   | credentials | effective mode           | skip reason          |
| -------- | ----------- | ------------------------ | -------------------- |
| disabled | any         | `lexical-only-by-policy` | `disabled-by-policy` |
| enabled  | available   | `vector-aware`           | —                    |
| enabled  | missing     | `lexical-fallback`       | `missing-auth`       |

`inspectEmbeddingWorkflow` gains an optional `policyOptions` param; the boundary type
grows explicit `mode` + `reason` so a disabled-by-policy skip is never conflated with a
missing-credentials skip.

### 3. Enforcement points

- **Indexing** — `@saga/db/session-embeddings.ts` `resolveEmbeddingGenerator`: accept
  `policyOptions`, check policy **before** auth; disabled → skip with `reason:
"disabled-by-policy"` even when a key is present. (`@saga/db` already imports
  `@saga/runtime`.)
- **Recall query** — `apps/cli/src/recall.ts` `resolveQueryEmbedding`: policy disabled →
  return `undefined` before the auth check (no remote query embedding). `@saga/db` recall
  stays policy-agnostic; it simply receives no provider.

### 4. Reporting

- **doctor** (`apps/cli/src/doctor.ts` `checkEmbeddings`): report effective mode + policy
  source. `ok` when `vector-aware`; `warn` for `lexical-fallback` (missing creds) and
  `lexical-only-by-policy` (informational), each with a distinct, actionable detail.
- **CLI / MCP recall output:** add `embeddingPolicy` posture field (`vector-aware |
lexical-only-by-policy | lexical-fallback`). Richer per-search mode → SGA-154.

## Testing

- `embedding-policy.test.ts`: enabled / disabled / missing-file / malformed /
  `SAGA_HOME` override — all via injected `readFile`, no real FS.
- `embeddings.test.ts`: full 3×state composition matrix above.
- `session-embeddings.postgres.test.ts`: policy-disabled-with-valid-auth ⇒ skip
  `disabled-by-policy`.
- `doctor.test.ts` + recall test: three-state strings; disabled ⇒ no query embedding.

## Error handling

Config read/parse failures are **fail-closed** (→ disabled) and surfaced as a doctor
warning — never a crash, never silent remote egress.
