---
name: implement-ticket
description: "Use when a cstack unit needs one ticket implemented in its worktree (T1, REPAIR-1, CI-REPAIR-1, SYNC-1). The unit coordinator spawns one worker subagent, then decides the attempt with check-commit.mjs. The worker's own account never counts. On FAIL it routes the findings to cstack:repair."
---

<!-- Adapted from pstack skills/poteto-mode/playbooks/feature.md and playbooks/bug-fix.md @ 519d36a (MIT, Lauren Tan). -->
<!-- Based on Cardinal's coder/verifier roles. -->

# Implement one ticket

The unit coordinator runs this skill. The coordinator never edits product code. One worker subagent writes the code. The `check-commit.mjs` gate decides whether the attempt counts.

[The unit flow](../../docs/unit-flow.md) is the contract. When this skill and that file disagree, the contract wins.

## Inputs

| Input | Where it comes from |
|---|---|
| Plugin root | Two directories up from this skill's base directory |
| Repo root, store, unit id, issue `N` | The caller (`cstack:unit`) |
| Worktree | The path `gates/isolate.mjs` printed. Never create a worktree any other way. |
| Ticket id | The caller. `T<n>` comes from `<store>/intake-<unit>.json`. `REPAIR-n`, `CI-REPAIR-n` and `SYNC-n` come from the latest section of the feedback file. |
| Feedback file | `<store>/feedback-<unit>.md` |
| Config | `<worktree>/.cstack/config.json`, read with `jq` or Node. Defaults are in `templates/config.json`. |

## Steps

### 1. Skip a ticket that is already done

Progress lives in git. List the ticket trailers on the branch:

```sh
git -C <worktree> log --format='%(trailers:key=Cstack-Ticket,valueonly)' origin/<base>..HEAD
```

If the ticket id is in the list, run the gate in step 4. If the gate passes, the ticket is done. Return PASS without spawning a worker. If the gate fails, the last attempt failed before a crash. Continue at step 5 with those findings.

### 2. Read the ticket

- For `T<n>`, read the ticket from `intake.json`: title, requirement ids, `depends_on`, `target_files`. Take the requirement text from the same file.
- For a repair ticket, read the latest feedback section whose heading starts with the ticket id. It holds the task, the findings and the acceptance criteria.
- Read the classification from `intake.json` (`feature`, `bug` or `chore`). It picks the method line in the brief.
- Read the unit's lane ids with `node <root>/gates/orch.mjs --store <store> unit get <unit>`. Standalone units with no lanes have none.
- Count earlier attempts at this ticket: the feedback sections headed `## <ticket> attempt <k>`. This attempt is the highest `k`, or 1 when there is none.

Record the pre-attempt head: `git -C <worktree> rev-parse HEAD`.

### 3. Spawn one worker

Spawn exactly one `Agent`:

- `subagent_type`: `cstack-worker`, the plugin's worker agent. Claude Code lists it with the plugin prefix.
- `model`: config `models.code`. If it is `inherit`, omit `model`.
- No `isolation`. The unit worktree already isolates the work, and the worker must commit there.
- No `run_in_background`. Wait for the completion notification. Do not poll.

Write the brief with these headings. Give paths, not pasted bulk.

```
GOAL
Implement ticket <id> of issue #<N> in unit <unit>: <title>.

SCOPE
Worktree: <worktree>. Work and commit only there.
Ticket: <id>. Requirements: <R1: text>, <R2: text>.
Target files (a starting point, not a limit): <target_files>.
Lanes (graded later by a hidden suite you never see): <ids or none>.

CONTEXT
Read first: <plugin root>/skills/cstack/SKILL.md
Intake: <store>/intake-<unit>.json
Feedback: <store>/feedback-<unit>.md. Act on the latest section for <id>. <"none yet" on attempt 1>
Attempt: <k> of <limits.coder_attempts>.
Method: <one line, see below>

ACCEPTANCE
- The ticket is implemented. Behaviour outside it is unchanged.
- Code changes come with tests in the repo's own suite that drive the app's boundary.
- <test_command> passes at your final commit.
- Every commit carries the three trailers.

VERIFY
The coordinator runs this gate after you finish. Your report does not replace it.
node <plugin root>/gates/check-commit.mjs <worktree> --base origin/<base> --unit <unit> --issue <N>

FORBIDDEN
Hidden paths (never read, list or edit): <paths_hidden>.
Off-limits paths (never edit): <paths_off_limits>.
No push, no PR, no merge of a PR, no rebase, no amend of earlier commits, no reset.

REPORT
Commits made (sha, subject). What changed and why, in three lines or fewer.
The last test command output you observed (tail only). Anything you could not do.
```

Method line by classification:

- **feature.** Name the data shape first and choose its structure per the Model the Domain principle. Make the smallest change that delivers the ticket. Commit in small verified steps per the Sequence Verifiable Units principle.
- **bug.** Reproduce the bug first with a failing boundary test (`cstack:tdd`). Every shipped line traces to that evidence. Fix the root cause, not the symptom. The repro must pass after the fix.
- **chore.** Make the change. Documentation-only work needs no tests. Do not add tests that only assert document strings.
- **repair tickets.** Resolve every finding in the latest feedback section without regressing earlier work.

### 4. Run the gate yourself

The worker's claims never count (non-negotiable 1). Run the gate on the worktree:

```sh
node <root>/gates/check-commit.mjs <worktree> --base origin/<base> --unit <unit> --issue <N> --json
```

Then apply two checks the gate cannot make, because it sees the whole branch and not this ticket:

- HEAD moved since the pre-attempt head. If not, add the finding `no change: the attempt made no commit`.
- A commit after the pre-attempt head carries `Cstack-Ticket: <id>`. If not, add the finding `trailers: no commit carries Cstack-Ticket: <id>`.

The attempt passes only when the gate exits 0 and both checks hold. Exit 2 is a usage error in your call. Fix the call and rerun. It is not an attempt.

### 5. Record and route

Log one row per gate result with `cstack:show-me-your-work` in `<store>/decisions.tsv`. Evidence is the HEAD SHA and the gate name.

- **PASS.** Return PASS with the HEAD SHA to the caller. The caller takes the next ticket in dependency order, or moves to verify.
- **FAIL.** Run `cstack:repair` with source `check-commit`, the ticket id, the attempt number and the gate's findings (`check: detail` each). Repair appends the feedback section and returns one of two answers:
  - `retry`. Go back to step 2 for the same ticket with a fresh worker. The brief carries the new feedback section.
  - `exhausted <kind>`. Return the failure kind to the caller (`tests_failed`, `no_change` or `base_conflict`). Keep the worktree as it is.

## Rules

- One worker per attempt. Never two writers in one worktree.
- Never fix the code yourself to make the gate pass. Route every finding through `cstack:repair`.
- Review the worker's diff (`git -C <worktree> diff <pre-attempt head>..HEAD --stat`) before you summarize it. Write your own summary.
- A new commit voids any earlier verdict for this unit. Verify runs again before publish.
