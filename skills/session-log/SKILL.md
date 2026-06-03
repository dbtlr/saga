---
name: session-log
description: Write the merged Session Log that memorializes a Session — what happened, decisions, deviations, and Consolidation Candidates. Trigger at a work boundary: a task/feature/investigation finished, a wrap-up signal, context nearing compaction, or an explicit request. Primary agent only.
---

# Saga: session-log

Memorialize the current **Session** as one frozen record, centered on **Consolidation Candidates**. This merges what a dev-log and a partner-log captured separately today (ADR 0004).

> **Primary agent only.** Subagents never write Session Logs.

## When to trigger

At a work boundary — don't wait to be asked:
- a task / feature / fix / investigation finished
- the user signals wrap-up ("that's all", "good session", "done for now")
- context is approaching compaction (write *before* the threshold, not after)
- a repo switch, or an explicit request ("write a session log")

## Where it goes

Resolve the vault root from the Project Binding + Vault Registry (or reuse what `session-start` loaded). Write to:
```
<vault_root>/<artifacts_dir>/session-logs/<YYYY-MM-DD-HHMM>-<slug>.md
```
Never write a Session Log inside the workspace (ADR 0009). Use an accurate timestamp (`date "+%Y-%m-%d %H:%M %Z"`) — never invent one.

## What to write

Start from `templates/session-log.md` (under `${CLAUDE_PLUGIN_ROOT}`). Fill every section; more detail is better than less — write for a future session with zero memory of today.

The heart is **Consolidation Candidates** — *"what happened that, had I known it earlier, would have saved time?"* Tag each by the taxonomy in `resources/consolidation-candidates.md`:
- **Durable knowledge** — decisions, user-personas, user-stories
- **Future opportunities** — tech-debt, follow-up-tasks, open-questions
- **User observations** — collaboration-patterns

## After writing

- Update the Workspace Brief's session-state sections (Current State, What's Next, Open Questions, Learnings, Recent Sessions) — **below the rule only**; never touch the durable manifest above it.
- The Session Log is frozen; durable truth is lifted out of it later by **consolidate**.
