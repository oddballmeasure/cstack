# ADR-004: The single-unit path, and what the first live scenarios changed

Date: 2026-10-27.

## Decision

`cstack:unit` coordinates one issue through 13 stages (`docs/unit-flow.md`). It never edits product code. A `cstack-worker` subagent implements, a `cstack-verifier` subagent on a different model judges, and gates decide every transition. Four new scripts carry the deterministic steps: `settle`, `sync-base`, `publish` and `ci-log`.

## Changes forced by live runs

The L3 scenarios ran as headless `claude -p` sessions on the private testbed. Each change below came from a real run.

| Finding | Change |
|---|---|
| Profile and intake explorers ran in the main checkout, where the hidden suite is on disk. An explorer named a hidden file. | Isolate is now stage 2, before profile (3) and intake (4). Explorers and planners read code only in the sparse worktree. |
| Nothing stopped an implementer from editing `.cstack/config.json` (autonomy, hidden paths). | The config is always off limits: in the guard hook for file tools, and in `check-commit`/`check-verdict` path rules. |
| A blank line before `Co-Authored-By` hid the cstack trailers from git, and resume reads trailers the way git does. | `check-commit` parses trailers strictly, like git, and its failure message says to keep every trailer in one final paragraph. The worker brief says the same. |
| A failed attempt also leaves its `Cstack-Ticket` trailer. | A ticket is done only when its trailer is on the branch AND `check-commit` passes at HEAD. Resume always re-runs `check-commit` first. |
| On resume, `check-intake` against the worktree rejected `new:` files that the branch already holds. | Intake is checked against the base checkout. |
| `gh api` refuses Actions job logs with terminal escape codes. | `ci-log` passes `--allow-escape-sequences` and strips the codes. |
| The repo profile file was not gitignored. | Setup writes `.cstack/*` and `!.cstack/config.json`. Doctor checks both paths with `git check-ignore`. |
| An agent read the testbed's CI policy script and pre-empted the CI-only failure, so `ci-red` never exercised CI repair. | The testbed policy now needs a release tag held in a repository variable, visible only in CI output. That is what "CI differs from local" looks like in practice. |
| The testbed workflow interpolated the PR body into a shell command (found by cstack during `ci-red`). | The body goes through `env`. |
| `base-conflict` first used a semantic conflict (throw vs coerce). The agent correctly stopped and asked a human. | The scenario now uses a textual conflict whose behaviours are compatible. The semantic case is a valid needs-human outcome, not a failure. |

## Usage

Two scenarios in parallel, plus the Phase 4 authoring agent, exhausted the 5-hour subscription window once. Scenarios now run one at a time.
