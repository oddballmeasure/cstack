---
name: babysit-pr
description: "Use when a cstack unit has an open PR and must drive it to green (unit stage 10). Waits with the Monitor tool on gates/pr-wait.mjs, then handles conflicts, review threads and failed CI in that order, each through its own unit stage, and runs cstack:review-loop once per new head before the merge gate. Writes every reply with cstack:leaving-pr-comments. Only the unit coordinator runs it, never a subagent."
---

<!-- Adapted from tstack skills/babysit-pr/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Babysit PR

This is stage 10 of the unit flow (`docs/unit-flow.md`). It starts after `cstack:file-pr` and ends when `pr-wait.mjs --until green` exits 0, no actionable review thread is left, and step 10b (the review loop) approved the head or was skipped. Then the unit goes to stage 11, `cstack:merge-gate`.

`<root>` is the plugin root, two directories up from this skill's base directory. Read `repo`, `label_prefix` and `limits` from `.cstack/config.json` with `jq`.

## Who watches

- Only the unit coordinator (`cstack:unit`) watches the PR. A subagent never runs `pr-wait.mjs`, never arms a Monitor on a PR, and never babysits. If you are a subagent, stop and report to your coordinator.
- One watcher per PR. `pr-wait.mjs` holds a lock. If it exits 2 with "another pr-wait already watches", do not start a second one. Find the running Monitor and use it.

## Waiting

Never write a watcher, a polling loop or a `sleep` loop. The guard hook blocks them. Arm the `Monitor` tool:

- command: `node <root>/gates/pr-wait.mjs <pr> --repo <repo> --until green`
- timeout_ms: `1800000`
- description: `PR #<pr> on <repo> until green`

Each stdout line is one real event and wakes you. Then:

- **Monitor expired, pr-wait still running.** Arm it again with the same command. pr-wait keeps state, so nothing that arrived in between is lost.
- **pr-wait exited 0.** Required checks are green on the head, or the PR merged. Go to **Done**.
- **pr-wait exited 1.** It needs action. Read its last lines and handle them in the order below.
- **pr-wait exited 2.** Bad input or a second watcher. Fix the command once. If it fails again, the stage fails with kind `github`.
- **An event needs no action.** End the wake without a message. Never post or say "still waiting".

Do not end your turn while the PR is pending. Stay on the Monitor until pr-wait exits.

Measure the wait from the first arm on the current head. When it passes `limits.ci_timeout_seconds` and checks are still pending, the stage fails with kind `ci_timeout`.

Arm it again after each push, after you handle an exit 1, and after a resume.

## Handle findings in this order

Act only on events, comments and check runs newer than the last push. Older ones were handled in an earlier round or are stale. Get the last push time from `git -C <worktree> log -1 --format=%cI` and the PR's head SHA.

### 1. Conflicts and base movement

pr-wait reports `DIRTY`, `BEHIND`, or base commits that touch this PR's files. Stop the Monitor with `TaskStop`. Go to stage 7, `cstack:sync-base`. A conflict there becomes a SYNC ticket.

### 2. Review threads and comments

Read the new reviews, comments and unresolved threads:

```bash
node <root>/gates/forge.mjs reviews <pr> --json
node <root>/gates/forge.mjs threads <pr> --open --json
```

`reviews` gives reviews and top-level comments. `threads` gives each unresolved thread with its `id`, `path`, `line` and comments. Every record has `author` and `bot`, so you can tell a review bot from a human.

For each finding:

1. **Verify it against the source.** Read the cited code in the worktree. Bots are useful and often wrong. A finding counts only when the code shows the problem. A human finding counts by default, but still check it.
2. **Classify it.**
   - A real bug in the intended case. Run `cstack:repair` with source `verify` and the verified findings as `review: <path:line> <finding>` lines. It returns `retry REPAIR-<n>` (the unit goes back to stage 5, then 6, 7 and 8) or `exhausted verification` (the unit fails). Also cap review rounds at `limits.review_rounds`, counted from this stage's `fix` rows in the decision log. Past that cap, the stage fails with kind `pr_violation`.
   - A false positive. Reply on the thread with a one-line reason that cites the code. Resolve the thread only after the reply posted.
   - Scope creep. Decline it (see **Fight scope**).
3. **Reply** on the thread with `node <root>/gates/forge.mjs thread reply <pr> <thread id> --body-file <file>`, or on the PR with `node <root>/gates/forge.mjs change comment <pr> --body-file <file>`. Resolve a thread with `node <root>/gates/forge.mjs thread resolve <pr> <thread id>`. Write every reply with `cstack:leaving-pr-comments`: the callout header, the direct style, the secret check, and the footer line from `<root>/templates/footer.md` last.

Review bots such as CodeRabbit are advisory. Treat their findings like any other, but never wait for them.

### 3. Failed CI

pr-wait reports a failed check and exits 1. Collect the failure:

```bash
node <root>/gates/ci-log.mjs <pr> --repo-dir <worktree>
```

- **Infrastructure flake.** The log shows a runner, network or quota error, not a test or build failure in this repo. Re-run the failed checks once with `node <root>/gates/forge.mjs checks rerun <head sha>`. Log the decision. A second flake on the same check counts as a real failure.
- **Real failure.** Run `cstack:repair` with source `ci` and the ci-log output verbatim. It counts against `limits.ci_repair_rounds` and returns `retry CI-REPAIR-<n>` (the unit goes back to stage 5) or `exhausted ci_failed` (the unit fails).

After every repair, stages 6, 7 and 8 run again before you arm the Monitor. A new commit voids the old verdict.

## Fight scope

Review loops grow a PR one cheap fix at a time. Keep it at the size the issue needs.

- Fix real bugs in the intended case.
- Decline the rest with a written reason: unneeded tests, guards for edge cases that do not matter, extra integration or compatibility, small performance costs, refactors nearby.
- Prefer the fix that deletes or narrows code.
- File each declined extra that has value as a follow-up issue:

```bash
node <root>/gates/forge.mjs issue create --label "<label_prefix>:proposed" --title "<one line>" --body-file <file>
```

The body links the PR and the thread, says why it was left out, and ends with the footer line. Reply on the thread with the new issue's link, per `cstack:leaving-pr-comments`, and resolve it.

## Rate limits

On GitHub, `change view` falls back to REST by itself when GraphQL is exhausted, and `checks`, `reviews` and `change find` read through REST already. `threads` needs GraphQL. If a forge.mjs call or pr-wait itself stops on rate limits, arm pr-wait again once after the limit resets (GitHub resets it within the hour). Use one background command for that wait, never a loop.

## Done

pr-wait exited 0. Before you leave the stage:

- If the PR merged outside cstack, record it and go to stage 12 with outcome merged.
- If the PR closed without a merge, the stage fails with kind `pr_violation`. Do not reopen it.
- Check for review threads that arrived after the last event and are still unresolved. Handle them per step 2.
- Run step 10b below.
- Then go to stage 11, `cstack:merge-gate`.

## 10b. Review loop

A sub-step of stage 10. It runs once per new head, after pr-wait exited 0 on that head and before the merge gate.

1. List the changed paths: `git -C <worktree> diff --name-only <base>...HEAD`. If every path is documentation (`*.md`, `*.mdx`, `*.rst`, `*.txt`, `docs/**`, `LICENSE*`), skip it. Log `skip: docs only`.
2. If the review ledger already has a round at this HEAD, do not run another. Use that round's result.
3. Otherwise run `cstack:review-loop` for one round on the PR diff, with the author model `models.code`. It keeps its ledger in `<store>/review-<unit>.tsv` and `<store>/review-<unit>-rounds.tsv`.
4. Act on its result:
   - Approved: go to stage 11. The loop has added its line to the PR body.
   - Agreed blockers or shoulds: it ran `cstack:repair` with source `review`, which returned `retry REPAIR-<n>`. The unit goes to stage 5, then 6, 7, 8 and back to stage 10 on the new head.
   - Disputed after two replies, or budget end: settle as needs a decision through `cstack:settle`, with both sides. Do not go to the merge gate. Budget end is not approval.

Log one row in `<store>/decisions.tsv` per round (`cstack:show-me-your-work`): what arrived, what you did, the evidence (check name, thread id, commit SHA), and the result.

## Overlapping work

If another PR makes this one obsolete, stop the Monitor and settle the unit as needs a decision (`cstack:settle`). Never close a PR without the human.
