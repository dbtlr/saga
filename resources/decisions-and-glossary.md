# Decisions & glossary discipline

A workspace's `glossary.md` and `decisions/` are **live constraints**, not an archive. This is the standing practice for *using* them and for *keeping* them — general practice that fires during ordinary planning and brainstorming, not only inside `grill-me`.

Session Start teaches the trigger; this resource is the depth, reached on demand.

## Decisions (ADRs) are guardrails

An ADR in `decisions/` is a commitment the workspace has already made. Treat it as a constraint on new work, not as history.

**Using them — every time you plan work:**

- Check the plan against existing `decisions/`. If it conflicts, stop and resolve the conflict before building — don't silently violate a recorded norm.
- A conflict means one of two things: the **plan is wrong** (correct the plan), or the **decision is stale** (the world changed and the norm should move). Name which.
- Updating a decision is **not a local edit**. A decision can be referenced by others and embodied across the workspace; changing it may **cascade** into sibling ADRs, the glossary, and the Brief. Do it thoughtfully and follow the threads — leaving the rest inconsistent is worse than not changing it. Supersede rather than silently rewrite when the old reasoning still has readers.

**Writing one — offer *sparingly*.** Record an ADR only when **all three** hold:

1. **Hard to reverse** — the cost of changing your mind later is meaningful.
2. **Surprising without context** — a future reader will look at the result and wonder "why on earth this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons.

If any is missing, skip it. Easy to reverse → you'll just reverse it. Not surprising → nobody wonders. No real alternative → there's nothing to record beyond "we did the obvious thing."

Use `templates/decision.md`. Number sequentially (scan `decisions/` for the highest and increment). For a phased decision, keep the **Northstar** (target shape) and **Phase 1** (current approximation) sections so direction stays stable while mechanics move.

## The glossary keeps language — and framing — sharp

`glossary.md` is the workspace's canonical language. Its job is twofold: keep terminology **consistent** across sessions, and give the **conceptual frame** the work reasons in.

**Using it — continuously:**

- Speak the canonical terms. When you or the user reaches for a vague or overloaded word, swap in the glossary's term ("you said *account* — that's the **Customer**, not the **User**").
- Challenge conflicts immediately. If usage drifts from the recorded definition, surface it: *"the glossary defines X as A, but you seem to mean B — which is it?"* Drift is either a misuse to correct or a definition to update.
- Let the terms frame the problem. The glossary encodes the distinctions that matter (the three-tool split, knowledge vs. work, …); use them to structure the reasoning, not just to spell-check it.

**Writing/extending it — when a term crystallizes:**

- **Be opinionated.** When several words name one concept, pick the best and list the rest under `_Avoid_`.
- **Keep definitions tight** — one or two sentences. Define what it *is*, not what it does. Reference related terms in **bold**.
- **Only context-specific terms.** A concept unique to this workspace belongs; a general programming concept does not, however heavily it's used. Ask: is this *ours*, or generic?
- Implementation detail never goes here — the glossary is a glossary, not a spec or scratchpad.

Use `templates/glossary.md`.

## Where these live

In a bound Saga workspace, both live in the **workspace** (`glossary.md`, `decisions/`) — never repo-root `CONTEXT.md` or `docs/adr/`, and never under `artifacts/` (ADR 0009). `initialize-saga` scaffolds them; you only ever extend what exists.
