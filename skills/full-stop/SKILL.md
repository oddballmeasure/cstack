---
name: full-stop
description: "Do the same work as cstack:full-send for one unit or a whole program, but with autonomy stop for this run: never merge, and end each PR with one verdict (Ready to merge, Waiting for required approval, or Blocked). Use for /cstack:full-stop <issue number | guideline text or path>, or when the user says \"full stop\", even as a closing \"Full stop.\"."
argument-hint: "<issue number> | <guideline text or path> [--slug <s>] [--parallel=N]"
disable-model-invocation: true
---

<!-- Adapted from tstack skills/full-stop/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Full stop

Do the same work as `cstack:full-send`, but stop with every PR ready for the user to merge. Never merge one.

Read [full-send](../full-send/SKILL.md) and follow its steps, proof rules, review and babysitting. An explicit "full stop" request authorizes that work without a separate "full send" request. That includes full-send's testing permission: use the test methods that proof needs, even when a project file says to ask first. Its merge permission does not apply. The overrides below take precedence.

## Autonomy stop for this run

In full-send step 2, record `"autonomy": "stop"` in `<store>/run.json`. For a program, pass `--autonomy=stop` to `cstack:program`. `run.json` may always lower autonomy, so the merge gate refuses to merge in this run even when config says `send` (ADR-006). Skip full-send step 3: a lowered autonomy always takes effect. Check it once with `node <root>/gates/run-settings.mjs --store <store>`, which must print `autonomy stop`.

## No merging

You may commit, push, sync, fix conflicts, and use `--force-with-lease` on this run's branches. Never merge, enable auto-merge, enter a merge queue, push to the base branch, bypass branch protection, or delegate those actions.

Check `gh pr view <pr> --repo <repo> --json autoMergeRequest` before work begins and again before each push. The guard hook blocks `gh pr merge --disable-auto`, so turning auto-merge off is the human's action. If auto-merge is on, report that first, before you continue.

## Stop at the gate

Use `cstack:merge-gate` without `--merge` as the readiness check. Replace full-send's merge and report steps with a handoff. Proof and review must cover the final diff. Recheck behaviour changes and real conflict fixes before handoff.

Fetch the base branch and check the live PR's head, base, checks, reviews and mergeability. Confirm it is open, not a draft, and not set to merge without the user. If someone else merged it, report that instead.

End each PR with exactly one verdict:

- **Ready to merge.** The merge gate passes. Leave the PR open and unmerged.
- **Waiting for required approval.** Only a human approval remains. Confirm that this is the actual blocker.
- **Blocked.** Say what prevents readiness, what you tried, and what is needed. Follow full-send's rules for asking the user.

For a program, PR #0 ends merge-ready, so `cstack:program` stops after step 3 and tells the user to merge it and resume. Each later round of units ends the same way.

Report each PR link, final head, verdict, proof, reviewer outcome and remaining risks. State that each PR is still open and unmerged.
