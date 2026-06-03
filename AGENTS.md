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

Skills live in `skills/` — a single real directory, no symlink, no split. Both
harnesses load from there: Claude Code from the plugin root's `skills/`, and
Codex when launched in this directory. The four skills: `session-start`, `init`,
`session-log`, `consolidate`.

## Validating the plugin

Run the `plugin-dev:plugin-validator` agent against the repo root after changing
the manifest, skills, or plugin packaging.
