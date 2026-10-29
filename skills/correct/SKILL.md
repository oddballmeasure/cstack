---
name: correct
description: "Find the mistakes agents keep repeating in this repo and make each one impossible. Try architecture first, then types, then a lint, hook or check whose error names the fix, then a test, and write docs last. Prove each check fails on a real past mistake. Keep a rule table in CLAUDE.md. Repeat each time the human corrects you. Use for /cstack:correct."
disable-model-invocation: true
---

<!-- Adapted from pstack skills/correct/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# Correct

The human keeps correcting agents in this repo for the same mistakes. Change the repo so the next agent cannot make them.

Read the [cstack mode skill](../cstack/SKILL.md) first, and [Encode Lessons in Structure](../cstack/references/principles/encode-lessons-in-structure.md). This skill is that principle applied to a whole repo.

Assume every contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Design the repo so a change that looks right from one file is right for the whole repo.

## Find the mistake classes

Read recent commits, reverts, review comments, `CLAUDE.md` (or `AGENTS.md` when no `CLAUDE.md` exists), and comments that explain workarounds. Use `gh` for PR review threads. Group the mistakes into classes. A class counts once it has happened twice.

## Fix each class at the highest level that works

1. **Eliminate it with architecture.** Give each piece of state one owner and each task one supported way. Hide internals so the wrong import fails. Replace hand-synced lists with one source of truth. Delete old ways and dead code that an agent would copy.
2. **Enforce it with types, so the bad state cannot be written.** If bad code still compiles, add a lint, CI check, or Claude Code `PreToolUse` hook whose error names the file, type or function to use instead. If the pattern is already common, fail only when a change adds more.
3. **Test the behaviour.** Fix or delete any test that still passes when the behaviour it checks breaks, or that fails when only the internals change.
4. **Write docs or agent rules last, only for judgment calls.** Nothing fails when an agent skips them.

## Fix and prove

Fix the most frequent classes now, one commit each, on a branch. Do not commit to the default branch. Prove each new check fails on a real past mistake: check out or replay that mistake, run the check, and show the failure output. Run the same command locally and in CI. An exception goes on the offending line with a reason, an expiry date, and a human's approval.

## Keep the rule table

Keep a table in `CLAUDE.md` (or `AGENTS.md` when no `CLAUDE.md` exists) that pairs each rule with what enforces it:

| Rule | Enforced by |
| --- | --- |
| <one-line rule> | <lint rule, hook, check, type, test, or "judgment, no check"> |

When the human corrects you, fix the mistake and add the rule. If the rule was already there and nothing enforces it, that is a repeat. Fix it at the highest level in the same change. Drop a rule once its mistake cannot happen.

## Reply

Each class with its evidence, the level you picked, and why a higher level did not work. Then the commits, and the failure output that proves each new check.
