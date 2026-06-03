# Workspace hygiene

Guidance Session Start teaches the agent so it keeps the vault high-signal and doesn't bloat context.

## The Workspace Brief is small on purpose

- The Brief is **Active Context** — loaded every session. Keep it concise.
- It has two zones split by a horizontal rule:
  - **Above the rule** — durable manifest (overview, tech stack, key paths, conventions, navigation). Human-authored; agents don't rewrite it.
  - **Below the rule** — session-tracked state (current state, what's next, open questions, learnings, recent sessions). Saga maintains this.
- Add to the Brief only what most future sessions need. Everything else is a note linked from the Brief (Relevant Context).
- Prune: when something stops being current, move it out (to a note, or to `archive/` with a why-footnote). Keep "Recent Sessions" to the last few.

## Where to put new files

- Domain term → `glossary.md`. Hard-to-reverse decision → an ADR in `decisions/`. Design doc/research → `notes/`.
- Generated spec/plan → `artifacts/generated/` (never the workspace). Session Log → `artifacts/session-logs/`.
- Don't create files speculatively; prefer extending the Brief or an existing note.

## Closing out a session

- Trigger `session-log` at a work boundary: a task/feature/investigation finished, a wrap-up signal, or context nearing compaction (write *before* the threshold).
- The Session Log surfaces Consolidation Candidates; `consolidate` later lifts them into maintained context.

## Subagents

Only the primary agent loads Session Start, writes Session Logs, or consolidates. Subagents do implementation only.
