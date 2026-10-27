# Laziness Protocol

<!-- Adapted from pstack skills/principle-laziness-protocol/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

**Apply when:** Refactoring, evaluating diff size, or tempted to add abstractions, layers, or signal threading. Bias toward deletion and the smallest change that solves the problem.

- **Consolidate decisions.** Do not repeat the same choice in several places. Put it behind one source of truth and pass the result as a simple flag.
- **Minimize the diff.** Make the smallest change that solves the problem. Fewer lines beat "elegant" boilerplate.
