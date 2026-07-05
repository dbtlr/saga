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
