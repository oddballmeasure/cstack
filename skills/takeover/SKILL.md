---
name: takeover
description: "Use when the human asks to take over a PR, a branch, or another agent's unfinished thread, or asks for a \"takeover\". Finishes the original goal on a cstack branch that keeps the original commits and contributor credit, refreshes it with cstack:modernize, proves it with cstack:prove and cstack:verify-head, then files and babysits the PR. Merges only through cstack:merge-gate."
argument-hint: "<pr-number | branch | transcript or run path>"
---

<!-- Adapted from tstack skills/takeover/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Takeover

Take responsibility for finishing the original goal. Keep the original contributors' credit. Do not defend an implementation only because another agent already built it.

Read the [cstack mode skill](../cstack/SKILL.md) first. `<root>` is the plugin root, two directories up from this skill's base directory. Read `repo`, `base_branch`, `label_prefix` and `limits` from `.cstack/config.json` with `jq`. Without a config, use `<root>/templates/config.json` and say so.

If the work is a cstack run whose coordinator died or paused, this is the wrong skill. Use `cstack:resume-run`.

## 1. Inherit

Read the source in full:

- **A PR.** `node <root>/gates/forge.mjs change view <n> --json` (url, state, author, base, branch, head, headRepo, commits, body), its reviews (`node <root>/gates/forge.mjs reviews <n> --json`), its review threads (`node <root>/gates/forge.mjs threads <n> --json`), the checks on its head (`node <root>/gates/forge.mjs checks <head>`), and the full diff.
- **A branch.** `git log` and the diff against its merge base with the base branch.
- **An agent thread.** Its transcript under `~/.claude/projects/<slug>/`, or its run store under `.cstack/runs/<slug>/`. Read the human's later corrections too.

Resolve the handoff to real code at a real head SHA. Check `git worktree list` and `git status` in each related worktree for uncommitted work. That work belongs to its owner. Do not discard it. Treat the handoff as context, not proof. Every claim in it is a model claim until you observe it (rule 1).

If the linked issue carries `<label_prefix>:in-progress`, a run may still hold it. Check that run's store and worker before you start. Do not take over a live run's work without the human's say.

## 2. Branch and credit

Make a replacement branch unless the human asked for an in-place or stacked continuation. Do not overwrite unrelated work. Do not push to, retitle, comment on or close the original PR without authorization.

```bash
git -C <repo> fetch origin pull/<n>/head:refs/remotes/origin/takeover-<n>
node <root>/gates/isolate.mjs <repo> <branch> <worktree> --base origin/takeover-<n>
```

Name the branch `cstack/<N>-<slug>` when an issue `N` exists (`docs/unit-flow.md`), else `cstack/takeover-<n>`. The branch starts at the original head, so it keeps the original commits, authors and `Co-authored-by` trailers. Add your fixes as separate commits on top.

Credit the original contributors in the PR body and link the original PR. Use identities you verified from `git log --format='%an <%ae>'` or the forge's change record. Do not guess an email. If the repo squash-merges, check that the squash message keeps a `Co-authored-by:` line for each human contributor. A model attribution line does not replace contributor credit.

## 3. Modernize and finish

Run `cstack:modernize` on the new branch against its intended base. Here a REWORK disposition is in scope, because finishing the goal is the job. A CLOSE disposition ends the takeover. Report it with the evidence.

Rework only what the original goal needs. Do not add unrelated features. Simplify without dropping intended behaviour or surfaces. Before you file, check the source PR again. It may have moved while you worked.

## 4. Verify

- Reproduce the original failure, then show the same reproduction passing, with `cstack:prove`.
- Exercise the realistic user workflows, per the repo's guidance and permissions. Green mocked tests do not prove the user experience.
- Get a non-author verdict at the exact head with `cstack:verify-head`. You wrote the fixes, so you cannot approve them (rule 3).
- Run `cstack:review-loop` on the diff.

State what stays unverified.

## 5. File, babysit, merge

When the requested finish includes a PR:

1. File it with `cstack:file-pr`. Give it the issue, branch, worktree, verified SHA and a run store (`<repo>/.cstack/runs/takeover-<n>/` outside a run). The body adds a credit line after the fix paragraph: `Takes over #<n> by @<login>.`
2. Drive it to green with `cstack:babysit-pr`. Do not stop at creation.
3. Write every reply with `cstack:leaving-pr-comments`.
4. Merge only through `cstack:merge-gate`, under the run's effective autonomy.

Inside a unit, the unit flow owns the `<label_prefix>:*` state labels. Outside one, move the issue to `<label_prefix>:in-progress` while you work and settle it at the end. Keep one state label at a time.

Close the original PR only when the human authorizes it. When you do, post a comment that links the replacement, written with `cstack:leaving-pr-comments`.

## Report

What you inherited, what you changed, how you verified it (with evidence paths), how credit was kept, and every open decision.
