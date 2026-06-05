# Vault structure

Saga writes everything into the configured **vault root** (resolved from the Vault Registry, never hardcoded). Layout:

```
<vault_root>/
  Workspaces/
    shared/                  # Shared Workspace — vault-global Active Context
      user.md                #   User Profile (the human)
      memory.md              #   Shared Memory (the agent's operating knowledge + environment)
      notes/                 #   (optional) global Relevant Context
      archive/               #   (optional)
    <workspace>/             # one per project, bound by name + path
      <workspace>.md         #   Workspace Brief (Active Context input)
      glossary.md            #   domain language (Relevant Context)
      decisions/             #   ADRs (Relevant Context)
      notes/                 #   design docs (Relevant Context)
      tasks/                 #   work-state stand-in (Phase 1, until Mimir)
      archive/               #   superseded workspace knowledge
  artifacts/                 # transient, non-knowledge material (kept out of workspaces)
    session-logs/            #   Session Logs (consolidation-scoped, prunable once consolidated)
    scratch/                 #   spec/plan review surfaces, deleted on merge (no durable frontmatter)
```

## Active Context vs Relevant Context

- **Active Context** (handed over at Session Start): `shared/user.md` + `shared/memory.md` + `<workspace>/<workspace>.md`. Kept small and high-signal.
- **Relevant Context**: everything the Brief links out to — glossary, decisions, notes. Reached by progressive disclosure.

## Where things go

| Thing | Location |
|-------|----------|
| Durable product knowledge | Workspace Brief / `decisions/` / `notes/` |
| Domain term | `glossary.md` |
| Hard-to-reverse decision | `decisions/` (ADR) |
| Durable agent-generated reference (schema, API/output contract) | `<workspace>/notes/` (it's just a Note) |
| Spec/plan (Superpowers brainstorm/writing-plans output) | `artifacts/scratch/` — transient, **deleted on merge** |
| Session Log | `artifacts/session-logs/` |
| Follow-up work (Phase 1) | `<workspace>/tasks/` |
| Superseded knowledge | `<workspace>/archive/` (with a why-archived footnote) |

Never put Session Logs inside a workspace — they'd bloat present-tense context. Specs/plans aren't knowledge at all: review them, then delete on merge.
