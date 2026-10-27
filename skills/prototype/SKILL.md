---
name: prototype
description: "Use when cstack hits a factual fork that running something can settle (behaviour, timing, an API's output, a layout), instead of asking the human, for example while cstack:plan settles open questions. Builds throwaway variants in a scratch directory outside the repo, observes each one, and returns the decision with the evidence. Never ships code."
argument-hint: "<question>"
---

<!-- Adapted from pstack skills/poteto-mode/playbooks/prototype.md @ 519d36a (MIT, Lauren Tan). -->

# Prototype

You own the decision, not the code. The prototype is a throwaway instrument. The real build happens later in a unit.

This is the one place where the [Laziness Protocol](../cstack/references/principles/laziness-protocol.md)'s smallest change and the usual verification bar invert. Speed over polish. Code quality does not matter. No planning. The rigour is in picking the right design cheaply. Propose variations nobody asked for. Throw an approach away and try another.

Read the [cstack mode skill](../cstack/SKILL.md) first.

## Procedure

1. **Scope the decision.** Name the one question the prototype answers: which layout, which interaction, which behaviour, which timing, which approach. No decision means no prototype. Hand the work back to the caller.
2. **Gather references** when the design space is open. Look for prior art in the repo and its dependencies. Skip this when the direction is set.
3. **Build throwaway** in `/tmp/cstack-prototype/<topic>/`, never inside the repo or a unit worktree. For a visual question, plain HTML, CSS and JS or the lightest stack that renders the idea. For a behaviour or timing question, the smallest script that exercises it. No production framework, no tests, no abstractions. Never copy `paths_hidden` content into the scratch dir.
4. **Compare variants side by side.** Build each alternative behind one switch (a flag, an argument, or a keypress), each one labelled. This is [Exhaust the Design Space](../cstack/references/principles/exhaust-the-design-space.md) made cheap.
5. **Observe on the matching surface.** For a visual question, screenshot each variant with the repo's verify skill if one exists. For a behaviour or timing question, log the timing, print the output, or watch the render. The observation is the test.
6. **Decide.** Pick the variant the evidence favours. Log it with `cstack:show-me-your-work`: the question, the variants, the observed output (the command and its result), the choice. Under `cstack:plan`, the evidence also goes in the plan's Appendix A.

## Report

The variants explored, the evidence (screenshots, or the observed output and timing), the tradeoffs, your recommendation, and the scratch path. Say plainly that the prototype is throwaway and that no repo file changed.
