---
name: daemon
description: "One polling tick of the cstack daemon for this repo: preflight once, drain finished workers, judge merges with post-merge CI, settle orphans through resume-run, requeue retryable failures, then launch the oldest ready issues as Level B workers. Run it on an interval with /loop 10m /cstack:daemon, usually headless under systemd. Replaces Cardinal's daemon."
argument-hint: "(no arguments; run as /loop 10m /cstack:daemon)"
disable-model-invocation: true
---

<!-- Adapted from Cardinal src/cardinal/daemon/loop.py (oddballmeasure/cardinal, same owner). -->

# Daemon

The daemon works the repo's issue queue with no human present. Each issue labelled `<prefix>:ready` becomes one standalone run, `issue-<N>`, worked by a detached Level B worker that runs `cstack:unit`. This skill is one tick. `/loop` calls it again on an interval. A tick never waits for a worker. It launches, records, and ends.

Read the [cstack mode skill](../cstack/SKILL.md) first.

## Names

| Name | Value |
|---|---|
| `<root>` | The plugin root, two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<tick>` | `node <root>/gates/daemon-tick.mjs` with `--repo-dir <repo> --json` on every call. |
| `<store N>` | `<repo>/.cstack/runs/issue-<N>`, absolute. |
| `<orch N>` | `node <root>/gates/orch.mjs --store <store N>` |
| `<log>` | `sh <root>/skills/show-me-your-work/scripts/log.sh <repo>/.cstack/runs/daemon/decisions.tsv` |

Labels use config `label_prefix` (default `cstack`). The daemon only reads `ready`. It never touches an issue labelled `proposed`: `cstack:scout` files those for a person to approve.

## Rules

- **One tick, then stop.** Do not arm a Monitor. Do not sleep. Do not run `cstack:unit` in this session. The next `/loop` firing is the wake-up.
- **Gates decide.** Take launches, orphans and retries from `daemon-tick.mjs`, never from your own reading of labels.
- **Never two workers for one issue.** `worker.mjs launch` leaves a live worker alone, and `select` skips it. Do not work around either.
- **Hard stops.** A `setup` inbox entry means a worker billed through an API key. Launch nothing in this tick or later ticks. Report it first. Under `claude -p` there is no one to ask, so the report is the final message of the tick.

## Tick

Log one row per action with `<log> "daemon" "<action>" "<why>" "<evidence>" "<result>"`.

1. **Preflight, once per session.** If this session has not passed doctor yet, run `<root>/skills/doctor/scripts/doctor.sh --offline <repo>`. On any FAIL, end the tick and report the FAIL lines. Doctor is offline because the tick reads GitHub through the gates, which fail with a clear error when GitHub is down.
2. **Paused?** If `<repo>/.cstack/daemon.stop` exists, do steps 3 to 5 only. Launch and requeue nothing.
3. **Scan.** Run `<tick> scan`. Each store line names its unit state, worker state, inbox count, and the flags `orphan` and `judge`.
4. **Drain.** For each store with an inbox count above 0, run `<orch N> inbox drain`. Act on the entries:
   - `setup`: a hard stop (see Rules). Note it, finish this step, then skip steps 6 to 8.
   - `usage_limit`: nothing. The worker put the unit back to `ready` with a reset time, and `select` defers it.
   - `merged`, `done`, `error`, `needs-human`, `pr-open`: the unit settled its issue. Log it.
   - `crash`: step 5 settles it.
   - `denied`: the worker's allowlist refused calls it needed (`workers/U1.denied.txt`). Never relaunch it. Settle the issue as failed with kind `setup` through `cstack:settle`, and report each refused call first. A person adds the missing rule to config `permissions_allow`.
5. **Land and settle.**
   - For each `judge` store, run `node <root>/gates/post-merge.mjs --store <store N> --json` once, without `--wait`. It judges the merge commit's checks, re-runs a red one once, and files at most one follow-up issue. Log each `filed` follow-up.
   - For each `orphan` store, run `cstack:resume-run issue-<N>`. The store has a launches file, so resume-run relaunches the worker once and settles a second death as `crash`. It never runs the unit in this session.
6. **Retry sweep.** Run `<tick> retry --apply`. With config `retry_after_hours` unset, it does nothing. Otherwise it relabels each errored issue whose failure kind is retryable and older than the window back to `ready`. `crash`, `setup` and `deploy` are never retried.
7. **Launch.** Run `<tick> select`. It lists open `ready` issues oldest first, skips live workers and usage-limit deferrals, and fills only the free slots of config `parallel`. For each `launch` entry, in order:
   ```sh
   <tick> prepare <N>
   node <root>/gates/worker.mjs launch --store <store N> --unit U1
   ```
   `prepare` creates `issue-<N>` with unit `U1` ready, or resets a stopped one. `worker.mjs` marks it `in-progress` and starts `cstack-<repo name>-issue-<N>-U1` through the host supervisor (ADR-011). The worker runs `/cstack:unit <N> --run issue-<N> --unit U1` and claims the issue itself.
8. **End the tick.** Reply with three lines: launched, settled or landed, and anything that needs a person. Then stop.

## Run it

Interactive, for a trial: start Claude Code in the repo as `CSTACK_COORDINATOR=1 claude`, then type `/loop 10m /cstack:daemon`. Stop it by ending the session.

Headless, as a service on macOS or Windows: run `node <root>/gates/supervise.mjs daemon-file --repo-dir <repo>`. It writes a launchd agent (macOS) or a Task Scheduler command (Windows) under `<repo>/.cstack/daemon/` and prints the one install command for the human to run. The service runs `supervise.mjs daemon-run`, which writes the coordinator allowlist and then runs the same `claude -p "/loop 10m /cstack:daemon"` session as the systemd unit. A LaunchAgent runs only while the user is logged in. A Task Scheduler task needs the user logged in, unless they store a password for it themselves (ADR-011).

Headless, as a service on Linux: copy [the systemd user unit](references/cstack-daemon@.service) to `~/.config/systemd/user/`, edit the plugin path, then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now "cstack-daemon@$(systemd-escape --path /path/to/repo).service"
loginctl enable-linger "$USER"
```

The unit runs `claude -p "/loop 10m /cstack:daemon"` in the repo with `--permission-mode dontAsk` and the coordinator allowlist that `ExecStartPre` writes to `.cstack/permissions/coordinator.json` (ADR-009; no permission bypass), `CSTACK_COORDINATOR=1`, an explicit `PATH`, and `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CSTACK_PROGRAM_AUTONOMY` unset, so the daemon and its workers bill the subscription and the run's autonomy comes from config. Read its log with `journalctl --user -u 'cstack-daemon@*'`.

Not live-tested yet: whether a headless `claude -p` session stays alive under `/loop` between firings. If it exits after the first tick, the unit's `Restart=always` with `RestartSec=600` still gives about a 10-minute cadence, one tick per start, with doctor once per start.

## Report

Per tick, the three lines from step 8. Numbers come from the gate output, not memory.
