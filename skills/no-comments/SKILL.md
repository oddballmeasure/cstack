---
name: no-comments
description: "Use this skill whenever the user asks to strip, cut, clean up or remove comments from code or a diff, or says comments should be rare, including pasted code. Do not edit the comments yourself. This skill sends the code to the plugin's comment-sicko agent, which deletes narration, banners, commented-out code and workaround essays, keeps legal headers, vendor-quirk notes and public API docs, and marks guilty code MUST KILL. It audits the kills, never changes application logic in the cleaned code, and offers a type, test or lint for each \"do not remove\" constraint."
argument-hint: "[<paths> | <diff>]"
---

<!-- Adapted from pstack skills/no-comments/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# No comments

Spawn the plugin's `comment-sicko` agent. Act on accepted findings. Defer to its fresh perspective.

Read the [cstack mode skill](../cstack/SKILL.md) first. Its **Comments in code** rule is the standard: keep a comment only for a non-obvious why that the code cannot show.

## Scope

Use the caller's files, diff, or pasted text. Otherwise use the current diff against the base branch, default `main`, including the working tree.

## Steps

1. **Spawn.** Use the `Agent` tool with the plugin's `comment-sicko` agent (Claude Code lists it with the plugin prefix). Pass the scope: file paths, the diff command, or the pasted text verbatim. For pasted text, tell it to return the cleaned text and edit nothing on disk. Do not restate its rules.
2. **Audit its report and diff.**
   - Reject application-code edits, scope escapes, deletions that a keep exception protects, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty.
   - Reshape flags on our-code surprises stay actionable. Do not restore those comments.
   - A keep survives only with proof that it is about something we cannot change.
   - Audit missed lint and TypeScript suppressions in scope. Correctness or safety suppressions stay actionable `MUST KILL`s.
   - Restore a deletion only with its exact exception and scoped proof.
   - Before you accept a thin `IMPORTANT` or `do not remove` kill or keep, read the symbol with `cstack:how`, and its history with `git log -L` when a checkout exists. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it.
   - Revert and rerun one rejected report with the failure named. If the second report is also rejected, report it open and stop with the skill failed.
3. **Trivial fixes.** For pasted text, apply nothing here: the cleaned text keeps every non-comment line byte for byte, and each fix goes under **Proposed fixes** in the reply, after the cleaned text. Otherwise, fix trivial accepted flags directly: delete a dead path, drop a parameter, use the real API. If any fix needs a new shape, run `cstack:architect` once for the accepted set and the surrounding code. Stop at its sketch. Step 4 implements.
4. **Root-cause fixes.** Implement the smallest root-cause fix in scope. Remove every named workaround. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. The [Fix Root Causes](../cstack/references/principles/fix-root-causes.md) and [Redesign from First Principles](../cstack/references/principles/redesign-from-first-principles.md) principles guide intent only. Neither one widens the scope. Never bolt on symptom guards. For pasted text, propose the fix in the reply instead of applying it.
5. **Constraint comments.** These say `do not remove`, `do not change wording`, or `talk to X before changing`. Leave keeps about things we cannot change. For the rest, offer the cheapest in-scope type, runtime check, test, or CI lint that enforces the constraint. Wait for the human's approval when one is present. Unattended runs need the caller's approval in advance. If approved, encode it, then delete the comment. Otherwise delete the comment, report the constraint open, and sketch the out-of-scope work.
6. **Report.** Every `MUST KILL` flag, each written with that label, the exact symbol and one line on the reshape. Then the deletion count, restored comments, reruns, the architect sketch, fixes, encoding offers, encodings, constraints left unenforced, and other open work. For pasted text, put the cleaned text first, then **Proposed fixes**.

Inside a cstack unit, the coordinator never edits product code. Turn accepted fixes into a ticket through `cstack:repair` with source `review` instead of steps 3 and 4.
