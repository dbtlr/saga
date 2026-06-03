# Saga

**A workflow orchestrator for agentic coding sessions.** Saga teaches an agent to run a coherent working **Session** — the narrative layer that strings a body of work into a single through-line, from session start to session log.

Saga owns neither knowledge nor work. It threads the two domain-owning tools beneath it into and out of the session.

## The three-tool split

Saga is one part of a three-tool ecosystem founded on the distinction **knowledge vs. work**:

- **Norn** — *knowledge.* A generic query/validation/repair layer that keeps the Vault consistent. Enforces the rules it is given; has no native concept of a Workspace.
- **Mimir** — *work.* An opinionated project tool that natively owns the work model (projects, initiatives, tasks, release planning).
- **Saga** — *orchestration.* Threads Norn and Mimir into and out of a Session. Owns neither.

The test each tool must pass is to state its purpose without "and": *Norn keeps knowledge. Mimir holds work. Saga weaves them into a session.*

> Norn and Mimir are forthcoming. Saga's Phase 1 stands on its own against a markdown knowledge vault; the Norn/Mimir seams are Phase 2.

## The four skills

| Skill | What it does |
| --- | --- |
| `session-start` | Saga's entry point. Assembles the **Session Primer** (User Profile + Shared Memory + Workspace Brief) and routes the work. |
| `init` | Binds a project to a vault Workspace and scaffolds or self-heals it. |
| `session-log` | At a work boundary, writes the merged **Session Log** memorializing what happened — decisions, deviations, and Consolidation Candidates. |
| `consolidate` | Lifts Consolidation Candidates out of frozen Session Logs into maintained context — durable knowledge to the workspace, follow-ups to tasks, user observations to the partner-model log. |

## Install

Saga ships as a Claude Code plugin served from this repo via a local `directory` marketplace (`saga-dev`). From a Claude Code session:

```
/plugin marketplace add /path/to/saga
/plugin install saga@saga-dev
```

Because the marketplace `source` is the repo directory itself, the installed plugin is served in place — `${CLAUDE_PLUGIN_ROOT}` resolves to the repo root, so the installed skills *are* the repo files (no copy to keep in sync).

Once installed, a primary session starts with:

```
/saga:session-start
```

## How it fits together

A **Session** is bounded by a body of work, not by a single context window. `session-start` builds the Session Primer that re-loads on each resumption, keeping the through-line across compactions and new windows. At a work boundary, `session-log` freezes what happened; `consolidate` later lifts the durable parts into maintained context. `init` keeps the underlying Workspace well-formed.

## Repository layout

- `skills/` — the four skill sources (`session-start`, `init`, `session-log`, `consolidate`). Loaded by Claude Code from the plugin root and by Codex when launched in this directory.
- `scripts/build_primer.py` — resolves Project Binding → Vault Registry → vault root and merges the Active Context.
- `resources/`, `templates/` — shared skill resources and document templates.
- `tests/` — primer-merge tests.
- `.claude-plugin/` — plugin manifest and the local `saga-dev` marketplace.

## License

MIT — see [LICENSE](LICENSE).
