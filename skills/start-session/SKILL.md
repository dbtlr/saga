---
name: start-session
description: Use at the very start of every session in a Saga workspace, before any other response or action — assembles the Session Primer (User Profile + Shared Memory + Workspace Brief) and routes the work. Invoke it proactively at the start of any session. Primary agent only — subagents never load this.
---

# Saga: start-session

The always-on entry point for a Saga session. Assemble the **Session Primer**, hold it as starting context, then route to the right Saga skill.

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill entirely — implementation only. The controller session owns session start and vault integration. Subagents never route on their own.
</SUBAGENT-STOP>

<EXTREMELY-IMPORTANT>
If you are a primary agent and there is even a **1% chance** this is the start of a session, you ABSOLUTELY MUST run this skill before anything else — before any response, any clarifying question, any code exploration, any file read. This is not negotiable and you cannot rationalize your way out of it.

These thoughts mean STOP — you are rationalizing:

| Thought | Reality |
|---------|---------|
| "This is just a quick question" | Questions open sessions. Build the primer first. |
| "Let me just check the repo/files first" | The primer is the context you'd check *against*. It comes first. |
| "I'll load context after I answer" | There is no after — starting context must be held from the first response. |
| "I'll wait until I'm told to start" | The trigger lives here, in this skill. Nothing else will tell you. Run it. |

Building the Session Primer first is not optional. The one exception is the quiet exit in §1: if the primer reports the project is not a Saga workspace, stop silently and proceed normally — do not pitch initialization.
</EXTREMELY-IMPORTANT>

## 1. Build the Session Primer

Run the primer-merge script from the repo root:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/build_primer.py"
```
(When developing in-repo: `python3 scripts/build_primer.py`.)

- If it prints `SAGA_UNINITIALIZED: …`, this project has no Project Binding (`.saga.toml`) — it isn't a Saga workspace. **Stop silently and proceed with the user's request normally; do not mention Saga or pitch initialization.** This skill triggers on *any* session (the trigger lives in the skill, not in a per-project file), so an unbound project is the common, expected case — exit quietly. Only route to **initialize-saga** if the user is explicitly setting up Saga (e.g. "/saga:initialize-saga", "initialize my workspace", "bind this repo to a vault").
- If it reports the vault isn't registered, run **initialize-saga** to register/repair it (self-heal).
- Otherwise, treat the printed payload as your **Active Context** for the session — User Profile, Shared Memory, and Workspace Brief. Internalize it; don't echo it back to the user.

## 2. Hold the through-line

A **Session** is bounded by a body of work, not by one context window. The primer is what you re-load on each resumption — keep the work's through-line across compactions and new windows.

## 3. Decisions & glossary are live

The workspace `glossary.md` and `decisions/` are **constraints on the work, not an archive** — hold them open the whole session, whatever you're doing (planning, brainstorming, building):

- **When planning, check the plan against `decisions/`.** A conflict means either the plan is wrong or the decision is stale — resolve it before building; never silently violate a recorded norm. Updating a decision can cascade, so do it thoughtfully.
- **Keep language true to `glossary.md`.** Use its canonical terms and let them frame the problem; challenge drift the moment you notice it.
- **Capture as it crystallizes** — a term sharpens → glossary; a hard-to-reverse, surprising, real-trade-off decision → an ADR (offer ADRs *sparingly*).

This is general practice, not gated behind any one skill. Depth — the 3-criteria ADR test, the glossary discipline, cascade-care — is in `resources/decisions-and-glossary.md` (under `${CLAUDE_PLUGIN_ROOT}`); reach for it when writing or updating either.

## 4. Specs & plans are transient — never workspace knowledge

When the Superpowers **brainstorm** skill writes a spec, or its **writing-plans** skill writes a plan, that file exists for **execution**: the spec gets alignment, the plan gives the agent something to follow. It is **not** knowledge. Once the work merges, nothing in it can't be found in the code, and the *why* that isn't in the code belongs in a **decision** or the **Session Log**. So the spec/plan is a **transient review surface, deleted on merge** — never a workspace note, never a durable vault file.

- **Don't** write it into this repo or the Workspace, and **don't** treat it as an archive.
- If it needs reviewing in Obsidian, it goes to the transient `<artifacts_dir>/scratch/` (expected-empty, cleared on merge) — no durable frontmatter, not `notes/`, not a decision.
- Apply the test: **would it matter if this were deleted?** For a spec/plan the answer is no — delete it. Durable conclusions lift out into the glossary, decisions, and the Brief as you go.

A durable, work-bearing document that *happens* to be agent-generated (a buildable schema, an API/output contract) is the exception — that's **just a note** in the workspace `notes/`, governed by the normal §3 hygiene. "Agent-generated" never decides where something lives; its role does.

## 5. Routing surface

From the Active Context and what the user wants, route to:
- **initialize-saga** — bind/scaffold/heal the workspace (also when the primer reports uninitialized).
- **grill-me** — break a subject down by relentless interrogation, stress-testing a plan against the glossary and decisions (writes both as clarity lands).
- **write-session-log** — at a work boundary, memorialize the Session.
- **consolidate-sessions** — lift Consolidation Candidates from Session Logs into maintained context.

(Brainstorm-steering is deferred; the spec/plan transient-disposal rule lives in §4.)

## 6. Keep the vault high-signal

Follow `resources/workspace-hygiene.md` (under `${CLAUDE_PLUGIN_ROOT}`): keep the Brief small, put new files in the right place, prune stale content, and trigger `write-session-log` at the right time. Don't bloat Active Context.
