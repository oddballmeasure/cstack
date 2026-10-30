---
name: merge-gate
description: "Use when a cstack unit's PR is green and must be judged for merge (unit stage 11). Runs gates/check-merge.mjs, the only way cstack merges. Merges under autonomy send; under autonomy stop it ends with a verdict: Ready to merge, Waiting for required approval, or Blocked."
---

<!-- Verdicts adapted from tstack skills/full-stop/SKILL.md and skills/full-send/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Merge gate

This is stage 11 of the unit flow (`docs/unit-flow.md`). The unit coordinator runs it after `cstack:babysit-pr` reports green.

`<root>` is the plugin root, two directories up from this skill's base directory. Read the run's effective autonomy with `node <root>/gates/run-settings.mjs --store <store>`, not from config. It is config `autonomy`, overridden for one run by `<store>/run.json`, which `cstack:program`, `cstack:full-send` and `cstack:full-stop` write. `run.json` may always lower autonomy. It raises it to `send` only when this session has `CSTACK_PROGRAM_AUTONOMY=send` from the human's launch (ADR-006). The gate applies the same rule itself, so the two never disagree.

## The only way to merge

`gates/check-merge.mjs` is the only path to a merge. It checks, on the PR's current head:

- the PR is open and not a draft;
- the run ledger holds an approval for this unit at exactly this head SHA;
- `cstack:review-loop` recorded an APPROVE round at exactly this head and no blocker or should finding is open, unless every changed file is docs, or the unit is `E2E` and touches only `paths_hidden` and `.cstack/config.json` (a reviewer may not read the hidden suite, so `check-e2e` judges PR #0). A `review` finding sends the unit back to step 10b;
- every required check is green on this SHA;
- no review requests changes;
- GitHub's merge state is not DIRTY, BEHIND, BLOCKED or UNKNOWN;
- the base has not moved under the PR's files.

Never run `gh pr merge`, or any forge's merge command, yourself. The guard hook blocks it. Never use `--admin`, auto-merge, a merge queue, a push to the base branch, or any other bypass. Under both autonomy levels.

## Run it

Under effective autonomy `send`:

```bash
node <root>/gates/check-merge.mjs <pr> --unit <unit> --repo-dir <worktree> --store <store> --merge --json
```

Under effective autonomy `stop`, leave out `--merge`. The gate then judges only. If you pass `--merge` under stop, the gate refuses with an `autonomy` finding. That is not a failure of the PR.

## Read the result

`approved: true`:

- **send.** `merge_sha` holds the merge commit. Go to stage 12, `cstack:settle`, outcome merged.
- **stop.** The verdict is **Ready to merge**. Go to stage 12, outcome merge-ready.

`approved: false`. Route by the failing check:

| Finding | Meaning | Next |
|---|---|---|
| `ledger` | The PR head is not the verified SHA. The head moved. | Fetch it into the worktree (`git -C <worktree> fetch origin <branch>` then `git -C <worktree> merge --ff-only FETCH_HEAD`), then stage 6. |
| `base` or merge state `BEHIND`/`DIRTY` | The base moved. | Stage 7, `cstack:sync-base`. |
| `check <name>` | A required check is not green on this SHA. | Back to stage 10, `cstack:babysit-pr`. |
| `reviews` | A review requests changes. | Back to stage 10 to handle the threads. |
| merge state `UNKNOWN` | GitHub is still computing. | Run the gate again, at most twice. Then treat it as `BLOCKED`. |
| merge state `BLOCKED`, only a required human approval missing | Branch protection needs a person. | Verdict **Waiting for required approval**. |
| `pr state` closed or merged by someone else | Not cstack's merge. | Merged elsewhere: stage 12, outcome merged. Closed: failure `pr_violation`. |
| `merge` | The merge command failed and GitHub does not show it merged. | Failure `pr_violation`. Do not retry with other flags. |
| anything else | | Failure `pr_violation`. |

To confirm that only an approval is missing, read `node <root>/gates/forge.mjs change view <pr> --json`. `reviewRequired` must be true and every other check in the gate output must pass. A forge that cannot require approvals always reports false, so this case does not arise there.

Bound the back edges by the unit limits: `verify_rounds` for stage 6, `base_sync_rounds` for stage 7, `ci_repair_rounds` and `review_rounds` for stage 10.

## Verdicts under `autonomy: stop`

End the stage with exactly one verdict, and give it to `cstack:settle`:

- **Ready to merge.** The gate passes. The PR stays open and unmerged.
- **Waiting for required approval.** Only a human approval is missing. You confirmed it is the actual blocker.
- **Blocked.** Say what prevents readiness, what you tried, and what is needed. This is the failure path with kind `pr_violation`.

Before the verdict, check that nothing will merge the PR without the human: read `autoMerge` from `node <root>/gates/forge.mjs change view <pr> --json`. If auto-merge is on, say so first in the verdict. Turning it off is a human action when the guard blocks `gh pr merge --disable-auto`.

Under `autonomy: send`, **Waiting for required approval** cannot merge either. Settle it as needs a decision, with the PR link and the missing approval as the question.

## Log

Write one row in `<store>/decisions.tsv` (`cstack:show-me-your-work`) with the gate result, the head SHA, and the verdict or merge SHA.
