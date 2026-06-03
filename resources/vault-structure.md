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
  artifacts/                 # frozen, archival, out-of-date by design
    generated/               #   Agent Artifacts (specs, plans)
    session-logs/            #   Session Logs
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
| Generated spec/plan | `artifacts/generated/` |
| Session Log | `artifacts/session-logs/` |
| Follow-up work (Phase 1) | `<workspace>/tasks/` |
| Superseded knowledge | `<workspace>/archive/` (with a why-archived footnote) |

Never put Agent Artifacts or Session Logs inside a workspace — they'd bloat present-tense context (ADR 0009).
