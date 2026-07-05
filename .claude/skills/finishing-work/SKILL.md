---
name: finishing-work
description: The ordered gates a change clears before it's done in the saga repo — verify, smoke, CHANGELOG, review, submit. Use when finishing a piece of work here: about to declare a task done, open a PR, or run `mimir submit`.
---

# Finishing work

`done` is the **last** gate, not the first thing you reach for. A change clears
these gates in order; the work isn't finished until every one is green. Saga
tracks work in Mimir (`.mimir.toml`, `SGA-*` ids); this specializes the general
"done only after verification" rule with what verification means _in this repo_.

## The gates

1. **Verify green** — `bun run verify` (`vp check` = format · lint · type, then the
   unit suite) exits 0 with zero warnings. Warnings are errors here; a yellow gate
   is a red gate. For DB-touching work also run `bun run verify:integration`
   (needs `SAGA_TEST_DATABASE_URL`; `bun run deps:up` starts local Postgres).
   Trust build/gate output over stale IDE/LSP diagnostics — the `tsn` typecheck
   config makes the editor flag phantom module/`Record`/`Date` errors that `vp
   check` does not.
2. **Smoke** — run the real artifact against representative data, matched to the
   surface you touched, not just unit tests (integration bugs surface here):
   - MCP surface → `bun run smoke:mcp`
   - install / self-update / stable-path → `bun run smoke:install`
   - installed-binary config precedence → `bun run smoke:compiled-config`
   - supervised service → `bun run smoke:service-compose`
   - Codex capture loop → `bun run smoke:codex-loop`
   - or drive the compiled binary directly (`bun build … --compile`, then exercise
     it). Point smokes at an isolated datastore, never a live workspace DB.
3. **CHANGELOG** — the gate that gets skipped. See below.
4. **Review** — invoke the **`adversarial-review`** skill (mandatory before `gh pr
   create`): the proportionality gate, the deterministic suppression scan,
   `/code-review` at the earned tier, then the resolution loop until every finding
   is fixed / dismissed-with-reason / deferred-to-a-tracked-task. It writes the
   `Adversarial-Review` trailer and the disposition table.
5. **Submit** — `mimir submit <id>` (→ `under_review`) and open the PR. The work is
   now the maintainer's to merge; you do not merge to `main`.
6. **Done** — `mimir done <id>` **only after the change is merged**, never before. Confirm
   the merge on GitHub first; a single post-merge read is unreliable.

## The CHANGELOG gate

A user-facing / behavior-affecting change needs a `CHANGELOG.md` entry under
`## [Unreleased]`, in the right `Added` / `Changed` / `Removed` / `Fixed` heading
([Keep a Changelog]). Add it on the branch, in the same PR — not at the release
cut, or the per-PR record drifts for a whole cycle.

**Completion criterion:** either `[Unreleased]` has gained a bullet for this
change, **or** the PR carries the `skip-changelog` label. One of the two is true
before you submit — there is no third option.

CI enforces exactly this. `changelog-guard` fails any PR that touches a
build-affecting path and adds no `[Unreleased]` bullet and has no label. The
build-affecting set (keep in sync with `prerelease.yml`):

```
apps/cli/  apps/service/  packages/  package.json  bun.lock  .tool-versions
install.sh  .github/workflows/(release|prerelease).yml
```

`apps/control-plane/` is deliberately **out** — it isn't in the shipped binary, so
a control-plane-only change needs no entry. Rewording the prose under
`[Unreleased]` does not satisfy the gate; only a real `- ` / `* ` bullet does.

**The escape hatch** — `skip-changelog` — is for a genuinely behavior-preserving
change (an internal refactor, a test-only or build-meta edit). Once the PR exists
(gate 5), apply it with a one-line reason; it stays visible on the PR at merge:

```bash
gh pr edit --add-label skip-changelog   # then say why in a PR comment
```

If you're reaching for the label because writing the entry is annoying, write the
entry. The hatch is for _no user-facing change_, not for _can't be bothered_.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
