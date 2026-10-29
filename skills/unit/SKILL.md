---
name: unit
description: "Use when the user asks cstack to work one GitHub issue end to end, or when the cstack orchestrator hands it a unit. Coordinates the 13 unit stages from preflight to settle: claim, profile, intake, isolate, implement, verify, sync, publish, PR, babysit, merge gate. Subagents write and verify the code. Gates decide every stage. Invoke as /cstack:unit <issue-number>, or with --run <slug> --unit <id> under orchestrate."
argument-hint: "<issue-number> [--run <slug> --unit <id>]"
---

<!-- Stay-active rule and final report adapted from tstack skills/full-send/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Unit

A unit is one piece of work that ends as one PR. This skill is its coordinator. It follows `docs/unit-flow.md` in the plugin root. When this file and that contract disagree, the contract wins.

Read the cstack mode skill first: `<root>/skills/cstack/SKILL.md`.

## Rules

- **You never edit product code.** Implementers and verifiers are subagents. You run gates, write briefs, feedback, PR bodies and comments, and keep the run store.
- **Gates decide.** A subagent's report is a model claim. Move to the next stage only on a gate's exit code and output that you observed.
- **Do not end your turn while work is pending.** While a subagent runs, wait for its notification. While the PR is pending, stay on the Monitor until pr-wait exits. If you end the turn early, nobody wakes you and the unit stops.
- **A new commit voids the verdict.** Stage 6 runs again on the new HEAD before stage 8.
- **Bound every loop** with config `limits`. Hitting a limit is a classified failure.
- **Hard stops** from the mode skill apply. Never force-push a branch other than this unit's branch, never close a PR, never merge outside `cstack:merge-gate`.

## Names

Shell variables do not persist between Bash calls. Resolve each name once, then write the absolute value into every command.

| Name | Value |
|---|---|
| `<root>` | The plugin root: two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<N>` | The issue number. |
| `<slug>` | Standalone: `issue-<N>`. Under orchestrate: the `--run` slug. |
| `<unit>` | Standalone: `U1`. Under orchestrate: the `--unit` id. |
| `<store>` | `<repo>/.cstack/runs/<slug>` (absolute). |
| `<orch>` | `node <root>/gates/orch.mjs --store <store>` |
| `<log>` | `node <root>/skills/show-me-your-work/scripts/log.mjs <store>/decisions.tsv` |
| `<branch>` | `cstack/<N>-<title slug>`. Compute the slug with `node -e 'console.log(process.argv[1].toLowerCase().replace(/[^a-z0-9]/g,"-").slice(0,40))' "<issue title>"`. |
| `<wt>` | `~/.local/state/cstack/worktrees/<owner>-<name>/<branch with / replaced by ->`, expanded to an absolute path. |
| `<base>` | `origin/<base_branch>` from config. |

Read config with `jq` from `<repo>/.cstack/config.json`. Without a config, stop. Ask the human to run `/cstack:setup-cstack`.

## Stage list

Create this TodoWrite list at the start, one item per stage, verbatim:

```
0 Preflight
1 Claim
2 Isolate
3 Profile
4 Intake
5 Implement
6 Verify
7 Sync
8 Publish
9 PR
10 Babysit
10b Review
11 Merge gate
12 Settle
```

Mark a stage `in_progress` when you start it and `completed` when its gate passes. Mark a skipped stage completed and rename it `<n> <Stage> (skip: <reason>)`, for example `3 Profile (skip: profile current)`. When a back edge sends the unit to an earlier stage, set that stage and every later one back to `pending`.

## Decision log

Keep `<store>/decisions.tsv` with `cstack:show-me-your-work`. Write one row per stage transition and one per failed gate:

```bash
<log> "<n> <Stage>" "<what you did or chose>" "<why>" "<evidence: gate output line, SHA, PR, file>" "<pass|fail|skip|back to <n>>"
```

If the log already has rows from another run, write a `start` row first, as `cstack:show-me-your-work` describes.

## Resume

Before stage 0, check whether this unit already ran. It ran if `<store>/units.tsv` lists `<unit>`, or `<branch>` exists locally or on origin.

1. Read `<orch> unit get <unit>`, `<orch> ledger summary`, and the last rows of `<store>/decisions.tsv`.
2. Read the tickets done on the branch: `git -C <wt> log <base>..HEAD --format='%(trailers:key=Cstack-Ticket,valueonly)'`. A ticket whose `Cstack-Ticket` trailer is on the branch is done. Skip it.
3. Never redo a passed gate unless HEAD changed since it passed:
   - Stage 6 passed if `<orch> ledger check <unit> $(git -C <wt> rev-parse HEAD)` exits 0.
   - Stage 8 passed if `git -C <wt> ls-remote origin refs/heads/<branch>` shows HEAD.
   - Stage 9 passed if `cstack:file-pr`'s gate query finds the PR.
   - Step 10b passed if `<store>/review-<unit>-rounds.tsv` has an `APPROVE` round at HEAD and `<store>/review-<unit>.tsv` has no `open` blocker or should.
4. Re-run the stage 5 gate on HEAD once before you trust step 2. A failed attempt can leave a commit with a trailer. If the gate fails, the newest ticket is not done.
5. Resume at the first stage whose gate has not passed for the current HEAD. Mark the earlier stages completed in the TodoWrite list.

## Procedure

### 0 Preflight

Owner: `cstack:doctor`. Gate:

```bash
node <root>/skills/doctor/scripts/doctor.mjs <repo>
```

Pass (exit 0): stage 1. Fail: stop with failure `setup`. Report the FAIL lines.

### 1 Claim

Owner: `cstack:settle`.

1. Standalone and no store yet: `<orch> init`, then `<orch> unit add <unit> --track issue --issue <N> --state ready`.
2. Under orchestrate: confirm `<orch> unit get <unit>` exists and names issue `<N>`. Read `<orch> standing show` and obey every line. Put each line in every worker and verifier brief under FORBIDDEN or CONTEXT.
3. Gate: `node <root>/gates/settle.mjs <N> --state in-progress --repo-dir <repo>`. Then `<orch> unit set <unit> --state in-progress`.

Pass: stage 2. Fail: stop with failure `github`.

### 2 Isolate

Owner: this skill. If `<wt>` exists and is on `<branch>`, skip (`skip: worktree exists`). Otherwise:

```bash
node <root>/gates/isolate.mjs <repo> <branch> <wt>
<orch> unit set <unit> --branch <branch>
```

Pass: stage 3. Fail: failure `git`.

Isolate comes before profile and intake on purpose. Every explorer and planner from here on reads code only inside `<wt>`, where the hidden suite is not on disk. The main checkout still holds it.

### 3 Profile

Owner: `cstack:profile-repo`. Gate: the profile covers all tracked files.

```bash
node <root>/gates/profile-diff.mjs <repo>
```

The script always exits 0. Read its last line. `gate profile-diff: approved` means no new, changed or removed files: skip (`skip: profile current`). Otherwise run `cstack:profile-repo`, then run the gate again. Explorers read files from `<wt>`, never from `<repo>`. The profile file stays at `<repo>/.cstack/profile.json`. Pass: stage 4. Fail: stop with failure `setup`.

### 4 Intake

Owner: `cstack:intake`. It writes `<store>/intake-<unit>.json`. Gate:

```bash
node <root>/gates/check-intake.mjs <store>/intake-<unit>.json --repo <repo>
```

Run it against `<repo>` (the base checkout), not `<wt>`. On resume the branch already holds the files the intake marks `new:`, so checking the worktree would reject a correct intake. On a gate failure, give the findings back to `cstack:intake` once. A second failure is failure `invalid_output`.

Route by `classification`:

- `feature`, `bug`, `chore`: stage 5.
- `question` or `needs_human`: settle as needs a decision with the intake's question. Stop.
- `reject`: settle as not taken with the intake's summary as the reason. Stop.

### 5 Implement

Owner: `cstack:implement-ticket`, one ticket at a time in `depends_on` order from the intake. Skip each ticket whose trailer is on the branch.

For each ticket, spawn the plugin's `cstack-worker` agent with the `Agent` tool. Set `model` from config `models.code` (omit it for `inherit`). The worker works inside `<wt>`. It never sees the hidden suite. Its brief, with headings GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, FORBIDDEN, REPORT, includes:

- the absolute path of `<root>/skills/cstack/SKILL.md` (read it first) and of `<root>/skills/implement-ticket/SKILL.md`;
- the worktree path `<wt>`;
- the unit id, the ticket id and title, its target files;
- the requirement ids and text the ticket serves, and the lane ids from `units.tsv`, if any;
- the feedback file `<store>/feedback-<unit>.md` (act on its latest section);
- the trailers every commit carries: `Cstack-Unit: <unit>`, `Cstack-Ticket: <ticket>`, `Refs: #<N>`;
- the gate the work must pass, verbatim;
- FORBIDDEN: config `paths_hidden` and `paths_off_limits`, pushing, and any GitHub write.

Gate after each ticket:

```bash
node <root>/gates/check-commit.mjs <wt> --base <base> --unit <unit> --issue <N>
```

- Pass: next ticket. After the last ticket: stage 6.
- Fail: run `cstack:repair` with source `check-commit`, the ticket id, its attempt number and the gate findings. It counts against `limits.coder_attempts` per ticket. `retry <ticket>`: brief a fresh worker for the next attempt. `exhausted <kind>`: failure `<kind>` (`tests_failed`, `no_change`, or `base_conflict` for a SYNC ticket).

Loop counters live in the feedback file headings that `cstack:repair` writes, so a resume counts them the same way.

REPAIR, CI-REPAIR and SYNC tickets come back to this stage and pass the same gate.

### 6 Verify

Owner: `cstack:verify-head`. Skip if `<orch> ledger check <unit> <HEAD>` exits 0 (`skip: verified at <sha12>`).

It runs the plugin's `cstack-verifier` agent (model `models.judge`) read-only in `<wt>`. The verifier never wrote this code. It writes `<store>/verdict-<unit>-<sha12>.json`. `cstack:verify-head` runs the gate and records the ledger row. Confirm both from their output:

```bash
node <root>/gates/check-verdict.mjs <wt> --verdict <store>/verdict-<unit>-<sha12>.json --base <base> --requirements <R ids> [--lanes <lane ids>]
<orch> ledger record <unit> <HEAD> <approved|rejected> --evidence <store>/verdict-<unit>-<sha12>.json --verifier cstack-verifier
```

Pass: stage 7. Fail: `cstack:repair` with source `verify` returns `retry REPAIR-<n>` (go to stage 5) or `exhausted verification` (failure `verification`). The limit is `limits.verify_rounds`.

### 7 Sync

Owner: `cstack:sync-base`. Gate: `node <root>/gates/sync-base.mjs <wt> --json`.

- `up-to-date`: stage 8.
- `merged`: re-run the stage 5 gate, then stage 6, then sync again.
- `conflict`: `SYNC-<n>` through `cstack:repair`, then stage 5 and 6. Allow `limits.base_sync_rounds`. Past the limit: failure `base_conflict`.

### 8 Publish

Owner: this skill. First confirm the verdict is current: `<orch> ledger check <unit> <HEAD>` must exit 0. If not, go to stage 6. Then:

```bash
node <root>/gates/publish.mjs <wt>
<orch> unit set <unit> --sha <HEAD>
```

The gate passes when the remote SHA equals the verified SHA. Pass: stage 9, or stage 10 when the PR already exists. Fail: failure `git`.

### 9 PR

Owner: `cstack:file-pr`. Gate: an open PR exists for the branch, its head is the verified SHA, and its body starts `Closes #<N>`. Skip when it already exists (`skip: PR #<n> open`). Pass: stage 10. Fail: failure `github`.

### 10 Babysit

Owner: `cstack:babysit-pr`. You run it. Never a subagent. Arm the `Monitor` tool:

- command: `node <root>/gates/pr-wait.mjs <pr> --repo <config repo> --until green`
- timeout_ms: `1800000`. Re-arm on expiry.

Order: conflicts, then review threads, then CI.

- DIRTY, BEHIND, or base moved under the PR's files: stage 7.
- A real review finding on a GitHub thread: REPAIR ticket through `cstack:repair` (source `verify`), stage 5. Cap `limits.review_rounds`. Write every reply with `cstack:leaving-pr-comments`.
- A failed check: `node <root>/gates/ci-log.mjs <pr> --repo-dir <wt>`, then a `CI-REPAIR-<n>` ticket through `cstack:repair`, stage 5. Limit `limits.ci_repair_rounds`, then failure `ci_failed`. Pending past `limits.ci_timeout_seconds`: failure `ci_timeout`.
- pr-wait exits 0 and no actionable thread is left: step 10b.

After any new commit, stages 6, 7 and 8 run before you arm the Monitor again.

#### 10b Review (sub-step of 10)

Owner: `cstack:review-loop`, as `cstack:babysit-pr` step 10b describes. It runs once per new head, after pr-wait exits 0 and before the merge gate. Skip it when every changed path is documentation (`skip: docs only`), or when the ledger already holds a round at HEAD.

The reviewer is the plugin's `cstack-reviewer` agent on `models.review`, fresh each round. It must differ from `models.code`. The budget is `limits.review_rounds` rounds over the unit's life, up to 5 for security, auth, data loss or concurrency.

- Approved: stage 11. The PR body carries `Reviewed with review-loop: <N> rounds with <model>. Verdict: approved`.
- Agreed blocker or should: `cstack:repair` with source `review` returns `retry REPAIR-<n>`. Go to stage 5, then 6, 7, 8 and 10.
- A dispute open after two replies, or budget end with a blocker or should open: settle as needs a decision. Budget end is not approval.

### 11 Merge gate

Owner: `cstack:merge-gate`. Gate:

```bash
node <root>/gates/check-merge.mjs <pr> --unit <unit> --repo-dir <wt> --store <store> [--merge] --json
```

Pass `--merge` only when the run's effective autonomy is `send`: `node <root>/gates/run-settings.mjs --store <store>` prints `autonomy send`. It reads config, overridden by `<store>/run.json` (ADR-006). Never `--admin`.

- Merged (send): stage 12, outcome merged.
- Ready to merge or Waiting for required approval (stop): stage 12, outcome merge-ready.
- Head moved: stage 6. Base moved: stage 7. Otherwise: failure `pr_violation`.

### 12 Settle

Owner: `cstack:settle`. Post the outcome with `node <root>/gates/settle.mjs <N> --state <state> --comment-file <file> --repo-dir <repo>`, and set the unit state. After a merge, record the merge commit too: `<orch> unit set <unit> --state merged --sha <merge sha>`. Under orchestrate, also push the final report: `<orch> inbox push unit <unit> <unit state> --report <store>/report-<unit>.md`.

## On failure

At any stage with a failure kind:

1. Settle as failed through `cstack:settle`: label `error`, comment `cstack stopped at <stage> (<kind>): <one line>`, and the inbox entry.
2. Stop the Monitor if one runs (`TaskStop`).
3. Keep the worktree.
4. Log the failure row, then write the final report.

## Final report

Write it to `<store>/report-<unit>.md` and give it as your final message. Follow the mode skill's **Writing the reply**.

- Issue: `#<N>` and its title.
- PR: the link.
- Final head SHA.
- Verdict ledger row for that SHA (from `<orch> ledger summary`).
- Merge SHA, or the merge-gate verdict (Ready to merge, Waiting for required approval, Blocked), or the failure stage and kind.
- Proof: the PR's proof line.
- Decisions: each fork you chose for the human, from the decision log, with its evidence.
- Follow-ups filed as `<label_prefix>:proposed` issues.

If a hard stop or a question ended the run, put the question first.
