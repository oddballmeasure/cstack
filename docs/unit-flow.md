# Unit flow (contract for Phase 3 skills)

A **unit** is one piece of work that ends as one PR. `cstack:unit` drives it. This file is the contract every unit-path skill follows. When a skill and this file disagree, this file wins. Fix the skill.

## Names and places

| Thing | Value |
|---|---|
| Plugin root | Two directories up from any skill's base directory. Gates are `<plugin root>/gates/*.mjs`. Run them with `node`. |
| Run slug | Standalone issue: `issue-<N>`. Under orchestrate: the program slug. |
| Run store | `<repo root>/.cstack/runs/<slug>/` (gitignored). Use `node <root>/gates/orch.mjs --store <repo root>/.cstack/runs/<slug> ...`. Always pass `--store` with an absolute path. |
| Unit id | Standalone: `U1`. Under orchestrate: the id in `units.tsv`. |
| Branch | `cstack/<N>-<slug>`, where `<slug>` is the issue title lowercased, non-alphanumerics to `-`, at most 40 chars. |
| Worktree | `~/.local/state/cstack/worktrees/<owner>-<repo>/<branch with / replaced by ->`. Create it only with `gates/isolate.mjs`. |
| Intake | `<store>/intake-<unit>.json` (one per unit, so a program store can hold many). Format: header of `gates/check-intake.mjs`, example in `templates/intake.json`. |
| Verdict | `<store>/verdict-<unit>-<sha12>.json`. Format: header of `gates/check-verdict.mjs`. |
| Review ledger | `<store>/review-<unit>-rounds.tsv` and `<store>/review-<unit>.tsv`, kept by `cstack:review-loop`. |
| Feedback | `<store>/feedback-<unit>.md`. Append-only. The latest section is what the implementer must act on. |
| Decision log | `<store>/decisions.tsv` via `cstack:show-me-your-work`. One row per stage transition and per failed gate. |
| Run record | `<store>/run.json`, written by `cstack:program`, `cstack:full-send` or `cstack:full-stop`. Per-run `autonomy` and `parallel`. Read them with `gates/run-settings.mjs --store <store>` (ADR-006). |

## Commit trailers

Every implementer commit carries:

```
Cstack-Unit: <unit id>
Cstack-Ticket: <ticket id>        (T1, REPAIR-1, CI-REPAIR-1, SYNC-1)
Refs: #<issue>
```

`check-commit.mjs --unit <id> --issue <N>` enforces `Cstack-Unit` and `Refs`. A ticket is done when its `Cstack-Ticket` trailer is on the branch AND `check-commit.mjs` passes at HEAD. A failed attempt also leaves its trailer behind, so the trailer alone is not enough. On resume, always run `check-commit.mjs` at HEAD first (a pass is cached by tree hash, so this is cheap), then skip the tickets that are done. Progress lives in git.

## Stages

Each stage names the skill that owns it, the gate that decides it, and where it goes next. Limits come from config `limits`.

| # | Stage | Owner skill | Gate | Pass → | Fail → |
|---|---|---|---|---|---|
| 0 | Preflight | `cstack:doctor` | `doctor.sh` | 1 | stop, failure `setup` |
| 1 | Claim | `cstack:settle` | `gates/settle.mjs --state in-progress` | 2 | stop, failure `github` |
| 2 | Isolate | `cstack:unit` | `isolate.mjs` | 3 | failure `git` |
| 3 | Profile | `cstack:profile-repo` | profile covers all tracked files | 4 | stop, failure `setup` |
| 4 | Intake | `cstack:intake` | `check-intake.mjs` (one corrective retry) | 5 if feature/bug/chore | settle `needs-human` (question, needs_human, reject) or failure `invalid_output` |
| 5 | Implement | `cstack:implement-ticket`, one ticket at a time in dependency order | `check-commit.mjs` | next ticket, then 6 | `cstack:repair` up to `coder_attempts` per ticket, then failure `tests_failed` or `no_change` |
| 6 | Verify | `cstack:verify-head` | `check-verdict.mjs`, recorded with `orch ledger record` | 7 | REPAIR ticket → 5, up to `verify_rounds`, then failure `verification` |
| 7 | Sync | `cstack:sync-base` | `gates/sync-base.mjs` | 8 (unchanged), or re-run 5's gate then 6 (merged) | conflict → SYNC ticket → 5, up to `base_sync_rounds`, then failure `base_conflict` |
| 8 | Publish | `cstack:unit` | `gates/publish.mjs` (remote SHA equals verified SHA) | 9 | failure `git` |
| 9 | PR | `cstack:file-pr` | PR exists for the branch, body starts `Closes #N` | 10 | failure `github` |
| 10 | Babysit | `cstack:babysit-pr` | `pr-wait.mjs --until green` under Monitor | 10b | failed check → `gates/ci-log.mjs` → CI-REPAIR ticket → 5, up to `ci_repair_rounds`, then failure `ci_failed`. DIRTY → 7. |
| 10b | Review (sub-step of 10, once per new head; skipped for docs-only diffs) | `cstack:review-loop` | ledger: an `APPROVE` round at HEAD, no open blocker or should | 11 | agreed finding → REPAIR ticket (`cstack:repair` source `review`) → 5, up to `review_rounds` rounds (5 for security, auth, data loss, concurrency). Dispute after two replies or budget end → settle `needs-human`. |
| 11 | Merge gate | `cstack:merge-gate` | `check-merge.mjs` (`--merge` merges only under the run's effective autonomy `send`, from config and `<store>/run.json` per ADR-006; also requires a review-loop APPROVE round at HEAD and no open blocker or should, unless the diff is docs-only, or unit `E2E` touches only `paths_hidden` and the config) | 12 | head moved → 6, base moved → 7, else failure `pr_violation` |
| 12 | Settle | `cstack:settle` | `gates/settle.mjs` | done | |

After any new commit, the old verdict is void. Stage 6 must run again before 8.

Isolate runs before profile and intake, so explorers and planners read code only in the sparse worktree, where the hidden suite is not on disk.

## Subagents

| Role | Agent | Model (config `models`) | Where |
|---|---|---|---|
| Implementer | `cstack-worker` | `code` | inside the unit worktree; it never sees the hidden suite |
| Verifier | `cstack-verifier` | `judge` | same worktree, read-only; it never wrote this code |
| Explorer | `cstack-explorer` | `gather` | read-only, for profile and how |
| Reviewer | `cstack-reviewer` | `review`, never the same model as `code` | read-only, fresh per round, step 10b (`cstack:review-loop`) and `cstack:council` |

The unit skill is the coordinator. It never edits product code itself. Every implementer and verifier brief includes: the absolute path of the `cstack` mode skill (read it first), the worktree path, the ticket or unit, requirement ids and text, lane ids, the feedback file path, and the exact gate the work must pass.

## Failure kinds

`invalid_output`, `tests_failed`, `no_change`, `verification`, `ci_failed`, `ci_timeout`, `base_conflict`, `pr_violation`, `git`, `github`, `setup`, `usage_limit`, `crash`.

On failure: settle `error` with the comment `cstack stopped at <stage> (<kind>): <one line>`. Write the line to `<store>/failure-<unit>.txt` and push it: `node gates/orch.mjs --store <store> inbox push unit <id> error --report <store>/failure-<unit>.txt`. Keep the worktree for inspection.

## Outcomes

| Outcome | Label | Comment prefix |
|---|---|---|
| merged | `done` | `cstack resolved this in` |
| merge-ready (autonomy stop) | `in-progress` (unchanged) | `cstack: ready to merge` |
| needs a decision | `needs-human` | `cstack needs a decision before continuing` |
| not taken | `needs-human` | `cstack is not taking this issue:` |
| failed | `error` | `cstack stopped at` |

Every comment and PR body ends with the badge line from `templates/footer.md`. Replies on PR threads also start with the callout header from `cstack:leaving-pr-comments`.

## Scripts this flow adds (Phase 3)

| Script | Purpose |
|---|---|
| `gates/settle.mjs <issue> --state <state> [--comment-file f]` | One state label on the issue. Posts the comment unless a comment with the same first line already exists. |
| `gates/sync-base.mjs <worktree>` | Fetch, then merge `origin/<base>` with `--no-ff`. Reports `up-to-date`, `merged`, or `conflict` with the conflicted files. Conflict markers stay in the tree for the SYNC ticket. |
| `gates/publish.mjs <worktree>` | Push with `--force-with-lease` pinned to the observed remote head, then confirm the remote SHA equals local HEAD. |
| `gates/ci-log.mjs <pr>` | Failed required or other checks on the PR head with a bounded log tail each (Actions job logs, else the check's output summary). |
| `gates/profile-diff.mjs <repo> [--write]` | Tracked files whose sha256 changed against `.cstack/profile.json`. |

## Under orchestrate (Phase 5)

`cstack:orchestrate` runs many units from one store. Level A runs `cstack:unit` in the coordinator session. Level B runs each unit as a detached worker, `gates/worker.mjs launch`, under `systemd-run --user` as `cstack-<repo name>-<slug>-<unit>`.

| Thing | Contract |
|---|---|
| Worker prompt | `/cstack:unit <N> --run <slug> --unit <id>`, with `CSTACK_RUN` and `CSTACK_UNIT` set, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CSTACK_COORDINATOR` unset, an explicit PATH, `--strict-mcp-config`. |
| Worker files | `<store>/workers/<unit>.{jsonl,stderr.log,launches,exit.txt,not-before}` (header of `gates/lib/workers.mjs`). |
| Exit entry | systemd `ExecStopPost` runs `worker.mjs exit`, which pushes one inbox entry from agent `worker` with status `setup`, the unit's settled state, `usage_limit`, `denied` (the allowlist refused calls; `workers/<unit>.denied.txt`), or `crash`. It runs after SIGKILL too. |
| Usage limit | `worker.mjs exit` sets the unit back to `ready` and writes `not-before` from "resets <time>" in the output (else one hour). `worker.mjs next` defers the unit until then. |
| Standing orders | The unit reads `orch standing show` at stage 1 and carries each line into its briefs. |
| Merge SHA | After a merge, stage 12 sets the unit's `sha` column to the merge commit. `gates/post-merge.mjs` judges that commit's checks. |
| Waiting | The coordinator waits under the Monitor tool on `gates/inbox-wait.mjs`, which holds `<store>/watchers/<pid>`. The `pending-work` Stop hook blocks a coordinator (`CSTACK_COORDINATOR=1`, `CSTACK_RUN=<slug>`) from ending its turn while units are in flight and no watcher is alive. |
