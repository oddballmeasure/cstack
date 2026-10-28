# ADR-008: Scout, the polling daemon, and deploy

Date: 2026-10-28.

## Decision

Phase 8 ports the rest of Cardinal's runtime: `cstack:scout` (planner, scout, reviewer, repro), `cstack:daemon` (one polling tick, run by `/loop`), and `cstack:deploy` (the deployment manager). It also ports pstack's `reflect`, `correct` and eval playbook (`cstack:eval-skill`) and tstack's `takeover` and `modernize`. `docs/cardinal-parity.md` maps every Cardinal capability to its owner and proof.

New gates, each at 100% line and branch coverage:

| Gate | Decides |
|---|---|
| `scout-check.mjs` | A survey plan (3-6 areas over tracked files, one covering the docs), each proposal (shape, enabled category, at most `max_files` tracked files, an exact value in every acceptance criterion, every quote found within 10 lines of its citation, with the range corrected), and a repro (only test files, green base, red with the test, the test name visible). |
| `scout-gate.mjs` | The track record per category from GitHub, area cooldown, and the only path that files a scout issue: dedupe, the per-pass cap, the autonomy gate, and the body. |
| `daemon-tick.mjs` | Which ready issues to launch, which workers live, which runs are orphaned, and which errored issues are due a retry. |
| `deploy.mjs` | The committed deploy pair at a merged revision, the approval, one run per revision, and health. |

Config gains three optional keys, all checked by doctor: `scout` (Cardinal's live values are the template defaults), `retry_after_hours` (null means never, else at least 24) and `deploy` (null means off).

## Choices

- **The scout's track record lives on GitHub, not in a database.** Each filed body carries `Category:`, `Cstack-Scout: <fingerprint>` and `Cstack-Scout-Mode:` lines. `scout-gate.mjs record` reads them back with one `gh issue list`. Cardinal kept the same facts in SQLite. A body marker survives a lost run store and needs no migration. The window is counted from the issue's creation, not its decision, because GitHub has no cheap "decided at".
- **An auto-filed issue never counts as approved.** It counts as rejected when a person closes it, and its landing counts toward the done-rate. Cardinal counted an auto-filed issue that landed as approved, so a category could keep itself above the bar. cstack can only lose approval through auto-filing, never gain it.
- **No type labels.** Cardinal also labelled each issue `<prefix>:<category>`. The `Category:` line carries the same fact, and the labels would need creating per repo. Doctor's label set stays the same.
- **The gate files, not the model.** `scout-gate.mjs file` re-runs every code check on the reviewer's evidence, picks the label, and writes the body. The skill tells the model never to file a scout issue itself.
- **The daemon is a skill tick under `/loop`, not a long-running script.** A tick launches Level B workers through `gates/worker.mjs` and ends, so no session waits hours on a worker. Each standalone run is `issue-<N>` with unit `U1`. `resume-run` now says that such a store (it has a launches file) takes the Level B path and never runs its unit inline.
- **Retry kinds.** `crash` (a cstack defect), `setup` (billing or repo setup, which a retry would only repeat) and `deploy` are never retried. Cardinal retried `setup`. In cstack, `setup` includes a worker billed through an API key, which must not repeat.
- **Approval of a deploy is the person's own command.** The guard blocks any session from running `deploy.mjs --approved` (`no-deploy-approval`). The skill gives the person the exact command for their terminal. `deploy.auto: true` in config is the only way a model deploys.
- **`claude plugin eval` always carries `--no-publish`.** ADR-005 made it a rule in prose. The guard now blocks any `claude plugin eval` without it (`no-eval-publish`), except `--help`.
- **Each health poll gets at least one second.** The first version gave the last poll what was left of the health timeout, which under load was a few milliseconds and killed the check. A test caught it.

## Not live-tested

- No scout pass, daemon tick or deploy has run against a real repo or host. Their gates are unit-tested with fake `gh`, `systemctl` and `ssh`.
- Whether a headless `claude -p "/loop 10m /cstack:daemon"` session stays alive between firings is not measured. The systemd unit uses `Restart=always` and `RestartSec=600`, so a session that exits after one tick still runs every 10 minutes.
- reflect, correct, eval-skill, takeover and modernize have no L2 eval cases yet.

## Residual risk

- The run store is writable by every session, so a model could write a fake repro diff into a scout bundle. `scout-gate.mjs` checks that the diff touches only test files, but not that it came from `scout-check.mjs repro`. A fake diff can only make a bug or regression eligible for `auto`, which still needs the category's track record over every bar. Under the default `autonomy: propose`, it changes nothing.
- The deploy approval rule reads Bash text, like the other guard rules (ADR-003). A script file that calls the gate with `--approved` would bypass it. That is a deliberate bypass of a named rule.
