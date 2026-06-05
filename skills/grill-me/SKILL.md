---
name: grill-me
description: Break a subject down by relentless one-at-a-time interrogation — stress-test a plan against the workspace glossary and decisions, sharpen terminology, and surface ADR-worthy choices, writing the vault as clarity lands. Use when diving deep on a design and you want it pressure-tested against the project's language and recorded norms. Primary agent only.
---

# Saga: grill-me

The explicit on-ramp for going deep. When a subject needs breaking down, `grill-me` decomposes it by interrogating you one question at a time until the design holds — checking every step against the workspace's recorded language and decisions, and capturing what crystallizes into the vault.

> **Primary agent only.** Subagents don't grill.

> **Bound workspace required.** This skill writes the vault `glossary.md` and `decisions/`. If the project isn't bound to a Workspace (`start-session`/the primer reports `SAGA_UNINITIALIZED`), route to **initialize-saga** first. (For an *unbound* repo, the standalone `grill-with-docs` skill is the equivalent that writes repo-root files.)

## The method

Run the interrogation in `method.md` (under `${CLAUDE_PLUGIN_ROOT}/skills/grill-me/`): one question at a time, explore-the-code-before-asking, stress-test with concrete scenarios, cross-reference against the actual code, and challenge every term against the glossary.

## The discipline it serves

`grill-me` is one entry point to a practice that runs all session long. How to *use* and *write* the glossary and decisions — the 3-criteria ADR test, the glossary discipline, cascade-care when a decision moves — lives in `resources/decisions-and-glossary.md` (under `${CLAUDE_PLUGIN_ROOT}`). Grilling is where that capture happens fastest, but it isn't the only place: the same discipline applies to ordinary planning and brainstorming.

## Capture inline, in the vault

When a term resolves or a decision lands, write it **there and then** — don't batch:

- Term → `glossary.md` via `templates/glossary.md`.
- Hard-to-reverse, surprising, real-trade-off decision → a new ADR in `decisions/` via `templates/decision.md`. Offer ADRs *sparingly* (apply the 3-test).

Both live in the **workspace** — never repo-root `CONTEXT.md`/`docs/adr/`, never under `artifacts/`.
