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

## Agent Artifact (`type: agent-artifact`) — generated specs/plans

Lives in `artifacts/generated/`. Drifts out of date by design; never a source of truth.

```yaml
---
title: <concise name>
description: <what this artifact captures>
type: agent-artifact
kind: spec | plan
created: YYYY-MM-DD
modified: YYYY-MM-DD
workspace: <workspace-slug>
---
```

## Session Log (`type: session-log`)

Lives in `artifacts/session-logs/`. Frozen record of a Session.

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
- `kind` differentiates notes and Agent Artifacts; Session Logs set `kind: null`.
- Link between vault notes with relative markdown links by default (`[[wikilinks]]` also resolve); link style is a per-vault config (`link_style`).
