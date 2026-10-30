---
name: scout
description: "Find small, verifiable work in this repo and propose it as GitHub issues: a planner splits the repo into areas, a scout surveys each, an independent reviewer re-derives every proposal from the code, and a repro writes one failing test for each confirmed bug. Code checks every quote and path, and a per-category autonomy gate decides proposed or ready. Use for /cstack:scout."
argument-hint: "[--dry-run]"
disable-model-invocation: true
---

<!-- Adapted from Cardinal src/cardinal/scout/once.py and skills/scout*/SKILL.md (oddballmeasure/cardinal, same owner). -->

# Scout

Rules decide what is filed. Models find and argue. A planner splits the repo into areas. One scout reads one area at a time. A reviewer who did not write the proposal re-derives it from the code. A repro proves each confirmed bug with a test that fails on the base branch. Gates check every quote and path, drop duplicates, cap the pass, and file the issue. Filed issues carry `<prefix>:proposed`, which no cstack run picks up until a person swaps it for `<prefix>:ready`.

Read the [cstack mode skill](../cstack/SKILL.md) first.

## Names

| Name | Value |
|---|---|
| `<root>` | The plugin root, two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<store>` | `<repo>/.cstack/runs/scout`, absolute. It keeps `areas.tsv`, `ledger.tsv`, `held/` and one directory per pass. |
| `<pass>` | `scout-<UTC yyyymmdd-hhmm>`. `<pass dir>` is `<store>/<pass>`. |
| `<wt>` | `~/.local/state/cstack/worktrees/<owner>-<name>/cstack-scout-<pass>`, absolute. |
| `<check>` | `node <root>/gates/scout-check.mjs` |
| `<gate>` | `node <root>/gates/scout-gate.mjs` |
| `<log>` | `node <root>/skills/show-me-your-work/scripts/log.mjs <pass dir>/decisions.tsv` |

Settings come from config `scout` (defaults in `templates/config.json`): `autonomy` (`propose` or `auto`), `categories`, `areas_per_pass`, `cooldown_days`, `max_proposals_per_pass`, `max_files`, `repro`, and the `auto_min_*` bars.

## Roles

| Role | Agent | Model (config `models`) | Brief |
|---|---|---|---|
| Planner | `Explore`, read-only | `gather` | [planner](references/planner.md) |
| Scout, one per area | `Explore`, read-only | `review` | [survey](references/survey.md) |
| Reviewer, fresh per proposal | `Explore`, read-only | `judge`, never the scout's model | [reviewer](references/reviewer.md) |
| Repro, one per confirmed bug | `general-purpose` | `code` | [repro](references/repro.md) |

Every brief names `<wt>` (or the repro worktree) as the only place to read, lists `paths_hidden` and `paths_off_limits` under FORBIDDEN, and puts this file's mode skill path in CONTEXT. After each read-only agent, run `git -C <wt> status --short` and expect nothing.

## Procedure

1. **Preflight.** Run `node <root>/skills/doctor/scripts/doctor.mjs <repo>`. On a FAIL, stop. Then `git -C <repo> fetch -q origin`.
2. **Outcomes.** Run `<gate> record --repo-dir <repo> --json`. It reads every issue the scout filed in the last 60 days and gives each category's track record and gate. For each issue in `rejected`, read its last comment (`node <root>/gates/forge.mjs issue view <n> --json`, the last entry of `comments`). Write `<pass dir>/rejections.json` as `[{"number", "title", "reason"}]`. Write `<pass dir>/issues.json` from `node <root>/gates/forge.mjs issue list --state all --limit 300 --json`.
3. **Isolate.** `node <root>/gates/isolate.mjs <repo> cstack/scout-<pass> <wt> --base origin/<base_branch>`. Every agent reads only `<wt>`, where the hidden suite is not on disk.
4. **Held proposals first.** For each `<store>/held/*.json`, run step 9 on it. They count toward this pass's cap.
5. **Plan.** Launch the planner. It writes `<pass dir>/plan.json`. Gate: `<check> plan <pass dir>/plan.json --repo-dir <wt>`. On a rejection, send the FAIL lines back once, in a fresh planner brief. A second rejection ends the pass with failure `invalid_output`.
6. **Choose.** `<gate> choose <pass dir>/plan.json --store <store> --json`. Survey only the `areas` it returns: never-surveyed first, nothing inside the cooldown, at most `areas_per_pass`.
7. **Survey.** Launch one scout per chosen area, all in one message. Each writes `<pass dir>/area-<i>.json` with at most 5 proposals. When a scout finishes, run `<gate> mark <pass dir>/plan.json --store <store> --area "<name>"`. A failed scout does not stop the others. Then `<check> proposals <pass dir>/area-<i>.json --repo-dir <wt> --out <pass dir>/kept-<i>.json`. It drops every proposal with a quote not in its file, an untracked or off-limits path, more than `max_files` files, or an acceptance criterion with no exact value, and corrects line ranges that drifted by up to 10 lines.
8. **Review and repro.** For each kept proposal, launch a fresh reviewer. It writes `<pass dir>/review-<fingerprint>.json`: `{"verdict", "reason", "category"?, "evidence"?}`. When the verdict is `confirmed`, the category is `bug` or `regression`, `scout.repro` is true and the files are not all docs:
   1. `node <root>/gates/isolate.mjs <repo> cstack/scout-repro-<pass>-<n> <repro wt> --base origin/<base_branch>`.
   2. Launch the repro agent in `<repro wt>`. It writes one test and does not commit.
   3. Gate: `<check> repro <repro wt> --test-name "<name it reports>" --out <pass dir>/repro-<fingerprint>.diff --json`. `ok` keeps the diff. `refuted` means the test passes on the base branch: log it and drop the proposal. `invalid` means no proof either way: file without the diff.
   4. Remove the repro worktree: `git -C <repo> worktree remove --force <repro wt>` and `git -C <repo> branch -D cstack/scout-repro-<pass>-<n>`.
9. **File.** Write `<pass dir>/bundle-<fingerprint>.json`: `{"proposal": <the kept proposal>, "review": <the review>, "repro_diff": "<diff path, or omit>"}`. Then:
   ```sh
   <gate> file <bundle> --store <store> --pass <pass> --json
   ```
   Add `--dry-run` when the user passed it. The gate drops what the reviewer did not confirm (`product_decision` files as `<prefix>:needs-human`), re-checks the reviewer's evidence, drops duplicates, holds the proposal for the next pass once `max_proposals_per_pass` are filed, writes the body (Problem, Evidence, Expected, Acceptance, Files, Suggested test, footer), and picks the label. `<prefix>:ready` needs `scout.autonomy` `auto` and the category's track record over every bar, and for a bug or regression a repro diff.
10. **Clean up.** `git -C <repo> worktree remove --force <wt>` and `git -C <repo> branch -D cstack/scout-<pass>`. Leave `<store>` intact.

Never file, label or comment on a scout issue yourself. Only `scout-gate.mjs file` files, so every issue has checked evidence and a label the gate chose.

## Approval and the track record

A person approves a proposal by swapping `<prefix>:proposed` for `<prefix>:ready`, and rejects it by closing it with a comment. The next pass reads both: rejections go to every scout as `rejections.json`, and approvals count toward the category's track record. An issue the gate filed ready on its own never counts as an approval. A category goes ready by itself only while every bar holds, so a falling rate puts it back to propose-only.

## Report

- The track record line per category from step 2, with its gate.
- Areas surveyed and skipped.
- One line per proposal: title, category, action (`filed #N <label>`, `held`, `duplicate`, `dropped: <reason>`, `refuted`).
- Anything that needs a person: a `filing` row (an interrupted filing), a failed survey, or a plan that failed twice.
