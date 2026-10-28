# L4 fixture programs

Whole `/cstack:program` runs against the private testbed `oddballmeasure/cstack-testbed`, graded by a held-out suite that cstack never sees (plan section 6.3).

```
node tests/fixtures/run-fixture.mjs f1-cli-ledger [--keep]
```

A run takes hours, so start it detached from your terminal:

```
systemd-run --user --unit=cstack-fixture-f1 --collect --working-directory="$PWD" node tests/fixtures/run-fixture.mjs f1-cli-ledger
journalctl --user -fu cstack-fixture-f1
```

Run one fixture at a time, and no scenario next to it. A program can use most of a 5-hour subscription window.

## A fixture

| File | Purpose |
|---|---|
| `<fixture>/guideline.md` | The idea, written as a brief with goals and end-to-end requirements. The runner copies it to a temporary directory and passes that path to the program, so the run never gets a path next to the grader. |
| `<fixture>/grader/` | The held-out suite. Test names start with `G<n>`. Only the runner runs it. |
| `<fixture>/budget.toml` | `hours` (wall time) and `max_unplanned_questions`. |
| `<fixture>/results/<date>.json` | One file per run (committed). |

## What a run does

1. Clones the testbed fresh into `tests/fixtures/results/<fixture>-<ts>/testbed` (gitignored).
2. Replaces testbed `main` with the fixture's empty project and pushes it. For f1: a Node project whose `npm test` runs `node --test 'test/**/*.test.mjs'` (one smoke test), a CI workflow with job `ci` running `npm test`, `.cstack/config.json` (autonomy `stop`, `e2e_command` null, `required_checks` `["ci"]`, `paths_hidden` `["tests/acceptance/**"]`), a `.gitignore` for `.cstack/*` except the config, and a README.
3. Launches `/cstack:program <guideline> --autonomy=send --slug <slug>` with the unattended note, as a detached headless coordinator `cstack-cstack-testbed-<slug>-coordinator` under `systemd-run`. Its environment has `CSTACK_COORDINATOR=1`, `CSTACK_RUN=<slug>` and `CSTACK_PROGRAM_AUTONOMY=send`, and no API key. The repo config says `stop`, so the run merges only because the launch raised it (ADR-006).
4. Polls `systemctl --user is-active` every 60 seconds. When `hours` runs out, it stops the coordinator and every worker of the run.
5. Checks out `origin/main` in the clone, then measures (below).
6. Teardown, unless `--keep`: stops the run's units, closes the PRs and issues created since the run started (deleting their branches), removes the clone's worktrees, and restores testbed `main` to tag `baseline-p3`.

It prints `PASS` when the grader pass rate is at least 0.95, the run stayed within `hours` and `max_unplanned_questions`, and the coordinator ran on the subscription (`apiKeySource: none`).

## Result file

| Key | Source |
|---|---|
| `grader` | `LEDGER_BIN=<clone>/bin/ledger.mjs node --test --test-reporter=tap <fixture>/grader`, run from the cstack repo. `ok` and `not ok` lines by `G<n>`. A test that never reports counts as failed. Raw TAP in `<outDir>/grader.tap`. |
| `cstack_e2e` | `gates/run-e2e.mjs <clone> --json` at `origin/main` as the grader, against every lane in the run's `e2e-plan.md`. |
| `p0_gap` | `true` when cstack's own suite is fully green and the grader is not. That is a P0 harness bug: `cstack:e2e-plan` wrote a weak suite. |
| `human_questions` | `AskUserQuestion` tool uses in the coordinator, the e2e author and every worker session, plus gates still open in the store. |
| `units` | `orch unit counts`. |
| `repair_rounds` | Distinct `REPAIR-<n>`, `CI-REPAIR-<n>` and `SYNC-<n>` tickets per unit in the `Cstack-Ticket` trailers of `origin/main` and every `origin/cstack/*` branch. |
| `wall_seconds`, `within_budget`, `over_budget` | From the poll loop and `budget.toml`. |
| `decision_rows` | Rows in the run's `decisions.tsv`. |
| `merged_sha`, `prs`, `final_message` | `origin/main` after the run, the PRs created during it, and the coordinator's last message. |

`<outDir>` also keeps `coordinator.jsonl`, `coordinator.stderr.log`, `prompt.txt`, `session.sh`, `report.md` (the program's own report), and the clone with its run store.

## Fixtures

| Fixture | Slug | Surface | Budget |
|---|---|---|---|
| `f1-cli-ledger` | `f1` | CLI: a plain-text expense ledger (add, list, report, CSV import) | 2 h, 0 unplanned questions |

`f2-http-shortener` and `f3-web-kanban` from plan 6.3 are not written yet. A new fixture needs a directory with the three files and an entry in `FIXTURES` in `run-fixture.mjs` that names its slug and its scaffold.
