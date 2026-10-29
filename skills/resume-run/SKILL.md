---
name: resume-run
description: "Use when a cstack run must continue after its coordinator died, was compacted, or was paused, or when the human asks to pick up a run. Rebuilds the run's state from the store, git trailers and GitHub PR states, settles orphaned units (in progress with no live worker and no recent activity) by resuming them through cstack:unit, then hands the run back to cstack:orchestrate. Idempotent: running it twice does nothing twice."
argument-hint: "<slug>"
---

<!-- Adapted from pstack skills/poteto-mode/playbooks/session-pickup.md @ 519d36a (MIT, Lauren Tan), with Cardinal's resume rules (oddballmeasure/cardinal, same owner). -->

# Resume run

You own the resume point. The store, git and GitHub are the trail, and the trail is authoritative. Read it, do not redo it. A "verify everything from scratch" pass treats the trail as untrustworthy when it is the record.

Read the [cstack mode skill](../cstack/SKILL.md) first.

## Names

| Name | Value |
|---|---|
| `<root>` | The plugin root, two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<slug>` | The argument. A standalone unit run is `issue-<N>`. |
| `<store>` | `<repo>/.cstack/runs/<slug>`, absolute. If it does not exist, stop: there is nothing to resume. |
| `<orch>` | `node <root>/gates/orch.mjs --store <store>` |
| `<worker>` | `node <root>/gates/worker.mjs` |
| `<log>` | `sh <root>/skills/show-me-your-work/scripts/log.sh <store>/decisions.tsv` |
| `<unit name>` | `cstack-<repo name>-<slug>-<unit>` (`<repo name>` is config `repo` after the slash). |

## Procedure

### 1. One coordinator at a time

Read `node <root>/gates/supervise.mjs status cstack-<repo name>-<slug>-coordinator`. If it is `active` and `printenv CSTACK_COORDINATOR` in this session is not `1`, another coordinator owns the run. Report its unit name and stop. Do not start a second one.

### 2. Read the trail

Read these once. Do not narrate them back.

- `<orch> standing show`. Obey every line. A line that starts with `STOP` means the run is paused: do steps 3 and 4, then report and stop.
- `<orch> unit list --json`, `<orch> ledger summary`, `<orch> gate list`, `<orch> inbox drain --peek`.
- The last 30 rows of `<store>/decisions.tsv`.
- Every `<store>/workers/*.exit.txt` and `*.launches`.
- `<store>/resume-*.md` from `cstack:pause-safely`, if any.

### 3. Reconcile each unit with git and GitHub

For each U unit, in id order. Each step writes only when the store disagrees with GitHub, so a second run changes nothing.

1. **Find the PR.** If `pr` is empty and `branch` is set, run `gh pr list --repo <repo> --head <branch> --state all --json number`. Record a hit with `<orch> unit set <unit> --pr <n>`.
2. **Read the PR state** with `gh pr view <pr> --repo <repo> --json state,headRefOid,mergeCommit`.
   - `MERGED`, unit not `merged` or `done`: the worker merged and died before it settled. Run `<orch> unit set <unit> --state merged --sha <merge sha>`, then settle the issue as merged through `cstack:settle` (its comments are idempotent), then run `cstack:post-merge-ci`.
   - `CLOSED`, not merged: someone closed it. Settle as needs a decision, with the question "PR #<pr> was closed unmerged. Reopen it or drop the unit?" Set the unit `needs-human`.
   - `OPEN`: keep the unit's state.
3. **Read progress from trailers** for a unit with a branch: `git -C <repo> fetch -q origin <branch>` then `git -C <repo> log origin/<base>..origin/<branch> --format='%(trailers:key=Cstack-Ticket,valueonly)'`. This is for your report. `cstack:unit` decides which tickets are done when it resumes.

### 4. Find orphans

A unit is orphaned when its state is `in-progress` or `verifying` (or `pr-open` under autonomy `send`) and nothing runs it:

- **Level B** (the unit has `<store>/workers/<unit>.launches`): `node <root>/gates/supervise.mjs status <unit name>` is not `active` or `activating`. A live worker is never an orphan, however old its last row.
- **Level A** (no launches file): the unit ran inside a coordinator session, which has no systemd unit. It is orphaned when no row in `<store>/decisions.tsv` that names the unit, its issue or its branch is newer than 10 minutes.

Log each orphan: `<log> "resume" "orphan <unit>" "<state>, worker <is-active output>, last row <ts>" "<exit line or none>" "found"`.

### 5. Settle each orphan

Resume it through `cstack:unit`. Its Resume section rebuilds from trailers, the ledger and the PR, so no ticket, commit or comment repeats.

- **Level B** (the unit has a launches file). If `workers/<unit>.exit.txt` starts with `denied`, do not relaunch: settle as failed with kind `setup` and report the lines of `workers/<unit>.denied.txt`. Otherwise count the earlier `restart <unit>` rows in the decision log. None: log `restart <unit>` and run `<worker> launch --store <store> --unit <unit>`. One already: settle as failed with kind `crash` through `cstack:settle`, and `<orch> unit set <unit> --state error`.
- **Level A**, or a standalone `issue-<N>` run with no launches file. Run `cstack:unit <issue> --run <slug> --unit <unit>` in this session.

A standalone `issue-<N>` run with a launches file was started by `cstack:daemon`. It takes the Level B path above. Never run its unit in this session.

### 6. Continue

- A daemon run (`issue-<N>` with `workers/U1.launches`): stop after step 5 and report. The daemon's next tick drains it.
- A program run (more than one U unit, or `workers/` exists): run `cstack:orchestrate --run <slug>`. It starts at Drain.
- A standalone run: the `cstack:unit` run from step 5 is the continuation. Give its final report.

## Report

- Where the run stopped: the last decision row and the unit states before you touched anything.
- What you changed: each store write, settle, and relaunch, one line each. Ideally nothing was redone.
- The resume point, and the run's outcome when it finished in this session.
