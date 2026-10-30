# ADR-013: GitLab spike results (forge phase F0)

Date: 2026-10-30. glab 1.126.0 against gitlab.com, on the private project `trademark/cstack-testbed` (id 88277300), which uses shared runners and the free tier. Plan: "cstack on any forge (GitHub, GitLab, plain git)", decided by Monty on 2026-10-30:
- a GitLab testbed;
- plain git with any remote or none, with other forges later on request;
- GitHub's merge behaviour kept wherever it needs no change.

## Decision

cstack gets one forge layer with three backends: `github` (today's `gh` calls), `gitlab` (`glab api`, REST v4) and `local` (plain git). GitLab exposes every capability cstack's gates rely on, with the mappings below. Merge commits stay the merge style on every forge, because GitLab's default `merge_method` is `merge`.

## Measurements

Evidence: `/tmp/f0/probe.mjs` and its log, a throwaway script run once against the testbed. MR !1 merged; MRs !2 and !3 and issue #1 were closed.

| # | Capability | GitLab result | GitHub counterpart |
|---|---|---|---|
| 1 | Auth and identity | `glab api user` returns `username` and `bot`. Auth stays in glab's own config. | `gh api user` |
| 2 | Create and view an MR | `POST projects/:id/merge_requests` returns `iid`, `state` (`opened`, `merged`, `closed`), `draft`, `sha` (head), `diff_refs.base_sha`, `merge_commit_sha`, `detailed_merge_status`, `has_conflicts`, `blocking_discussions_resolved`, `head_pipeline`, `web_url` | `pr view --json …` |
| 3 | Merge state | `detailed_merge_status` moves `preparing` → `checking` → `mergeable` within about 10 s of creation; a conflicting MR becomes `conflict`, with `has_conflicts: true` | `mergeStateStatus`: CLEAN, DIRTY |
| 4 | Behind its base | **Not a merge state.** An MR two commits behind `main` stays `mergeable`, because GitLab merges with a merge commit. `?include_diverged_commits_count=true` gives `diverged_commits_count`. `repository/compare?from=<head>&to=<base>&straight=true` lists the commits and files. | `mergeStateStatus: BEHIND`, `compare` with `behind_by` |
| 5 | Exact-SHA merge | `PUT …/merge_requests/:iid/merge` with `sha=<head>` merges and returns `merge_commit_sha`. With a stale SHA it returns **HTTP 409**, "SHA does not match HEAD of source branch". | `pr merge --match-head-commit` |
| 6 | Pipelines and jobs | `pipelines?sha=<sha>` returns `status` (`success`, `failed`, `canceled`, `skipped`, `running`); `pipelines/:id/jobs` returns `name`, `status`, `allow_failure`, `id`; `repository/commits/:sha/statuses` gives one status per job name | check-runs and `pr checks` |
| 7 | CI logs | `jobs/:id/trace` is plain text with ANSI colour codes and GitLab `section_start`/`section_end` markers. Strip both before taking log tails. | Actions job logs |
| 8 | Rerun | `POST jobs/:id/retry` returns a new job id, `running` | `run rerun --failed` |
| 9 | Approvals | `…/approvals` on the free tier: `approvals_required: 0`, `approved: true`. Approvals cannot be required, so cstack's own ledger verdict stays the gate. | `reviewDecision` |
| 10 | Threads | `POST …/discussions` creates a resolvable thread; `PUT …/discussions/:id` with `resolved=true` resolves it. With project defaults, an open thread does **not** block a merge (`blocking_discussions_resolved` stays true), so cstack checks for open threads itself. | `reviewThreads.isResolved` |
| 11 | Merge settings | Project: `merge_method=merge`, `only_allow_merge_if_pipeline_succeeds=false`, `only_allow_merge_if_all_discussions_are_resolved=false`. Protected branch `main`: push and merge for Maintainers (40). | rulesets and protection |
| 12 | Labels and issues | `POST labels`; issues take `labels`, and `PUT` takes `add_labels` and `remove_labels` in one call; notes post comments. `issues?search=X&in=description` searches bodies. An issue's `web_url` is `/-/work_items/<iid>`, not `/-/issues/`. | `issue edit --add-label/--remove-label`, `in:body` search |
| 13 | Files in an MR | `…/merge_requests/:iid/changes` gives `changes[].new_path` | `files[].path` |
| 14 | Pushing from this host | glab's config had `ssh_host: github.com` for gitlab.com, so pushes use HTTPS with `credential.helper='!glab auth git-credential'` | gh's git protocol |

## Findings that change the plan

1. **"Behind" is computed, not read.** On GitLab, cstack's base-drift and BEHIND logic comes from `diverged_commits_count` and `compare`. The forge layer's merge-state record carries `behind: <n>` separately from `state`.
2. **Required checks have no server list.** On the free tier, `only_allow_merge_if_pipeline_succeeds` is off and nothing lists required jobs. Required checks come from config `required_checks` (job names) or, when it is empty, every non-`allow_failure` job in the head pipeline.
3. **Open threads must be checked by cstack.** GitLab merges past unresolved threads by default, so the gitlab backend lists resolvable, unresolved discussions itself, the way pr-wait reads `reviewThreads` today.
4. **The merge gate is the only merger.** The guard must also block `glab mr merge`, `glab api … merge_requests/<n>/merge` and `glab mr update --auto-merge`. The gate's own subprocess call stays outside the guard, as `gh pr merge` does now.
5. **The fixture runner needs a resettable main.** `main` is protected and force pushes are off by default. F5 enables `allow_force_push` on the testbed's `main` only, so the runner can restore `baseline`.
6. **URLs differ.** Change URLs are `/-/merge_requests/<iid>` and issue URLs `/-/work_items/<iid>`. The forge layer owns URL parsing, and nothing else parses forge URLs.

## Not measured yet

- Bot authors: no review bot is installed on the testbed, so `author.bot` was only seen as false.
- Self-hosted GitLab (`forge_host`).
- Pipelines on merged results and merge trains (paid tiers).

## F5 proof

f1 end to end, held-out grader, all within the 2 h budget. Results are in `tests/fixtures/f1-cli-ledger/results/`.

| Forge | Harness | Grader | Own e2e | Time |
|---|---|---|---|---|
| GitLab | Claude Code | 24/24 | 38/38 | 73 min |
| GitLab | Codex | 24/24 | 12/12 | 20 min |
