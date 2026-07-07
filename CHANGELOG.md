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

- **Service write path: `POST /v1/ingest` + asynchronous extraction job**
  (SGA-238, ADR-0030/0039). The service now accepts writes through a dumb raw
  store: `POST /v1/ingest` takes a batch of items, each a `RawEventEnvelope` plus
  an optional session snapshot, stores the raw event (idempotent on its 4-column
  key) and — when a snapshot is present — the `raw_session_records` row (idempotent
  on `(sessionId, contentHash)`), and returns a per-item ack (`stored` /
  `duplicate` / `error`) that carries only ids, never session content. The batch is
  non-transactional: one bad item fails alone while its siblings still succeed.
  Storing does NOT derive; a new `extraction` background job (registered alongside
  `heartbeat`) discovers work by absence — active raw snapshots with no turns yet,
  and stored `Stop`/`SessionStart` lifecycle events no interval references yet — and
  derives sessions/turns/segments and settles activity intervals asynchronously,
  idempotently, and safe under at-least-once. In `@saga/db`, `importRawSessionRecord`
  is split into a reusable `storeRawSessionRecord` (store only) and
  `deriveStoredSessionRecord` (derive from the stored snapshot), with lifecycle
  settlement invocable from a stored raw event via `settleStoredLifecycleBoundaryEvent`;
  `importRawSessionRecord` keeps its exact prior behavior (the synchronous CLI path
  is unchanged). `@saga/api-client` gains a typed `ingest()` method with its own wire
  request/response types. `@saga/cli` is untouched — the CLI's synchronous capture
  path stays live until a later swap.
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
