---
name: orchestrate
description: "Use when cstack must run a planned program of units to the end, for example at step 5 of a program run after cstack:plan. Coordinates every unit in units.tsv: picks ready units in dependency order, runs them in-session (5 units or fewer, parallel 1) or as detached headless workers under systemd-run (a rolling window of config parallel), drains the inbox, restarts a dead worker once, re-queues usage-limited units after the reset, runs cstack:post-merge-ci after each merge, and never ends its turn while units are in flight."
argument-hint: "--run <slug>"
---

<!-- Adapted from pstack skills/poteto-mode/playbooks/orchestrate.md @ 519d36a (MIT, Lauren Tan), with Cardinal's worker loop (oddballmeasure/cardinal daemon/workers.py, same owner). -->

# Orchestrate

You own the program, never the code. You pick units, launch them, drain the queue, keep the base green, and decide. Each unit runs `cstack:unit` from end to end. You never edit product code, never write a brief for an implementer, and never merge outside a unit's merge gate.

Three rules carry the rest:

- Completions are queue events, not interrupts. Truth is `units.tsv`, the inbox and `systemctl`, never a worker's chat.
- Every step is idempotent. A fresh session running this skill again on the same store does the right thing (`cstack:resume-run` relies on this).
- **Never end your turn while a unit is in flight.** Wait with the `Monitor` tool on the watcher. If you end the turn early, nobody wakes you and the program stops.

Read the [cstack mode skill](../cstack/SKILL.md) first.

## Names

Shell variables do not persist between Bash calls. Resolve each name once, then write the absolute value into every command.

| Name | Value |
|---|---|
| `<root>` | The plugin root, two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<slug>` | The `--run` slug. |
| `<store>` | `<repo>/.cstack/runs/<slug>`, absolute. |
| `<orch>` | `node <root>/gates/orch.mjs --store <store>` |
| `<worker>` | `node <root>/gates/worker.mjs` |
| `<log>` | `sh <root>/skills/show-me-your-work/scripts/log.sh <store>/decisions.tsv` |
| `<unit name>` | `cstack-<repo name>-<slug>-<unit>`, the systemd unit of a Level B worker. `<repo name>` is config `repo` after the slash. |

## Preconditions

1. `<root>/skills/doctor/scripts/doctor.sh <repo>` exits 0.
2. `node <root>/gates/check-plan.mjs --units <store>/units.tsv --spec <store>/spec.md --e2e <store>/e2e-plan.md --plan <store>/plan.md` exits 0. If not, run `cstack:plan`.
3. `<orch> gate list` shows no open `H2`. An open H2 means the plan waits on the human: report it and stop.
4. Every U unit has an issue (`<orch> unit list`). If not, finish `cstack:plan` step 7.

## The coordinator session

The `pending-work` Stop hook keeps a coordinator from ending its turn while units are in flight and no watcher is armed. It is active only when the session's environment has `CSTACK_COORDINATOR=1` and `CSTACK_RUN=<slug>`. Elsewhere it allows every stop.

- **Headless (recommended for Level B).** Launch the coordinator as its own systemd unit. The launch sets both variables, unsets the API keys and sets an explicit PATH:
  ```sh
  <worker> launch --store <store> --coordinator
  ```
  Its output goes to `<store>/workers/coordinator.jsonl`. After a crash, relaunch with `--resume`, which runs `cstack:resume-run`.
- **Interactive.** Start Claude Code with the variables set: `CSTACK_COORDINATOR=1 CSTACK_RUN=<slug> claude`. Without them the hook is inert and only this skill's rules keep you waiting.

## Choose the level

Count the U units (skip track `e2e`). Read config `parallel` (default 1).

- **Level A** when there are 5 units or fewer and `parallel` is 1. You run each unit yourself, in this session, one at a time.
- **Level B** otherwise. Each unit runs as a detached headless worker. Workers survive your compaction, crashes and restarts. You read their results from the store.

A store with a `workers/` directory is Level B, whatever the count. A worker may still run there, and two coordinators of one unit would collide.

Log the choice: `<log> "orchestrate" "level <A|B>" "<n> units, parallel <p>" "<store>/units.tsv" "start"`.

## Install the runtime

1. `<orch> init` (idempotent).
2. Write standing orders once, before any launch: `<orch> standing add "<line>"` for each run-wide constraint (autonomy, forbidden paths, anything the human said). Workers read them through `cstack:unit`.
3. `<orch> frontier set --repo <repo>`.
4. Create the TodoWrite list: `Launch`, `Drain`, `Land`, `Close`.

## Level A loop

Repeat until `<worker> next --store <store>` prints no `launch` line:

1. Take the first `launch U<n>` line. Run `cstack:unit <issue> --run <slug> --unit U<n>` with the `Skill` tool. It runs in this session and ends with a final report.
2. Run `<orch> inbox drain` (the unit pushed its result there). Read `<orch> unit get U<n>` and handle the state as the **Drain** table says. A unit that stopped in `in-progress` without settling gets one more `cstack:unit` run, which resumes it, then fails with kind `crash`.
3. `<orch> status`.

Then go to **Close**.

## Level B loop

Each pass runs Drain, Launch, Wait, in that order. A fresh session starts at Drain.

### Drain

1. `<orch> inbox drain`. Each line is `ts agent unit status report`. A worker's wrapper pushes one `worker` entry when its session ends for any reason, SIGKILL included. The unit itself pushes a `unit` entry at settle. Two entries for one unit are normal. Act on the unit's state, not on the count of entries.
2. For each unit named in an entry, and for each unit in `in-progress` or `verifying`, read `<orch> unit get <unit>` and `systemctl --user is-active <unit name>`. Then:

| Unit state, worker | What it means | Do |
|---|---|---|
| `merged` | Its merge gate merged it. | **Land** it. |
| `pr-open`, worker not active | Merge-ready under autonomy stop. | Nothing. It waits on the human. Dependents wait too. |
| `error` or `needs-human` | The unit settled the issue and stopped. | Nothing. Its dependents stay blocked. Report it. |
| `in-progress` or `verifying`, worker active | Running. | Nothing. |
| `ready`, entry `usage_limit` | The wrapper re-queued it and wrote `workers/<unit>.not-before`. | Nothing. `next` defers it until the reset. Log the reset time. |
| any, entry `setup` | The worker billed through an API key. | Hard stop. Launch nothing more. Let running workers finish, then report it first. |
| `in-progress` or `verifying`, worker not active (entry `crash`, or no entry) | The worker died. | **Restart** it. |

**Restart.** Count the earlier `restart <unit>` rows in `<store>/decisions.tsv`. With none, log `<log> "drain" "restart <unit>" "<the exit line from workers/<unit>.exit.txt>" "<launch count>" "restart"` and relaunch it with `<worker> launch --store <store> --unit <unit>`. The new session runs `cstack:unit`, which resumes from git trailers, the ledger and the PR (its Resume section), so no ticket or comment repeats. With one restart already, do not relaunch. Settle the issue as failed with kind `crash` through `cstack:settle` and set `<orch> unit set <unit> --state error`.

### Land

Units land bottom-up. A unit starts only after every unit it depends on has merged (`next` enforces this), so merges arrive in dependency order. For each newly merged unit:

1. Confirm `<orch> unit get <unit>` holds the merge SHA in the `sha` column. If it holds the head SHA, read `gh pr view <pr> --repo <repo> --json mergeCommit` and run `<orch> unit set <unit> --sha <merge sha>`.
2. Run `cstack:post-merge-ci`. It judges the merge commit's checks and files at most one follow-up issue.
3. **Sync siblings.** For each `pr-open` unit with no active worker, read `gh pr view <pr> --repo <repo> --json mergeStateStatus`. On `DIRTY` or `BEHIND`, relaunch its worker with `<worker> launch`. It resumes at its merge gate, sees the base moved, and syncs (stage 7). Running workers sync on their own in `cstack:babysit-pr`. This relaunch is not a restart. Log it as `sync <unit>`.
4. **Unblock dependents.** For each `planned` unit whose dependencies are now all merged, add the ready label to its issue: `gh issue edit <issue> --repo <repo> --add-label <prefix>:ready`. The plan left it unlabelled so no standalone run could start it early.
5. `<orch> frontier set --repo <repo>`.

### Launch

If `<orch> standing show` has a line that starts with `STOP` (written by `cstack:pause-safely`), launch nothing. Keep draining and waiting until the running workers end, then report.

```sh
<worker> next --store <store>
```

It prints `launch <unit>` lines for the free slots (config `parallel` minus the units running), in id order, with dependencies met. A line marked `(dependency override)` follows Cardinal's rule: nothing runs and nothing qualifies, so the lowest planned unit starts anyway. Log every override. `defer <unit> until <iso>` names a usage-limited unit and its reset.

For each `launch` line:

```sh
<worker> launch --store <store> --unit <unit>
```

It is idempotent. It leaves a live worker alone, marks the unit `in-progress`, and runs `systemd-run --user --unit=<unit name> ... claude -p --strict-mcp-config --plugin-dir <root> "/cstack:unit <issue> --run <slug> --unit <unit>"` with an explicit PATH and `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset. `--dry-run` prints the command. The worker's output is in `<store>/workers/<unit>.jsonl` and `.stderr.log`.

### Wait

Run `<orch> status` and end the pass with its three lines. Then arm the `Monitor` tool:

- command: `node <root>/gates/inbox-wait.mjs --store <store>`. When no worker is running and `next` printed only `defer` lines, add `--until <earliest defer time>`.
- timeout_ms: `3600000`. Re-arm on expiry.

The watcher prints one line per new inbox entry and per worker state change. It exits with `done: all units terminal`, `idle: no live worker`, or `deadline: <iso>`. On any line, finish what you are doing, then start a new pass at Drain. While the Monitor runs, you may end your turn. Never use `sleep` or a polling loop: the guard hook blocks both.

## Close

The run is closed when `<worker> next --store <store>` prints no `launch` or `defer` line and no worker is active. Then:

1. Run `cstack:post-merge-ci` with `--wait` under the Monitor tool until no merge is waiting.
2. Reconcile every unit to a final row: merged, merge-ready (`pr-open`), error, needs-human, or blocked (planned with an unmerged dependency). Account for every launch in `workers/*.launches`.
3. Run `cstack:status` and use it as the top of your report.
4. Audit the trail per `cstack:show-me-your-work`.

Leave the store intact. It is the postmortem.

## Escalation

Reaches the human, batched into the final report: a hard stop from the mode skill, a `setup` (billing) entry, a unit in `needs-human`, a post-merge follow-up labelled `needs-human`, an open gate in `<orch> gate list`, and a program-level dead end.

Never reaches the human: retries, restarts, usage-limit waits, base syncs, CI flakes, and "should I keep going". When in doubt, act and log.

## Final report

Follow the mode skill's **Writing the reply**. Numbers come from the tables, not from memory.

- The predicate: units merged against units planned, from `<orch> unit counts`.
- Each unit: id, issue, PR, final state, merge SHA or verdict.
- Post-merge verdicts and follow-up issues.
- Restarts, usage-limit waits and dependency overrides.
- Items waiting on the human, first, each with a recommended choice.
- The store path and the trail path.
