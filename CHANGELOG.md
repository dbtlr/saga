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
