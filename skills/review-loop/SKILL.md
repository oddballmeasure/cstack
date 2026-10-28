---
name: review-loop
description: "Use when a diff needs an independent review loop before it ships: cstack:unit stage 10 runs it on the PR diff once per new head, and a human can ask for it on a branch, a PR or a pasted diff (\"review loop\", \"review this until it is clean\"). A reviewer on a different Claude model from the author reviews in fresh context each round. The main agent re-grades every finding, keeps a ledger, fixes the smallest thing, and sends disputes to the human. Budget end is not approval."
argument-hint: "[<pr-number> | <path to diff>]"
---

<!-- Adapted from tstack skills/sol-loop/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Review loop

Make a change more correct before it merges. A reviewer that did not write the code reviews the diff in a loop. You answer each finding with the smallest fix or with evidence. Be careful of scope creep. Push back when a finding does not earn its place.

Read the [cstack mode skill](../cstack/SKILL.md) first. `<root>` is the plugin root, two directories up from this skill's base directory. Read config `models` and `limits` with `jq` from `<repo>/.cstack/config.json`. Without a config, use `<root>/templates/config.json` and say so.

## Budget

- Default: `limits.review_rounds` rounds (3). Round 1 is a full review. Later rounds check only changed code and open findings.
- Extend to 5 only for security, permissions, auth, data loss, or state and concurrency, while a blocker or should stays open with evidence. Or when the human asks. Log the extension and its reason.
- Stop early when a round returns only nits. Declined nits and comment, doc or format-only fixes need no new round.
- One reviewer per round. The reviewer never starts subagents or other reviewers.
- Budget end is not approval. A timeout, an error or no reply is not approval either.

These rounds are separate from the review-thread rounds that `cstack:babysit-pr` counts for human and bot comments on GitHub.

## The reviewer

The reviewer is the plugin's `cstack-reviewer` agent, spawned with the `Agent` tool. Claude Code lists it with the plugin prefix. Every round gets a fresh agent, so it reviews with fresh context. Never reuse a live reviewer.

Pick its `model`:

1. The author model is the model that wrote the diff. In a unit it is config `models.code`. For a human's own work it is the model the human names, else this session's model.
2. Use config `models.review`. If it equals the author model, or is `inherit` and the session model is the author model, pick the first of `fable`, `opus`, `sonnet` that differs from the author model. Log the substitution with its reason, and say it in the report.
3. Use the same reviewer model in every round of one loop.

<!-- Room for later, not implemented: an optional config key `models.reviewer_command` could name an external CLI reviewer (another vendor's model). The loop would run it with the same brief on stdin and parse the same reply format. Today the reviewer is always a Claude model through the Agent tool. -->

## 1. Scope

Name the diff, the author model, the intent, what is out of scope, and the round budget (3, or 5 for security, auth, data loss or concurrency), in 1 to 3 sentences.

- **Inside a unit** (`cstack:unit` stage 10, step 10b). The diff is `git -C <wt> diff <base>...HEAD`, with `<base>` as the unit names it. Each call runs one round on the current head. The ledger in the run store carries the loop across heads, so the round number is the ledger's last round plus 1.
- **A PR.** `gh pr view <n> --json baseRefName,headRefOid`. Confirm HEAD is the PR head. The base is `git merge-base HEAD origin/<baseRefName>`.
- **A local branch.** Run `git status --short`. Do not stash, discard or include unrelated changes. The base is `git merge-base HEAD origin/<default branch>`.
- **A pasted diff or a file the human points at.** Review that text as it is. Put it in the brief verbatim.

Use one diff command for every round. Run the covering checks when you can (config `test_command`). Do not send code that this change breaks. Note missing or failing checks in the brief.

**Docs-only diffs.** If every changed path is documentation (`*.md`, `*.mdx`, `*.rst`, `*.txt`, `docs/**`, `LICENSE*`), skip the loop. Log `skip: docs only`.

## 2. The ledger

Keep one ledger per loop. Never guess a value in it.

| Where | Rounds file | Findings file |
|---|---|---|
| Inside a unit | `<store>/review-<unit>-rounds.tsv` | `<store>/review-<unit>.tsv` |
| A PR or branch outside a run | `<repo>/.cstack/runs/review-<branch slug>/rounds.tsv` | `<repo>/.cstack/runs/review-<branch slug>/findings.tsv` |
| A pasted diff | In the reply | In the reply |

Rounds file columns: `round`, `head` (full SHA, or `pasted`), `model`, `verdict` (`APPROVE` or `CHANGES`), `usage`.

Findings file columns: `id`, `round`, `severity`, `location`, `claim`, `outcome`, `replies`, `evidence`.

- `id` is the reviewer's stable id (`S1`, `S2`, ...). Keep it across rounds.
- `severity` is your grade, not the reviewer's: `blocker`, `should`, or `nit`.
- `outcome` is one of `open`, `fixed`, `disputed`, `declined`, `resolved`, `needs-human`.
- `replies` counts your written disagreements on that finding.
- `usage` is what the Agent tool returned for the round (tokens, tool uses, duration). If it returned nothing, write `not exposed`.

## 3. Run a round

Spawn the reviewer. Do not edit the scoped files while it runs. Wait for its notification. Do not poll. Do not start a second reviewer. On a failure, record it, then start a fresh reviewer with the ledger.

Round 1 brief:

```
GOAL: Review only. Do not edit, commit, push, comment on PRs, or start subagents.
CONTEXT: Read <root>/skills/cstack/SKILL.md first. Repo: <abs path or "pasted">. Base: <sha>. Head: <sha>.
  Intent: <intent>. Out of scope: <scope>. Checks: <results>.
SCOPE: git diff <base>...<head> [-- <paths>], or the diff below. Read the surrounding code.
ACCEPTANCE: Find bugs, broken callers, and mismatch with the intent. Skip style unless it hides a bug.
  Hold to the smallest change. Flag code, tests or guards the intent does not need.
  Other paths, rare cases, small perf, extra compat: nits.
  blocker = the intended case is wrong. should = a real bug callers will hit, inside the intent. nit = the rest.
FORBIDDEN: <paths_hidden>, <paths_off_limits>, any write, any GitHub call.
REPORT:
VERDICT: APPROVE or CHANGES
S1 [blocker|should|nit] <file>:<line> <claim>. Fix: <suggestion>
```

Round 2 and later: send the round 1 brief, the same base diff, the change since the last round, and the ledger as lines `fixed: S1 <evidence>`, `disagree: S2 <evidence>`, `declined: S3 <reason>`. Tell the reviewer: check open ids and changed code only, and mark each old id `resolved` or `still open: <reason>`.

## 4. Answer every finding

Check each finding and its severity yourself against the code. Another path, a rare case or a small cost is a nit, whatever label it came with. Do not agree just to end the loop.

- **Agree.** Choose the smallest fix. Prefer deleting or narrowing code over a new lock, cache, helper or option. Fix the case that happened. Add one focused test that fails without the fix, if the intent needs it.
- **Disagree.** Say why, with evidence: `file:line`, a test, command output. Increment `replies`.
- **Out of scope, or a nit.** Decline in one line. List it as a follow-up.

Then apply the agreed fixes:

- **Inside a unit.** You never edit product code. Run `cstack:repair` with source `review` and one line per agreed blocker or should: `review-loop <id> [<severity>] <path:line> <claim>. Fix: <smallest fix>`. It returns `retry REPAIR-<n>`. The unit goes to stage 5, then 6, 7, 8 and 10. The next round runs on the new head.
- **Outside a run, when the human asked for fixes.** You are the author's agent. Make the smallest fix yourself, re-run the checks, and run `git diff --shortstat <base>`. If review grew the diff, cut first.
- **Review only, or a pasted diff.** Change nothing. Give the fix per finding in the report.

Update the ledger after every answer.

## 5. Next round or stop

Start another round only when budget remains and one of these holds: a blocker or should is open, behaviour code changed, or the last approval does not cover the current diff.

Stop when one of these holds:

- **Approved.** The reviewer said APPROVE on the current diff, no blocker or should is open, and you have no concern of your own.
- **Disputed.** A finding is still open after two replies. Set it to `needs-human`.
- **Budget end.** The rounds are spent and a blocker or should is open. Budget end is not approval.
- **Nothing to fix here.** Review only, or a pasted diff, and blockers or shoulds are open. The verdict is `changes requested`, not approved.

For a dispute or a budget end, show both sides in 2 or 3 lines each. The human decides. Inside a unit, settle as needs a decision through `cstack:settle`, with both sides in the comment.

## 6. Mark the PR

Only when the loop is approved, add this line to the PR body, directly above the `Created with <model> in cstack.` line:

```
Reviewed with review-loop: <N> rounds with <model>. Verdict: approved
```

`<N>` is the number of rounds run. `<model>` is the reviewer model. Edit the body with `gh pr edit <n> --body-file <file>`. Do not post a comment for this. Never add the line for a loop that ended any other way.

## Report

Rounds run and the budget (3, or 5 with the reason for the extension, for example an auth or data-loss change), the reviewer model (and any substitution), what the review changed, the diff size before and after, each finding with its id, severity and outcome, the reasons for every declined or disputed finding, usage per round (or `not exposed`), and the verdict: `approved`, `changes requested`, `needs-human`, or `budget end`. Log the stop with `cstack:show-me-your-work`.
