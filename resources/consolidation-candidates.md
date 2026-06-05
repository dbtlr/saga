# Consolidation Candidates

A **Consolidation Candidate** is an item a Session Log flags as worth lifting out of the frozen record during Consolidation. Three buckets, each routing to the tool that owns it.

## Taxonomy

### Durable knowledge
- `decision` — a decision that will affect future work
- `user-persona` — something newly learned about the target user
- `user-story` — a user story that surfaced and should be honored going forward

### Future opportunities
- `tech-debt` — debt incurred; remember it (promote to a task if high priority)
- `follow-up-task` — work that resulted from / was discovered during this session
- `open-question` — unresolved question to revisit

### User observations
- `collaboration-pattern` — something that helps future agents work better with the user

## Routing (Phase 1)

| Bucket | Routes to | Seam |
|--------|-----------|------|
| Durable knowledge | Workspace Brief / `decisions/` / `notes/` | → Norn |
| Future opportunities | `<workspace>/tasks/` | → Mimir |
| User observations | append to legacy `partner_model_log.jsonl` | → own `user.md` regeneration |

The Session Log is the only consolidation source. Once consolidated it is **spent** — frozen but prunable, not a permanent archive.
