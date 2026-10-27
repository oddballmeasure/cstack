---
name: sync-base
description: "Use when a cstack unit must bring its branch up to date with the base branch (unit stage 7): after verify passes, or when the PR reports DIRTY, BEHIND or base commits touching its files. Runs gates/sync-base.mjs and routes up-to-date, merged and conflict outcomes."
---

<!-- "Resolve by current intent" guidance adapted from tstack skills/modernize/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Sync base

This is stage 7 of the unit flow (`docs/unit-flow.md`). The unit coordinator runs it. It never resolves conflicts itself. A SYNC ticket does.

`<root>` is the plugin root, two directories up from this skill's base directory. Read `base_branch` and `limits.base_sync_rounds` from `.cstack/config.json` with `jq`.

## Run the gate

```bash
node <root>/gates/sync-base.mjs <worktree> --json
```

The script refuses a dirty worktree (exit 2). A dirty tree here means an implementer left work uncommitted. That is a stage 5 failure, not a sync problem. Return to `cstack:unit`.

Read `outcome` from the JSON.

| Outcome | Exit | Next |
|---|---|---|
| `up-to-date` | 0 | Stage 8, publish. |
| `merged` | 0 | The merge commit is a new HEAD. Re-run the stage 5 gate, then stage 6. |
| `conflict` | 1 | SYNC ticket, then stage 5 and 6. |
| fetch or merge error | 2 | Failure kind `git`. |

## On `merged`

The old verdict is void because HEAD changed. Run the commit gate on the new HEAD:

```bash
node <root>/gates/check-commit.mjs <worktree> --base origin/<base_branch> --unit <unit> --issue <N>
```

- Pass. Go to stage 6, `cstack:verify-head`, on the new HEAD. Then come back here. The second sync normally reports `up-to-date`.
- Fail. The base change broke this branch. Run `cstack:repair` with source `sync` and the gate findings verbatim. It counts as a sync round.

## On `conflict`

The merge stays in progress. Conflict markers stay in the tree. The JSON lists the conflicted files.

1. List the base commits that touched them: `git -C <worktree> log --oneline HEAD..MERGE_HEAD -- <files>`.
2. Run `cstack:repair` with source `sync`, the conflicted files, those commits, and the resolution guidance below. It counts against `limits.base_sync_rounds`.
3. `retry SYNC-<n>`: the implementer resolves the markers and completes the merge commit with the unit trailers. The unit goes to stage 5's gate, then stage 6, then back here.
4. `exhausted base_conflict`: the unit fails. Leave the merge in progress so a human can inspect it.

## Resolve by current intent

Put this guidance in the SYNC ticket brief.

- A clean merge does not prove the change still belongs. Read what changed on the base since the branch diverged, not only the conflicting lines.
- Resolve each conflict by the issue's intent and the base branch's newer invariants. Keep both sides' behaviour where they do not compete.
- Check whether the base already solved the same problem, moved or deleted the code being changed, or changed an API, type or schema the branch relies on.
- Do not restore behaviour the base removed on purpose. Do not create two ways to do the same thing.
- If a conflict shows a product or architecture disagreement, stop. Do not guess. Report it, and the unit settles as needs a decision.

## Log

Write one row in `<store>/decisions.tsv` per sync (`cstack:show-me-your-work`): the outcome, the base SHA merged, conflicted files if any, and the next stage.
