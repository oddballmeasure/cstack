---
name: modernize
description: "Use when asked to rebase, refresh, revive or \"modernize\" an old pull request, or when cstack:takeover inherits a branch that has fallen behind its base. Checks whether the PR's goal still belongs before it rebases, then recommends MODERNIZE, REWORK or CLOSE. Rebases and pushes only on MODERNIZE, with --force-with-lease pinned to the observed head. Never merges."
argument-hint: "<pr-number | pr-url>"
---

<!-- Adapted from tstack skills/modernize/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Modernize

Modernize the idea, not just the branch. A clean rebase does not prove that the PR still belongs in the product.

Read the [cstack mode skill](../cstack/SKILL.md) first. `<root>` is the plugin root, two directories up from this skill's base directory. Read `repo` and `base_branch` from `.cstack/config.json` with `jq` when it exists.

## Guardrails

- Fetch the latest remote state of the PR branch, its base, and any related branch before you start.
- Treat existing worktree changes as the human's. Use a disposable worktree (`git worktree add`) when the active one is dirty or in use.
- A human's request to modernize a PR authorizes a rebase and a force push of that one PR branch. That is the approval rule 7 of the mode skill needs. It does not authorize a merge, a close, a base change, or more scope. When another skill chains here without that request, push to a new branch, or ask first.
- Never use an unqualified force push. Use `--force-with-lease` pinned to the head SHA you observed before the rebase.
- Never merge the PR.
- Do not post a PR comment unless the human asked for one. Write every comment with `cstack:leaving-pr-comments`.

## Establish the PR's intent

```bash
node <root>/gates/forge.mjs change view <n> --json
node <root>/gates/forge.mjs checks <head> --json
```

Record the URL, state, base, head repository (`headRepo`) and branch, head SHA, author, checks and review state. Read the title, body, linked issues, commits, review threads and the full diff. State the smallest coherent goal the PR was trying to reach before you judge its code.

Fetch the base and the PR head. Use the PR's real base branch. Do not assume the local copy is current. Record the merge base, so you can compare the PR's own changes and the base's later changes separately.

## Check what changed around it

Read the commits and diffs that landed on the base since the PR diverged. Scan open PRs (`node <root>/gates/forge.mjs change find --state open`) and recent merged ones (`node <root>/gates/forge.mjs changes merged --limit 50`). Read those whose titles, paths or behaviour suggest a replacement or a competing change.

Look beyond the overlapping lines:

- Did the base already solve the same user-facing problem?
- Did APIs, types, schemas, dependencies or module boundaries change?
- Do both sides now claim the same behaviour or invariant?
- Was the changed code deleted, moved, or simplified on purpose?
- Would landing the PR restore old behaviour or make two ways to do one thing?
- Is the original benefit still worth the maintenance cost?

Do not call a PR current only because Git reports no conflicts.

## Choose a disposition before you push

- **MODERNIZE.** The goal is still useful and the code is still the right shape. Rebase, resolve, check, and update the branch.
- **REWORK.** The goal is still useful, but a mechanical rebase would keep the wrong code. Describe the smallest credible rewrite. Stop before you push, unless the human also asked for the rework.
- **CLOSE.** The PR is superseded, obsolete, wrong in direction, or no longer worth its cost. Cite concrete evidence and stop. Do not rebase an obsolete branch. Do not close it without explicit permission.

Be willing to recommend CLOSE. Age alone is not evidence. Sunk effort is not a reason to keep a PR alive.

## Rebase without losing intent

For MODERNIZE:

1. Make a local branch or disposable worktree at the recorded PR head.
2. Rebase its commits onto the freshly fetched base.
3. Resolve each conflict by the guidance in [Resolve by current intent](../sync-base/SKILL.md#resolve-by-current-intent) from `cstack:sync-base`. It is the same rule set. If a conflict shows a product or architecture disagreement, stop and reconsider the disposition. Do not guess.
4. Compare the series before and after with `git range-diff <merge-base>..<old head> <new base>..HEAD`. Read the final diff. Confirm that no intended behaviour disappeared and no behaviour the base already landed came back.
5. Run the repo's focused checks for the touched area (config `test_command` when it exists). Tell real failures apart from failures that were already there or come from infrastructure.
6. Push to the PR's head repository:

   ```bash
   git push --force-with-lease=refs/heads/<branch>:<head SHA observed before the rebase> <head remote> HEAD:refs/heads/<branch>
   ```

   If the lease fails, someone pushed. Fetch and reassess. Never overwrite their work. Inside a cstack unit, `gates/publish.mjs` makes this push with the same kind of lease.

A rebase makes a new head. Every verdict on the old head is void (mode skill, rule 3). Inside a unit, run the commit gate and `cstack:verify-head` again.

## Report

Lead with MODERNIZE, REWORK or CLOSE and the reason. Then:

- meaningful changes on the base;
- conceptual conflicts, or a statement that you found none;
- the rebase and push result, if you did them, with old and new head SHAs;
- the checks you ran and their results;
- the remaining decision or work, with a link to the PR.

Keep observed facts apart from judgment. Say what you could not verify. Do not invent confidence.
