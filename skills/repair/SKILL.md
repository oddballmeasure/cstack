---
name: repair
description: "Use when a cstack unit failed a gate and the implementer must try again: check-commit findings, verifier findings, a failed CI check (ci-log.mjs tail), or a merge conflict from sync-base. Turns the failure into a feedback section or a repair ticket (REPAIR-n, CI-REPAIR-n, SYNC-n) in the feedback file, counts rounds against config limits, and returns the failure kind when the limit is spent."
---

<!-- Based on Cardinal's coder/verifier roles. -->

# Repair

The unit coordinator runs this skill after a failed gate. It writes what the implementer must act on, then says whether another round is allowed. It never edits product code.

[The unit flow](../../docs/unit-flow.md) is the contract for stages, limits and failure kinds.

## Inputs

- Store, unit id, issue `N`, base branch, worktree.
- Source: `check-commit`, `verify`, `ci` or `sync`.
- The findings: gate findings as `check: detail` lines, `gates/ci-log.mjs <pr>` output, or the conflicted file list from `gates/sync-base.mjs`.
- For `check-commit` only: the ticket id and its attempt number.

## The feedback file

`<store>/feedback-<unit>.md` is append-only. Never edit or delete a section. The latest section for a ticket is what the implementer acts on.

Each section has this shape:

```
## <heading>

Source: <check-commit | verify | ci | sync>
Head: <full HEAD sha when the gate ran>
Written: <UTC ISO8601>

<task text>

Findings:
- <one finding per line, verbatim from the gate>

Acceptance:
- <criterion>
```

Headings are exact, because rounds are counted from them:

| Source | Heading | Ticket id |
|---|---|---|
| `check-commit` | `## <ticket> attempt <k>` | unchanged (`T1`, `REPAIR-1`, ...) |
| `verify` | `## REPAIR-<n>` | `REPAIR-<n>` |
| `ci` | `## CI-REPAIR-<n>` | `CI-REPAIR-<n>` |
| `sync` | `## SYNC-<n>` | `SYNC-<n>` |

## Count the round first

Read the limit from config `limits`. Count the existing headings with `grep -cE` on the feedback file. A missing file counts as 0.

| Source | Count | Limit | Exhausted kind |
|---|---|---|---|
| `check-commit` | `^## <ticket> attempt [0-9]+$` plus 1 (attempt 1 has no section) | `coder_attempts` | see below |
| `verify` | `^## REPAIR-[0-9]+$` | `verify_rounds` | `verification` |
| `ci` | `^## CI-REPAIR-[0-9]+$` | `ci_repair_rounds` | `ci_failed` |
| `sync` | `^## SYNC-[0-9]+$` | `base_sync_rounds` | `base_conflict` |

For `check-commit`, the failed attempt is attempt `count`. If `count` is at least `coder_attempts`, the ticket is exhausted. The kind is:

- `base_conflict` when the ticket is `SYNC-n` and the findings include `conflict markers`.
- `no_change` when every finding is `non-empty diff` or `no change`.
- `tests_failed` otherwise.

For the other sources, if `count` is at least the limit, the source is exhausted. Otherwise the new ticket is number `count + 1`.

When exhausted, append nothing. Log the row (see below) and return `exhausted <kind>` with one line naming the last findings. The caller settles the failure per the contract.

## Write the section

Copy findings verbatim. Do not summarize them, soften them, or drop any. Strip nothing but trailing whitespace. A CI log tail stays as `ci-log.mjs` printed it.

### check-commit: `## <ticket> attempt <count + 1>`

Task text:

> The coordinator ran check-commit after attempt <count> and it failed. Your commits are still on the branch. Fix the findings below with new commits. Do not amend or reset.

For a conflict-marker finding, use Cardinal's line instead: "Conflict markers remain in <files>. Resolve every conflict and remove the markers."

For a `no change` finding: "The previous attempt changed no files. Implement the ticket in the worktree."

Acceptance: `Every finding is resolved`, `The repository's test command passes`.

### verify: `## REPAIR-<n>`

Title: Resolve the verifier's findings.

> The verifier rejected the branch at <sha12>. Resolve every finding below without regressing earlier work.

Findings are the `check-verdict.mjs` findings, which include the verifier's own. An e2e finding names only a lane id and a one-line reason. Pass it on as it is. Never add hidden-suite content.

Acceptance: `Every finding is resolved`, `The repository's test command passes`.

### ci: `## CI-REPAIR-<n>`

Title: Make the required CI checks pass.

> The branch passed the repository's test command here, but a CI check failed on the pushed commit <sha12>. CI differs from local: fix the cause, do not skip the test. CI runs in a different environment (often Linux, a different language build, a different clock or timezone), so look for code or tests that depend on the machine. Fix the cause shown in the log. Do not weaken or skip the failing test.

Then the `ci-log.mjs` output, one block per failed check.

Acceptance: `The failure shown in the CI log is fixed at its cause`, `The repository's test command passes`.

### sync: `## SYNC-<n>`

Title: Bring the branch up to date with <base>.

For a conflict:

> sync-base merged the latest `origin/<base>` into this branch and these files conflict: <files>. The merge is still in progress. Each conflict is marked with `<<<<<<<`, `=======` and `>>>>>>>` lines. Resolve every marker by the current intent of both sides: this branch's change and the change that landed on `<base>`. Never drop either side's behaviour silently. If both cannot hold together, do not pick one. Stop and say why in your report. Remove every marker. Change nothing else. Conclude the merge with `git commit` and the three trailers.

For a clean merge whose tests then failed:

> sync-base merged the latest `origin/<base>` into this branch without conflicts, but the repository's test command now fails. Make it pass, keeping both this branch's change and what landed on `<base>`.

Then the test output tail.

Acceptance: `Both sides' changes are kept`, `No conflict markers remain`, `The repository's test command passes`.

## Same premise, second failure

Before you append, compare the new findings with the previous section of the same kind. If a finding repeats, add this line to the task text:

> This finding survived the previous round. Two fixes on one premise failed the same gate. Apply the Attack the Premise principle before you change code.

## Log and return

Log one row with `cstack:show-me-your-work` in `<store>/decisions.tsv`. Phase is the stage (`implement`, `verify`, `babysit`, `sync`). Decision names the new heading, or `exhausted <kind>`. Evidence is the HEAD SHA and the feedback file path.

Return one of:

- `retry <ticket id>`. The caller runs `cstack:implement-ticket` for that ticket. For a new repair ticket, the caller then runs the gates that follow implement as the contract says.
- `exhausted <kind>`. The caller stops the unit with that failure kind.
