# The grilling method

Interview relentlessly about every aspect of the subject until you reach shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one.

## Core loop

- **One question at a time.** Ask, wait for the answer, then ask the next. Never batch a list of questions.
- **Recommend an answer with each question.** Don't ask open-endedly — propose the answer you'd pick and why, and let the user confirm, refine, or reframe. (A one-level-up reframe *is* the answer — take it and stop pushing the old menu.)
- **Explore before asking.** If a question can be answered by reading the codebase, the glossary, or the decisions, go read it instead of asking. Spend the user's attention only on what genuinely needs their judgment.
- **Follow the dependency order.** Resolve the decision a branch hangs on before grilling the branches beneath it.

## Pressure-test, don't just collect

- **Concrete scenarios over abstractions.** When a relationship between concepts is in play, invent a specific scenario that probes the edge and forces precision about the boundary. ("What happens when an order is partly cancelled and partly shipped?")
- **Cross-reference against the code.** When the user states how something works, check whether the code agrees. Surface contradictions: *"your code cancels whole orders, but you just said partial cancellation is possible — which is right?"*
- **Challenge against the glossary.** When a term conflicts with the recorded definition, call it out at once. When language is vague or overloaded, propose a precise canonical term. (See the glossary discipline in `resources/decisions-and-glossary.md`.)

## Capture as you go

Don't wait for the end. The moment clarity lands, write it to the vault — a sharpened term to `glossary.md`, a hard-to-reverse decision to a new ADR in `decisions/`. The criteria, formats, and cascade-care for both are in `resources/decisions-and-glossary.md` (under `${CLAUDE_PLUGIN_ROOT}`). Offer ADRs *sparingly* — only when the 3-criteria test passes.

The grilling is finished when the design tree has no unresolved branch the user still needs to judge — not when a question quota is met.
