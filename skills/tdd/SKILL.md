---
name: tdd
description: "Use when a cstack ticket fixes a bug or adds behaviour with a clear, cheap local test path, or when the user asks for TDD, a failing test, or a regression test. Write the failing test first, see it fail for the right reason, fix, see it pass. Skip when the test path is unclear, expensive, or integration-heavy, and use cstack:prove instead."
---

<!-- Adapted from pstack skills/tdd/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# TDD

When a change has a clear, cheap test path, make the broken or missing behaviour executable before you change product code. The goal is one focused test that fails before the change and passes after it.

Read the [cstack mode skill](../cstack/SKILL.md) first. Apply [Test Behavior, Not Implementation](../cstack/references/principles/test-behavior-not-implementation.md) to every test you write.

Do not force a test when it is impractical. Skip the new test if it needs broad harness setup, brittle mocks, slow end-to-end infrastructure, production-only state, vague reproduction steps, or large unrelated fixture churn. Use the closest useful check instead, per `cstack:prove`.

Never read or edit the hidden suites in config `paths_hidden`. Your test goes in the repo's normal test location.

## Workflow

1. **Understand the behaviour.** Name the intended behaviour, the current behaviour, the affected path, and the smallest observable reproduction.
2. **Choose the narrowest executable check.** Prefer the closest unit, component, integration or regression test the repo already uses for that path. If no practical test path is obvious, do not build one from scratch only to follow this workflow.
3. **Write the failing test first.** Add the smallest focused test that would have caught the bug. It encodes intended behaviour. It does not mirror the current implementation. For a cstack ticket, test at the application's boundary (HTTP, CLI, or browser) when the ticket asks for it.
4. **Run the new test before the fix.** Confirm it fails for the intended reason. If it passes, or fails for an unrelated reason, correct the test or the reproduction before you edit the implementation.
5. **Make the change.** Make the smallest product change that gives the intended behaviour and keeps nearby contracts.
6. **Run the test again.** Confirm it passes. Then run config `test_command` so nothing nearby broke, with `node <root>/gates/run-tests.mjs <worktree>`. Arguments after `--` go to the test command, for one test file.

## If a failing test is impractical

Use the closest executable regression check: a targeted script, a manual reproduction command, browser automation, a snapshot comparison, a log assertion, or a focused integration check. Save the before and after output per `cstack:prove`.

Prefer no new test over a bad test. A bad test mostly tests mocks, encodes implementation details, depends on timing or unrelated global state, needs expensive infrastructure for a small fix, or would be deleted right after it proves the fix.

## Guardrails

- Do not change tests only to match a wrong implementation.
- Do not weaken existing assertions unless the expected behaviour really changed and the reason is clear.
- Keep the test focused on the change. Avoid broad fixture churn and unrelated coverage.
- If the bug is flaky, make the test deterministic where you can. Name the signal it locks down.
- If the bug shows a wider class of failures, land the focused test first. File the sibling coverage as a follow-up.

## Report

Report the evidence, not only the outcome:

- Name the failing-before test or check and the failure it produced.
- Name the passing-after run and any nearby checks you ran.
- If you could not show failing-before evidence, say why. Name the closest check you used instead.
