---
name: release-cut
description: Cut an official saga release — the two-commit procedure (promote the changelog + tag, verify, open the next cycle). Use when the user grants a release cut: "cut the release", "cut vX.Y.Z", "release the cycle".
---

# Cutting a release

A **cut** is **two commits with a tag between them**: one promotes the release and
fires the build, one opens the next development cycle. Between them sits a **verify
gate** — an official release is not done until it's verified, not glanced at.

Saga ships as a single Bun-compiled binary (ADR-0044). The published `--version`
is baked **from the tag** (`SAGA_BUILD_VERSION`), not from a file. But the
release/next-cycle invariant is tracked in `apps/cli/package.json`: between
releases it carries `X.Y.Z-next`, and `prerelease.yml` auto-tags a
`vX.Y.Z-next.N` on every build-affecting push to `main` (the dogfood channel,
`saga self-update --next`). The cut turns that `-next` base into `X.Y.Z`, then into
`X.(Y+1).0-next`.

## 1. Pre-cut checks

- On `main`, working tree clean, fetched fresh (`git fetch && git status`).
- `bun run verify` is green.
- `## [Unreleased]` in `CHANGELOG.md` has real bullets. An empty section means
  there is nothing to ship — stop. (`finishing-work` + `changelog-guard` keep this
  honest per-PR; the cut trusts it.)
- Target version = the `-next` base in `apps/cli/package.json`
  (`0.1.0-next` → `0.1.0`).

## 2. Cut commit (PR)

On a branch:

- Bump `apps/cli/package.json` `"version"` from `X.Y.Z-next` to `X.Y.Z`. (The
  binary version comes from the tag; this bump is what keeps `version-guard`
  honest — the cut commit is a clean version whose tag doesn't exist yet, which
  the guard explicitly allows.)
- In `CHANGELOG.md`, rename `## [Unreleased]` to `## vX.Y.Z - YYYY-MM-DD` (today's
  date) and add a fresh empty `## [Unreleased]` above it. `release.yml` extracts
  the GitHub Release notes from the section you just promoted.

Open the PR, let CI pass, merge. Then **immediately** — before any other merge —
tag the cut commit (now `main`'s HEAD) and push:

```bash
git checkout main && git pull
git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin vX.Y.Z
```

Don't let another PR merge between the cut merge and the tag push: the tag must
sit on the cut commit, or a stray change gets baked into the binaries while its
CHANGELOG entry lands under the _new_ `[Unreleased]` instead of the promoted
`## vX.Y.Z` section — binary and notes diverge silently. Push the tag with your
**own credentials, not a bot / `GITHUB_TOKEN`**: GitHub's anti-recursion guard
suppresses the `push: tags` trigger for `GITHUB_TOKEN`-authored pushes, so
`release.yml` silently won't fire (this is why the prerelease tagger uses
`workflow_dispatch`).

The `v*` tag fires `release.yml`: it builds the three platform binaries on their
native runners, checksums them, extracts release notes from the promoted CHANGELOG
section, publishes the GitHub Release (`prerelease: false` for a clean `vX.Y.Z`),
and prunes stale prereleases lag-by-one.

## 3. Verify gate — not a glance

Wait for the release run to finish (`gh run watch`), then confirm **every** item:

```bash
gh release view vX.Y.Z --json isPrerelease,tagName,assets \
  --jq '{prerelease: .isPrerelease, assets: [.assets[].name]}'
```

- `prerelease` is `false`.
- assets are exactly the three binaries — `saga-darwin-arm64`, `saga-linux-x64`,
  `saga-linux-arm64` — plus `SHA256SUMS`. (Intel macOS installs from source; keep
  this list in sync with `release.yml`'s build matrix.)
- Download one binary and confirm its checksum matches `SHA256SUMS`.
- The built/installed binary reports `saga --version` = `X.Y.Z`.
- Prune ran lag-by-one: the just-shipped cycle's `vX.Y.Z-next.*` trail **and the
  previous official's cycle trail** both remain; only cycles older than the
  previous official are gone (`gh release list`). An early cut with no qualifying
  older cycle deletes nothing — that's correct, not a failure.

A failure here is a release problem — fix forward, do not paper over it.

## 4. Open the next cycle (PR, required)

Bump `apps/cli/package.json` `"version"` to `X.(Y+1).0-next` (or a major bump if
that's the call); open the PR; merge. Confirm the prerelease stream resumes
(`vX.(Y+1).0-next.1` publishes) and `version-guard` is green.

This step is required: `version-guard` fails any build-affecting change that lands
while a released clean version has no next cycle open — so skipping it is loud, not
silent. Close it here, as the cut's last move, not as a later follow-up.
