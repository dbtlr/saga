---
name: consolidate
description: Lift Consolidation Candidates out of frozen Session Logs into maintained context — durable knowledge to the workspace, follow-ups to tasks/, user observations to the partner-model log. Run periodically or when Session Logs have accumulated. Primary agent only.
---

# Saga: consolidate

Inspect the record of work and lift durable truth out of it into maintained context. Phase 1 is a shallow stand-in (ADR 0006): it routes candidates directly into the vault; the Norn/Mimir fan-out is deferred.

> **Primary agent only.**

## 1. Find what's new

Track the last run in a small state file:
```
<vault_root>/<artifacts_dir>/.saga-consolidate-state.toml   # last_run = "<ISO ts>"
```
Read it; process Session Logs in `<artifacts_dir>/session-logs/` newer than `last_run` (all of them on first run).

## 2. Route each Consolidation Candidate

Per `resources/consolidation-candidates.md`:

| Bucket | Phase 1 route | Seam |
|--------|---------------|------|
| Durable knowledge | Workspace Brief (below the rule) / a `decisions/` ADR / a `notes/` note | → Norn |
| Future opportunities | a task note (`templates/task.md`) in the workspace `tasks/` dir | → Mimir |
| User observations | append a line to the legacy partner-model log (`partner_model_log.jsonl`), if the vault has one | → own `user.md` regeneration |

- Promote durable knowledge into the right maintained file; **don't duplicate** what's already there.
- For a hard-to-reverse decision, write a real ADR from `templates/decision.md`.
- For a follow-up / tech-debt / open-question, write a task note from `templates/task.md` (`status: backlog`).
- Leave the frozen Session Logs as-is — they remain the archive.

## 3. Record the run

Update the state file's `last_run` to now (accurate timestamp). Briefly report what was promoted and where.

## Notes

Phase 1 routes are deliberately shallow **[seams]**: Norn will later own knowledge writes, Mimir will own follow-up work, and `consolidate` will own `user.md` regeneration (retiring the jsonl shim). Keep the routing in one place so the targets can swap cleanly.
