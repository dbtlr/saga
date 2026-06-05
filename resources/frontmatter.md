# Frontmatter rules

Every file Saga writes into the vault carries frontmatter so agents (and Norn) can find, differentiate, and progressively disclose it. Three shapes:

## Note (`type: note`) — maintained workspace knowledge

Lives in a Workspace (`Workspaces/<name>/`) or the Shared Workspace (`Workspaces/shared/`).

```yaml
---
title: <concise name>
description: <one or two sentences: what's inside and why an agent should care>
type: note
kind: workspace | glossary | decision | user-profile | shared-memory
workspace: <workspace-slug>   # "shared" for Shared Workspace globals
created: YYYY-MM-DD
modified: YYYY-MM-DD
---
```

> **Specs/plans get no frontmatter.** They are not knowledge — a spec/plan is a transient review surface in `artifacts/scratch/`, deleted on merge. There is no `type: agent-artifact`. A durable, work-bearing agent-generated doc (a schema, an API contract) is just a **Note** (above), in the workspace `notes/`.

## Session Log (`type: session-log`)

Lives in `artifacts/session-logs/`. Frozen while it lives; consolidation-scoped (prunable once consolidated), not a permanent archive.

```yaml
---
title: <session title>
description: <what the session covered>
type: session-log
kind: null
created: YYYY-MM-DDTHH:mm
modified: YYYY-MM-DDTHH:mm
workspace: <workspace-slug>
---
```

## Rules

- `description` is load-bearing for progressive disclosure — write it for an agent deciding whether to open the file.
- `created`/`modified` are absolute dates (an agent uses them to judge staleness). Use `YYYY-MM-DD`; Session Logs may include the time.
- `kind` differentiates notes; Session Logs set `kind: null`.
- Link between vault notes with relative markdown links by default (`[[wikilinks]]` also resolve); link style is a per-vault config (`link_style`).

## YAML string quoting

Values are YAML, so plain (unquoted) strings break on YAML's special characters. Quote any value when it contains them — most often `description` and `title`:

- **Colon-space** (`foo: bar`) — a plain scalar with `: ` parses as a nested mapping and the value is silently dropped. Quote it: `description: "Norn: knowledge tool"`.
- **Leading special char** — if the value starts with `@ \` [ ] { } # & * ! | > % ? : -` or a quote, quote the whole value.
- **`#` after a space** — starts a comment mid-value; quoting protects it.
- **Line breaks** — a plain scalar can't span lines arbitrarily. Keep it one line, or use a block scalar: `>` (folded) / `|` (literal).

When in doubt, **double-quote** the value (use `\"` and `\n` for embedded quotes/newlines). Single quotes are literal (escape `'` by doubling: `''`). Verify with `python3 -c "import yaml,sys; print(yaml.safe_load(open(sys.argv[1]).read().split('---')[1]))" <file>` if unsure.

These same rules govern a skill's own `SKILL.md` frontmatter (`name`/`description`). Watch the colon-space trap there especially: strict parsers (Codex, the `skills` CLI) silently drop a `foo: bar` description, while Claude Code's lenient loader and `plugin-validator` won't catch it — so quote it or use an em-dash.
