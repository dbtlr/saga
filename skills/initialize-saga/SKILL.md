---
name: initialize-saga
description: Bind this project to a vault Workspace and scaffold or self-heal it. Use when setting up Saga in a repo, when the user says "initialize my workspace" or "/saga:initialize-saga", or when start-session reports no Project Binding (.saga.toml).
argument-hint: "[workspace] [--vault <name>]"
---

# Saga: initialize-saga

Bind a project to its vault **Workspace** and ensure that workspace is scaffolded correctly. Idempotent and self-healing — safe to run repeatedly.

> **Primary agent only.** If you were dispatched as a subagent, stop here.

Shared references (resolve under `${CLAUDE_PLUGIN_ROOT}`; when developing in-repo, the repo root):
- `resources/vault-structure.md` — the layout you create
- `resources/frontmatter.md` — frontmatter for every file you write
- `templates/` — `workspace-brief.md`, `glossary.md`, `decision.md`, `session-log.md`

## 1. Resolve the vault

The **Vault Registry** is `${XDG_CONFIG_HOME:-~/.config}/saga/config.toml`. Choose the vault in order:

1. The `--vault <name>` argument, if given.
2. Else the registry's `default_vault`.
3. Else, if exactly one vault is registered, use it.
4. Else, present the registered vaults as a numbered list **plus an "add another vault" option**, and ask.

If the registry doesn't exist, the user picks "add another vault", or the named vault isn't registered → go to **§2**. When a binding names a vault that isn't registered, treat near-misses (casing, hyphens/underscores/spaces, slight misspellings) as a likely match and **confirm** rather than failing.

## 2. Register a vault (vault-initialize)

Only when the target vault isn't in the registry.

1. Ask for the **vault root** path. Verify it exists; if not, but something close does, ask "did you mean `<path>`?" Otherwise ask again.
2. Add an entry to the registry (create the file if missing):
   ```toml
   default_vault = "<name>"   # set only if this is the first vault

   [vaults.<name>]
   root           = "<verified path>"
   workspaces_dir = "Workspaces"
   shared_dir     = "shared"
   artifacts_dir  = "artifacts"
   link_style     = "relative"
   ```
3. Scaffold the vault skeleton if missing (see `resources/vault-structure.md`):
   - `artifacts/session-logs/`, `artifacts/scratch/` (no `generated/` — specs/plans are transient, deleted on merge)
   - `Workspaces/shared/` with `user.md` (User Profile) and `memory.md` (Shared Memory). Seed them lightly if absent (a short user-profile interview can fill `user.md` later). If a legacy `partner_model.md` exists, offer to copy-and-curate it into `user.md` + `memory.md` rather than migrating in place.

## 3. Resolve the workspace name

- Use the `<workspace>` argument if given; else infer from the repo directory name and **confirm**.
- A Workspace maps 1:1 to a project, bound by name + path.

## 4. Elevator-pitch description

Get a 2–3 sentence description of the project, in priority order:
1. From an existing Workspace Brief (if re-initializing).
2. From the repo's `CLAUDE.md` / `AGENTS.md`.
3. Else scan the repo and infer one.

Confirm it with the user (offer to edit). It becomes the Brief's `description` and opening paragraph.

## 5. Scaffold / heal the workspace

Under `<root>/<workspaces_dir>/<workspace>/`, ensure these exist — **create only what's missing; never overwrite existing content**:
- `<workspace>.md` — Workspace Brief, from `templates/workspace-brief.md` (substitute `{{WORKSPACE}}`, `{{ELEVATOR_PITCH}}`, `{{DATE}}`)
- `glossary.md` — from `templates/glossary.md`
- `decisions/`, `notes/`, `tasks/`, `archive/`

If everything already exists and is consistent, report: *"Your workspace is already initialized to `<full path>` and everything looks correct."* Otherwise apply only the missing pieces and say what you added.

## 6. Write the Project Binding

Write `.saga.toml` at the repo root:
```toml
vault     = "<name>"
workspace = "<workspace>"
```
Ask whether to commit it to git (**default: no** — ensure it's in `.gitignore`).

## 7. Permissions (harness-specific)

Ensure the agent can read/write the vault paths. In Claude Code, add the vault globs to `.claude/settings.local.json`. Re-running `initialize-saga` under a different harness adds that harness's needs.

## 8. Finish

- **Fresh init:** hand off to **start-session** to load the new context.
- **Heal:** just report what changed.
