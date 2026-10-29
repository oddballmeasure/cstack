# L4 fixture programs

Whole `/cstack:program` runs against a sandbox testbed repo you own (set `CSTACK_TESTBED_REPO=owner/name`; the maintainer's is the private `oddballmeasure/cstack-testbed`). The runs create issues and PRs there and reset its `main` branch, so never point it at a real project, graded by a held-out suite that cstack never sees (plan section 6.3).

```
node tests/fixtures/run-fixture.mjs <f1|f2|f3> [--keep]
node tests/fixtures/run-fixture.mjs --help
```

A run takes hours, so start it detached from your terminal:

```
systemd-run --user --unit=cstack-fixture-f1 --collect --working-directory="$PWD" node tests/fixtures/run-fixture.mjs f1
journalctl --user -fu cstack-fixture-f1
```

Run one fixture at a time, and no scenario next to it. A program can use most of a 5-hour subscription window.

## A fixture

| File | Purpose |
|---|---|
| `<fixture>/guideline.md` | The idea, written as a brief with goals and end-to-end requirements. The runner copies it to a temporary directory and passes that path to the program, so the run never gets a path next to the grader. |
| `<fixture>/grader/` | The held-out suite. Test names start with `G<n>`. Only the runner runs it, and only after the run has stopped. |
| `<fixture>/budget.toml` | `hours` (wall time) and `max_unplanned_questions`. |
| `<fixture>/fixture.json` | The run slug, the entry point the grader tests, the grader command, and the empty project (below). `--help` lists every key. |
| `<fixture>/results/<date>.json` | One file per run (committed). |

## What a run does

1. Clones the testbed fresh into `tests/fixtures/results/<fixture>-<ts>/testbed` (gitignored).
2. Replaces testbed `main` with the fixture's empty project and pushes it: `project.package` as `package.json` (plus a `package-lock.json` when it has `devDependencies`), one smoke test under `test/` that `npm test` runs (`project.smoke`: no dependencies at all, or no runtime dependencies), a CI workflow with job `ci` (`npm ci` and `npx playwright install --with-deps chromium` first when `ci.install` and `ci.playwright` say so, then `npm test`), `.cstack/config.json` (templates/config.json, then autonomy `stop`, `e2e_command` null, `required_checks` `["ci"]`, `paths_hidden` `["tests/acceptance/**"]`, `parallel` 1, then the fixture's `config` overrides), `project.gitignore` and `project.readme`.
3. Launches `/cstack:program <guideline> --autonomy=send --slug <slug>` with the unattended note, as a detached headless coordinator `cstack-cstack-testbed-<slug>-coordinator` under `systemd-run`. Its environment has `CSTACK_COORDINATOR=1`, `CSTACK_RUN=<slug>` and `CSTACK_PROGRAM_AUTONOMY=send`, and no API key. The repo config says `stop`, so the run merges only because the launch raised it (ADR-006).
4. Polls `systemctl --user is-active` every 60 seconds. When `hours` runs out, it stops the coordinator and every worker of the run.
5. Checks out `origin/main` in the clone, then measures (below).
6. Teardown, unless `--keep`: stops the run's units, closes the PRs and issues created since the run started (deleting their branches), removes the clone's worktrees, and restores testbed `main` to tag `baseline-p3`.

It prints `PASS` when the grader pass rate is at least 0.95, the run stayed within `hours` and `max_unplanned_questions`, and the coordinator ran on the subscription (`apiKeySource: none`).

## Result file

| Key | Source |
|---|---|
| `grader` | `grader/` is copied to a fresh temporary directory outside the clone, `grader.setup` runs there (f3: `npm ci`), then `grader.command` with `<entry.env>=<clone>/<entry.path>` (f1: `LEDGER_BIN=<clone>/bin/ledger.mjs node --test --test-reporter=tap index.js`). `ok` and `not ok` lines by `G<n>`; the ids are every `test("G<n>` in the grader's top-level `.js` and `.mjs` files. A test that never reports counts as failed. Raw TAP in `<outDir>/grader.tap`. A failed setup fails every test and sets `setup_error`. The copy is removed afterwards. |
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
| `f1-cli-ledger` | `f1` | CLI: a plain-text expense ledger (add, list, report, CSV import). Grader: 24 `node:test` tests against `LEDGER_BIN`. | 2 h, 0 unplanned questions |
| `f2-http-shortener` | `f2` | HTTP API: a URL shortener with JSON-file persistence, rate limiting and graceful shutdown, no dependencies. Grader: 30 `node:test` tests against `SHORTENER_ENTRY`, over HTTP, with restarts and SIGKILL. Config `parallel` 2. | 6 h, 0 unplanned questions |
| `f3-web-kanban` | `f3` | Web UI: a three-column kanban board (vanilla JS page plus JSON API) with drag and drop and keyboard moves. Grader: 25 Playwright tests in Chromium against `KANBAN_ENTRY`, printed as TAP by `grader/tap-reporter.mjs`. The scaffold already has `@playwright/test` 1.63.0 as a dev dependency (with a lockfile) and `setup_command` `npm ci && npx playwright install chromium`. Config `parallel` 2. | 12 h, 0 unplanned questions |

f3 pins `@playwright/test` 1.63.0 in the scaffold and in `grader/package.json` because it is the release whose Chromium build (1243) is cached in `~/.cache/ms-playwright`. 1.62 uses build 1234 and 1.64 uses 1248, which would download a new browser. Bump both pins together with the cache.

A new fixture is a directory with `guideline.md`, `budget.toml`, `fixture.json` and `grader/`. The runner finds it by its `fixture.json`.
