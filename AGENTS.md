# Saga — Agent Guide

Cross-harness guidance for agents working in this repo. `CLAUDE.md` is a symlink
to this file so Claude Code and Codex read the same instructions.

Saga is a workflow-orchestration plugin (the three-tool split: Norn=knowledge,
Mimir=work, Saga=orchestration). See [README.md](README.md) for the full picture.

## Testing

- **No external deps.** Tests use the stdlib `unittest` runner — there is **no
  pytest** in this project (don't reach for `python3 -m pytest`).
- **Run the suite:**

  ```bash
  python3 -m unittest discover -s tests
  ```

- Tests are hermetic: each builds a throwaway vault + registry under a temp dir
  and points `build_primer.py` at it via `XDG_CONFIG_HOME`, so the real
  `~/.config/saga` and vault are never touched.

## Running the primer

```bash
python3 scripts/build_primer.py
```

Resolves Project Binding (`.saga.toml`) → Vault Registry → vault root and prints
the merged Active Context. Prints `SAGA_UNINITIALIZED: …` if the project isn't
bound to a Workspace.

## Editing skills

Skills live in `skills/` — a single real directory, no symlink, no split. The
four: `session-start`, `init`, `session-log`, `consolidate`. They're discovered
by Claude Code (via `.claude-plugin/plugin.json`, auto-discovering the plugin
root's `skills/`), by Codex (via `.codex-plugin/plugin.json` + `marketplace.json`
when installed from GitHub — Codex copies the plugin into its own cache, it does
NOT read skills from the working directory), and by the cross-harness `skills`
CLI (`npx skills add dbtlr/saga`), which symlinks them into `~/.agents/skills/`.

**Skill `SKILL.md` frontmatter must be valid YAML** — descriptions with a
colon-space (`foo: bar`) parse as a nested mapping and get silently dropped by
strict parsers (Codex, the `skills` CLI). Use an em-dash or quote the value.
Claude Code's loader is lenient and won't catch it; neither does
`plugin-validator`. Verify with `python3 -c "import yaml; ..."` if unsure.

## Validating the plugin

Run the `plugin-dev:plugin-validator` agent against the repo root after changing
the manifest, skills, or plugin packaging.
