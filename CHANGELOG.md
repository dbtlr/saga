# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it ships v1.0. Saga is **pre-release** (`0.x`) and will be for a while;
minor releases may include breaking changes. A migration that renames or drops
schema an older binary reads is called out as a **breaking** entry (ADR-0045).

## [Unreleased]

Entries here have landed on `main` but have not yet been cut into a tagged
release. When a release is cut, this section is promoted to
`## vX.Y.Z - YYYY-MM-DD` and a fresh `## [Unreleased]` header is added above it.

### Added

- **`@saga/client-cli` client command surface over `@saga/api-client`** (SGA-239,
  ADR-0047/0048). The standalone `saga-client` binary now performs every
  client-role command through the service HTTP API instead of the local database,
  with `@saga/client-cli` as the single source of truth for client command
  behaviour and help — a preparatory step before `@saga/cli` swaps onto it
  (SGA-249). `@saga/client-cli` never depends on `@saga/db` (the
  `check-client-boundary` guard and an oxlint rule enforce it structurally).
  - **Reads** — `recall search` / `recall show` (over `POST /v1/recall` and `GET
    /v1/sessions/:id/context`) and `sessions recent` / `sessions show` (over `GET
    /v1/sessions[/:id]`), rendering byte-identical `records`/`json` output to the
    db-backed `@saga/cli` commands (proven by Postgres parity tests). Recall is
    lexical-only for now — the query-embedding egress arrives with SGA-253; vector
    flags are accepted-and-ignored so help text is preserved.
  - **Ingest** — `ingest claude-hook` / `ingest codex-hook` read the hook payload
    from stdin, build a `RawEventEnvelope` (via `@saga/collectors`) plus — when a
    transcript is present — a `@saga/contracts` `IngestSnapshot` computed
    client-side (minus the `capturedAt` and settlement-trigger the service derives
    server-side), and POST them to `/v1/ingest`; a transcript-less lifecycle event
    is POSTed with no snapshot and settled server-side. The harness hook JSON
    contract is unchanged (`{ continue: true }`, and `{ continue: true,
    systemMessage: … }` on a capture failure). Per ADR-0047 the capture output
    reflects the service's `stored`/`duplicate`/`error` ack (STORED, not derived —
    the extraction job derives asynchronously). `ingest recent` lists raw events
    over `GET /v1/events`. A Postgres parity test proves a Claude and a Codex hook
    captured through the client, once derived, produce the same turns/segments the
    synchronous `@saga/cli` `captureHook` produces for the same input.
  - **Doctor** — a client-role `doctor` reframed around service reachability: it
    reports node/bun/workspace-binding health plus a `service` check over
    `GET /v1/info` (mapping `migrations {applied,expected,compatible}` to
    ok/behind/incompatible) and filesystem harness state. The db-only
    Postgres/activation-evidence/embedding/launchd checks are dropped as host and
    service concerns.
  - A thin `saga-client` bin drives every command; a Postgres-backed end-to-end
    test exercises the real binary as a subprocess against a live service.
- **Service write path: `POST /v1/ingest` + asynchronous extraction job**
  (SGA-238, ADR-0030/0039). The service now accepts writes through a dumb raw
  store: `POST /v1/ingest` takes a batch of items, each a `RawEventEnvelope` plus
  an optional session snapshot. Each item is fully validated (envelope AND
  snapshot) BEFORE any write, so a malformed snapshot never half-stores a raw
  event; the raw event is stored (idempotent on its 4-column key) and — when a
  snapshot is present — the `raw_session_records` row (idempotent on
  `(sessionId, contentHash)`). A caller-supplied `trustLevel` is NOT honored: every
  ingested event is clamped to `raw` (this unauthenticated capture surface has no
  basis to assert `trusted`). The response is a per-item ack (`stored` /
  `duplicate` / `error`) carrying only ids — never session content — with the
  item's positional `index` and, on a post-insert failure, the persisted
  `rawEventId`. The batch is non-transactional (one bad item fails alone) and
  capped at 1000 items. A snapshot-less item is a lifecycle event: mirroring the
  CLI, it is stored and enqueued for settlement (regardless of event type) in one
  transaction. Storing does NOT derive; a new `extraction` background
  job (registered alongside `heartbeat`) turns stored work into sessions/turns/
  segments and settled intervals asynchronously. Processed-ness is a WRITTEN FACT,
  never inferred from a side-effect: a raw snapshot's `status` is the derivation
  queue (`captured` → `derived` for the ACTIVE record, or `failed` after an attempt
  cap dead-letters a poison item), and lifecycle events are enqueued into a
  `lifecycle_settlement_queue` drained to a terminal `settled`/`failed` (each
  settled exactly once, so a reference-less outcome never re-matches). Both queues
  are idempotent, bounded per tick, index-served, and can never livelock; migration
  0012 backfills them so a first deploy neither re-derives history nor strands
  in-flight boundaries. The
  backlog (pending/failed per queue) is surfaced on `GET /v1/info`. In `@saga/db`,
  `importRawSessionRecord` is split into a reusable `storeRawSessionRecord` (store
  only) and `deriveStoredSessionRecord` (derive from the stored snapshot), with
  settlement invocable from a stored raw event via
  `settleStoredLifecycleBoundaryEvent`; `importRawSessionRecord` keeps its prior
  behavior and additionally records its inline derive as `status='derived'`. The
  ingest wire types live once in `@saga/contracts`, shared by the service and
  `@saga/api-client`'s typed `ingest()` method. `@saga/cli` is untouched — the
  CLI's synchronous capture path stays live until a later swap.
- **Service API twin: Hono layer, `/v1` read endpoints + `@saga/api-client`**
  (SGA-238, ADR-0046/0051). The service now serves an HTTP API through Hono (the
  bare `node:http` request handler is replaced; `GET /health` keeps its exact
  byte-compatible response for launchd). The service refuses to start on a
  non-loopback `SAGA_SERVICE_HOST` (only `127.0.0.1`, `::1`, `localhost`) until
  service auth exists (ADR-0051); a containerized deployment, where the port
  publish is the exposure boundary, asserts that explicitly with
  `SAGA_SERVICE_UNSAFE_ALLOW_NONLOOPBACK=1` (dies at the auth phase). The
  service Dockerfile's workspace-manifest COPY list is now guarded by a unit
  test after `packages/client-cli` fell out of it. New read endpoints under `/v1`, thin handlers
  over the existing `@saga/db` read functions with a consistent
  `{ error: { code, message } }` shape and query/body workspace scoping: `GET
  /v1/info`, `POST /v1/recall`, `GET /v1/sessions`, `GET /v1/sessions/:id`, `GET
  /v1/sessions/:id/context` (`:id` is the anchor segment id), and `GET /v1/events`.
  A new client-tier package `@saga/api-client` exposes a typed `SagaApiClient`
  (one method per endpoint, `Authorization: Bearer` when a token is configured)
  with its own wire request/response types and never depends on `@saga/db`; the
  `check-client-boundary` guard and the vite import-boundary rule now cover it too.
  `@saga/cli` is untouched — the CLI and the service twin are duplicate read
  surfaces for now. Every `/v1` read handler now runs its result through the same
  agent-facing redaction pass the CLI and MCP apply, scrubbing local-path scalars
  before they cross the wire. The HTTP surface is hardened further: a pre-routing
  Host allowlist rejects non-loopback `Host` headers as a DNS-rebinding guard
  (honoring the same unsafe-bind escape), `POST /v1/recall` enforces a 1 MiB body
  limit, error bodies never leak driver/stack text (a defect returns a static
  500), query/body integers are parsed strictly (rejecting blank, hex, scientific,
  and unsafe-integer forms), the events limit is clamped, and an unknown context
  segment now returns 404 rather than 400. `SagaApiClient` bounds every request
  with a configurable timeout and classifies failures (`network`, `timeout`,
  `invalid_response`) rather than surfacing raw fetch/parse errors. Internally the
  job runner is now built from a post-listen `JobFactory` seam so a later job can
  reach the shared database pool, and a compile-time parity guard pins the wire
  types against the `@saga/db` read shapes. Postgres-backed parity tests assert
  each `/v1` endpoint returns exactly the JSON form of its underlying `@saga/db`
  read function. Vector recall, ingest, the extraction job, registration, and MCP
  re-hosting are later slices.
- **Service-hosted HTTP MCP twin: `POST /mcp`** (SGA-238, ADR-0046/0051). The
  service now speaks the Model Context Protocol over HTTP, running IN PARALLEL
  with the CLI's stdio MCP (a strangler twin; the swap that retires the stdio
  server is a later task). A single JSON-RPC request rides the `POST /mcp` body
  and is answered by the transport-free `@saga/mcp` core wired to the same three
  session tools (`list_recent_sessions`, `search_sessions`, `get_session_context`)
  over the same `@saga/db` read ops the `/v1` endpoints use. It sits behind the
  same loopback Host guard and body limit as `/v1`; bearer verification is
  deferred to the auth phase, so a client-sent `Authorization` header is ignored
  for now. The workspace is scoped via a `workspaceId` query parameter (optional
  for `initialize`/`tools/list`, which never touch the database; a `tools/call`
  without it is a JSON-RPC error). The `workspaceId` is UUID-validated at the
  boundary so a malformed value can never reach the pg `uuid` cast. A notification
  (no id) is acknowledged with `202` and an empty body; an unparseable / non-JSON-RPC
  body is answered with a JSON-RPC error envelope (`-32700` / `-32600`). Tool
  handlers run through a defect-hardened runner (mirroring the `/v1` routes): a
  defect or a wrapped-driver db failure is logged server-side and surfaced as a
  clean, static `-32000` — no stack or raw pg text ever crosses the wire. Recall is
  LEXICAL-ONLY here — vector query egress is a later slice, so the search posture is
  a fixed lexical stance. The MCP presentation (bookkeeping-blob compaction,
  agent-facing redaction, and the markdown renderers) is duplicated into the service
  so it does not depend on `@saga/cli`; a Postgres-backed parity test drives `POST
  /mcp` and the CLI's stdio server against the same seeded data and asserts
  byte-identical tool lists, structured content, and markdown (modulo the per-call
  recall `searchedAt` and the environment-resolved posture), including the
  unknown-tool error path, and independently asserts the service structured output
  scrubs a seeded local path and drops the unsafe `config`/`sourceLocator` keys.
  `@saga/cli` is untouched — the two MCP surfaces run side by side until the swap.
- **`@saga/client-cli` package + client-tier boundary guard** (SGA-237,
  ADR-0048/0050). Structural groundwork for the client/service split, no behavior
  change. A new leaf package `@saga/client-cli` (depends only on `@saga/runtime`)
  now owns the `.saga.local.json` binding read path (`readBindingFile`,
  `bindingPathFor`, `WorkspaceBindingFile`), re-exported from `@saga/cli`'s
  `init.ts` so callers are unaffected. It also adds the client-side view of
  `~/.saga/config.json` (`service.url`, `auth_token`, `hostname`, `spool.dir`, and
  a `workspaces` checkout-path map) with a tolerant read-only loader that leaves
  the runtime's `{database:{url}}` reader untouched, plus a binding resolver that
  prefers the `workspaces` map and falls back to `.saga.local.json`. A CI-checked
  `check-client-boundary` guard (wired into `verify`) fails if `@saga/client-cli`
  ever reaches `@saga/db` by dependency closure or source import.
- **Release + install pipeline** (SGA-180, ADR-0044). Saga now ships as a single
  Bun-compiled binary carrying the `cli`, `service`, and `mcp` surfaces (the
  control plane is excluded from the artifact). A tag-driven `release.yml` builds
  one binary per platform on its native runner (`darwin-arm64`, `linux-x64`,
  `linux-arm64`; Intel macOS installs from source), publishes `SHA256SUMS` and a
  GitHub Release with notes extracted from this file, and prunes stale
  prereleases. `prerelease.yml` auto-tags a `vX.Y.Z-next.N` on every
  build-affecting push to `main` — the dogfood channel that replaces
  checkout-as-deploy (`saga self-update --next`). `version-guard` and
  `changelog-guard` keep the release/next-cycle and changelog invariants. A
  curl-pipe `install.sh` detects OS/arch, hard-verifies the checksum, and
  installs to the one stable path `~/.local/bin/saga`. The compiled binary
  reports its exact release tag via `saga --version`.
- **`saga self-update`** (SGA-223, ADR-0045). Resolves the latest release
  (`--next` for the prerelease channel, `--tag` to pin), hard-verifies the
  checksum, atomically swaps `~/.local/bin/saga`, runs pending migrations,
  restarts the supervised service, and doctor-verifies — one supervised
  convergence sequence that also recovers a host left binary-ahead-of-DB.
  Refuses to run from source. Migration skew is asymmetric: a database ahead of
  the binary is tolerated, a database behind it refuses and names
  `saga self-update` as the remedy; `saga doctor` reports current / behind /
  ahead. `saga service install` now points launchd at the compiled stable-path
  binary so an update's restart runs the swapped binary.

### Changed

- **Service-side vector recall egress** (SGA-253, ADR-0032). The service now
  resolves a recall query embedding under installation policy and drives the
  pgvector path, so `POST /v1/recall` and the service-hosted HTTP MCP
  `search_sessions` return vector results with a real posture
  (`vector`/`lexical`/`degraded` + reason) when remote embeddings are enabled,
  and lexical otherwise — matching the stdio MCP instead of the previous
  lexical-only stance. The query text never leaves the machine unless policy
  enables remote embeddings. `POST /v1/recall` now carries the resolved posture
  on a `search` field; `@saga/api-client`'s `recall()` returns it. `@saga/client-cli`
  `recall search` stops forcing lexical — `--no-embeddings` forces it,
  `--vector-candidates` bounds the vector set, and the effective mode is reported
  from the service. Closes the gap that would otherwise have regressed every
  embeddings-enabled install from vector to lexical when the client/service swap
  (SGA-249) routes recall through the service.
- **BREAKING: the database environment variable is now `SAGA_DATABASE_URL`**
  (SGA-224, ADR-0044/0038). `DATABASE_URL` / `DATABASE_URL_FILE` are no longer
  read; set `SAGA_DATABASE_URL` / `SAGA_DATABASE_URL_FILE` instead (deploy env
  files, `docker-compose`, `.env`, CI, and any shell that exported it). The
  `SAGA_` namespace stops an ambient `DATABASE_URL` in an operator's shell from
  silently pointing installed Saga at the wrong shared Postgres.
  `SAGA_TEST_DATABASE_URL` is unchanged. The variable keeps env-wins precedence
  in every mode.
- **Installed-binary config precedence** (SGA-224, ADR-0044/0038). A compiled
  binary is a production build: it never reads repo `.env`/`.env.local` and
  resolves its database from `SAGA_DATABASE_URL` then the installation config
  (`~/.saga/config.json`). A from-source run keeps the dev precedence
  (`SAGA_DATABASE_URL` → project env files → installation config). The
  distinction is a build profile baked into the release binary.
- **Integration references converge on the stable install path** (SGA-224). When
  compiled, `saga start`'s service spawn re-execs the installed binary and
  `saga harness install` writes the stable path (`~/.local/bin/saga`) into the
  Claude hook shim and `.mcp.json`; `saga doctor` gains a convergence check that
  flags any integration still pointing at a checkout and names the command that
  fixes it. Removed the unused, config-unaware `db:migrate` script — the
  sanctioned apply paths are `saga self-update` and `@saga/service migrate`.

### Fixed

- **Supervised service starts when installed from a checkout on a non-boot
  volume** (SGA-230). `saga service install` baked the launchd `WorkingDirectory`
  to the directory it ran from; for an install off a checkout on `/Volumes`, the
  launchd agent lacks Full-Disk-Access to the volume, so `chdir` failed and the
  service died silently before any output. The compiled service's
  `WorkingDirectory` now uses the home directory — safe because a production build
  resolves config from `SAGA_DATABASE_URL` / `~/.saga/config.json`, never
  cwd-relative `.env` — while source/dev installs keep the checkout as cwd.
