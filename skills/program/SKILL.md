---
name: program
description: "Run a whole cstack program from a guideline prompt to a verified merged SHA on the base branch: preflight, spec (human gate H1), repo profile, the hidden e2e suite as PR #0, plan (human gate H2 unless autonomy send), orchestrated units, post-merge CI, a final grader-mode e2e proof and council review, then an audited report. Use for /cstack:program <guideline text or path> [--autonomy=stop|send] [--parallel=N] [--slug <s>], or /cstack:program --resume <slug>."
argument-hint: "<guideline text or path> [--autonomy=stop|send] [--parallel=N] [--slug <s>] | --resume <slug>"
disable-model-invocation: true
---

<!-- Adapted from tstack skills/full-send/SKILL.md @ 92e38e2 (MIT, Theo Browne) for the stay-active rule, and pstack skills/poteto-mode/playbooks/orchestrate.md @ 519d36a (MIT, Lauren Tan) for the step list and decision trail. The pipeline is the cstack plan, section 5. -->

# Program

You own the run from a guideline prompt to a merged, verified SHA on the base branch. You chain the other cstack skills in a fixed order. You never write product code, never read the hidden suite, and never merge outside a merge gate.

The output is one final report: the merged base SHA, the e2e result per lane at that SHA, the PR list, and each requirement traced to its lanes, unit, PR and evidence.

Read the [cstack mode skill](../cstack/SKILL.md) first. Its non-negotiables bind every step.

## Names

Shell variables do not persist between Bash calls. Resolve each name once, then write the absolute value into every command.

| Name | Value |
|---|---|
| `<root>` | The plugin root, two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<slug>` | `--slug`, or `--resume <slug>`. Else derive it from the guideline's title: lowercase, every run of non-alphanumerics to `-`, at most 40 characters. |
| `<store>` | `<repo>/.cstack/runs/<slug>`, absolute. |
| `<orch>` | `node <root>/gates/orch.mjs --store <store>` |
| `<settings>` | `node <root>/gates/run-settings.mjs --store <store>` |
| `<log>` | `node <root>/skills/show-me-your-work/scripts/log.mjs <store>/decisions.tsv` |
| `<base>` | Config `base_branch`. |
| `<repo slug>` | Config `repo` (`owner/name`). |

## Arguments

- **Guideline.** Everything that is not a flag. A readable file path, or the text itself. `cstack:spec` copies it to `<store>/guideline.md`.
- **`--autonomy=stop|send`.** Overrides config `autonomy` for this run only. Without the flag, config decides. cstack's default is `send` (ADR-007).
- **`--parallel=N`.** A positive integer. Overrides config `parallel` for this run only.
- **`--slug <s>`.** The run slug.
- **`--resume <slug>`.** Continue an existing run. See **Resume**.

Reject any other flag, an `--autonomy` value other than `stop` or `send`, or a `--parallel` value that is not a positive integer. Report the usage line and stop.

## The run record

Write `<store>/run.json` once, at step 0, with the Write tool:

```json
{"entry": "program", "slug": "<slug>", "autonomy": "<flag value>", "parallel": <flag value>, "guideline": "<path or the literal text>", "started_at": "<UTC ISO time>"}
```

Leave out `autonomy` and `parallel` when their flags are absent. Never rewrite `autonomy` or `parallel` after step 0, also not on resume.

Every skill reads the run's autonomy and parallelism from `<settings>`, not from config. The merge gate (`gates/check-merge.mjs`) and `gates/worker.mjs next` read `run.json` themselves. The rule is ADR-006:

- `run.json` may always **lower** autonomy (`send` to `stop`).
- It **raises** `stop` to `send` only when the session that runs the merge gate has `CSTACK_PROGRAM_AUTONOMY=send` in its environment. Only the human sets it, when launching Claude Code (`CSTACK_PROGRAM_AUTONOMY=send claude`), or through a headless coordinator launch. `gates/worker.mjs launch` passes it on to workers. The guard hook blocks every Bash command that sets it.

So `--autonomy=send` in a session the human did not launch that way stays `stop`. `<settings>` prints a `note:` line when that happens.

## The step list

Create a TodoWrite list with these nine items at the start, and keep it current:

0. Preflight
1. Frame (H1)
2. Understand
3. E2E first (PR #0)
4. Plan (H2)
5. Execute
6. Integrate
7. Final proof
8. Close

A step you skip stays in the list as `skip: <reason>`.

## Decision log

Log one row per step transition with `cstack:show-me-your-work`, and one row per failed gate, per human gate, per default taken and per skip:

```sh
<log> "program" "step <n> <name>: <what happened>" "<why>" "<evidence path, PR or SHA>" "<result>"
```

The first row of a resumed run has phase `start`, per `cstack:show-me-your-work`.

## Pipeline

Each step names its owner skill, its gate, and where it goes on failure. Run each owner skill with the `Skill` tool and pass `--run <slug>` where it takes one. Failure kinds and their meaning come from `docs/unit-flow.md` in the plugin root.

### 0. Preflight

1. Run `cstack:doctor` on `<repo>`. Any FAIL is failure `setup`: report it and stop. Without `.cstack/config.json`, ask the human to run `/cstack:setup-cstack`, and stop.
2. Check that no other coordinator owns the run: `node <root>/gates/supervise.mjs status cstack-<repo name>-<slug>-coordinator`. If it prints `active` and `printenv CSTACK_COORDINATOR` in this session is not `1`, report the unit name and stop.
3. Create `<store>` with `mkdir -p`. Run `<orch> init`. Write `run.json` (see **The run record**).
4. Run `<settings>`. Log its lines.
5. If `--autonomy=send` was given and `<settings>` prints `autonomy stop`, the run cannot merge. Interactive: ask once with `AskUserQuestion`: "Continue under stop (default)" or "Stop now, so I can relaunch with `CSTACK_PROGRAM_AUTONOMY=send`". Headless: continue under stop. In both cases, log it and put it first in the final report.
6. Write the run's standing orders with `<orch> standing add`: the effective autonomy, `paths_hidden`, and anything the human said about scope.

The pending-work Stop hook guards this session only when `CSTACK_COORDINATOR=1` and `CSTACK_RUN=<slug>` are in its environment. A headless coordinator launch sets both. In an interactive session without them, only this skill's rules keep you waiting. Say so once in the log.

### 1. Frame (gate H1)

1. If the guideline is thin (no goals, or no observable behaviour), run `cstack:sharpen` on it first. Log it.
2. Run `cstack:spec <guideline> --run <slug>`.
3. **H1 is the spec's one question batch.** Add "Approve this spec as written, with the defaults below?" as the first question in the `AskUserQuestion` call that `cstack:spec` makes. Its default is "Approve (default)". That leaves room for 3 open questions. Do not ask a second time. If the human changes something, apply it, run `gates/check-spec.mjs` again, and log the change.
4. **Headless.** There is no `AskUserQuestion` under `claude -p`. Take every default, H1's approval included, and log each one with result `default`. List them first in the final report, so the human can overturn one.

Gate: `node <root>/gates/check-spec.mjs <store>/spec.md` exits 0. Fail: `cstack:spec` already retried twice, so this is failure `invalid_output`. Report and stop.

### 2. Understand

1. Run `cstack:profile-repo`. Gate: `node <root>/gates/profile-diff.mjs <repo>` ends with `gate profile-diff: approved`. Fail: failure `setup`.
2. Run `cstack:how` only for a question the spec or the plan depends on and the profile cannot answer. For an empty or new repo, skip it and log `skip: new repo`.

### 3. E2E first (PR #0)

Run `cstack:e2e-plan --run <slug>`. It writes `e2e-plan.md` and the hidden suite through the plugin's `cstack-e2e-author` agent, proves the suite red, and ships it as PR #0 with unit id `E2E` through the unit ship stages. Gate: `gates/check-e2e.mjs` and the red check, which that skill runs.

**PR #0 must merge before any implementation starts.** Implementers start from a base that holds the suite.

- **Effective autonomy `send`.** PR #0 goes through `cstack:merge-gate`, which merges it. Confirm with `<orch> unit get E2E`: state `merged` or `done`. Then go to step 4.
- **Effective autonomy `stop`.** PR #0 ends merge-ready. The program ends here. Run step 8 for a short report. Its first line is: "Merge PR #<n>, then run `/cstack:program --resume <slug>`."

Fail: follow **On failure** in `cstack:unit` for unit `E2E`, then step 8.

### 4. Plan (gate H2)

Run `cstack:plan --run <slug>`. It settles forks with `cstack:architect`, `cstack:arena` and `cstack:prototype`, writes the plan and units, and files one issue per unit.

Gate: `gates/check-plan.mjs`, run by that skill.

H2 follows the effective autonomy from `<settings>`, not config:

- **`send`.** H2 is skipped. `cstack:plan` logs it.
- **`stop`, interactive.** `cstack:plan` asks once.
- **`stop`, headless.** `cstack:plan` parks H2. The program ends here. Run step 8. Its first line is the H2 question, then: "Resolve it with `node <root>/gates/orch.mjs --store <store> gate resolve H2 --answer approve`, then run `/cstack:program --resume <slug>`."

### 5. Execute

Run `cstack:orchestrate --run <slug>`. It picks the level, launches units, drains the inbox, restarts dead workers once, waits out usage limits, and runs `cstack:post-merge-ci` after each merge. Each unit runs `cstack:unit` from end to end.

**Never end your turn while work is pending.** Orchestrate waits under the `Monitor` tool on `node <root>/gates/inbox-wait.mjs --store <store>`. While a unit is in flight, re-arm the watcher on expiry. Never write a sleep loop.

Every unit ends `merged`, `pr-open` (merge-ready under stop), `error` or `needs-human`. Read `<orch> unit counts`.

- Every U unit `merged`: go to step 6.
- Any unit `pr-open` under stop, or blocked behind one: the program waits on the human. Run step 8. Its first line names each PR to merge, then "run `/cstack:program --resume <slug>`".
- Any unit `error` or `needs-human` with no way forward: go to step 6, then step 8 with the predicate false. Skip step 7 and log why.

### 6. Integrate

Run `cstack:post-merge-ci --run <slug> --wait` under the Monitor tool until no merge waits for a verdict. Every merge commit of the run is judged.

- A follow-up issue labelled `<prefix>:ready`: the base broke after a merge. Fix it once, as a standalone unit. Write `<repo>/.cstack/runs/issue-<N>/run.json` with this run's `autonomy` (from `run.json`), so its merge gate follows this run. Then run `cstack:unit <N>` in this session, and run this step again. Do this at most once per program. A second break is a human item.
- A follow-up labelled `<prefix>:needs-human`: report it in step 8. Skip step 7.

### 7. Final proof

Run this step only when every U unit is merged and step 6 left the base green.

1. **Pin the SHA.** `git -C <repo> fetch -q origin <base>`, then `git -C <repo> rev-parse origin/<base>`. This is `<final>`. Every check below runs at `<final>`.
2. **CI on `<final>`.** Every config `required_checks` name shows `pass` on `<final>` in `node <root>/gates/forge.mjs checks <final>`. A check still `pending`: wait with `node <root>/gates/pr-wait.mjs` or `cstack:post-merge-ci --wait` under Monitor. Never a sleep loop.
3. **The hidden suite, every lane, by a fresh verifier.** Spawn the plugin's `cstack-verifier` agent with the `Agent` tool, model `models.judge`, fresh. It wrote no code in this run. The brief (GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, FORBIDDEN, REPORT) tells it to run exactly
   ```sh
   node <root>/gates/run-e2e.mjs <repo> --sha <final> --json
   ```
   and to write the JSON output, unchanged, to `<store>/final-e2e-<final sha12>.json`. `run-e2e.mjs` runs the suite as the grader (`CSTACK_ROLE=grader`) in a throwaway full clone, and prints only lane ids and one-line reasons. FORBIDDEN: `paths_hidden`, `--raw`, any edit, any GitHub write. The verifier's report is a model claim. Read the JSON file yourself.
4. **Compare lanes.** The lanes in the JSON equal every lane id in `<store>/e2e-plan.md`. Each one is `pass`. A missing lane is a fail.
5. **Council.** Run `cstack:council` on the cumulative diff of the program's implementation: `<start>..<final>`, where `<start>` is PR #0's merge commit (the `sha` column of `<orch> unit get E2E`). Starting there keeps the hidden suite out of the diff, so no reviewer and no part of this session reads it. Write the diff to a file first, without printing it: `git -C <repo> diff <start>..<final> > <store>/program.diff`. Then run `cstack:council <store>/program.diff`. Council reviews and scores. It changes nothing. A blocker it finds becomes a follow-up issue (`cstack:file-pr` rules for the body) and a human item in the report. It does not reopen the merged units.
6. **Record.** All lanes pass and CI is green:
   ```sh
   <orch> ledger record program-final <final> approved --evidence <store>/final-e2e-<final sha12>.json --verifier cstack-verifier
   ```
   Else record `rejected` with the same evidence. A rejection is the program's result, not a reason to retry. A lane that cstack's own suite marks green while it fails for the user is a P0 harness bug.

### 8. Close

1. Run the audit in `cstack:show-me-your-work`: the log against this session's transcript, then the cross-model review of the trail.
2. Run `cstack:status <slug>`. Its report is the top of yours.
3. Write the final report (below) to `<store>/report.md` with the Write tool, and give it as your final message.

Leave the store intact. It is the postmortem.

## Resume

`/cstack:program --resume <slug>`:

1. If `<store>/run.json` does not exist or its `entry` is not `program`, stop: there is no program to resume. Never rewrite `run.json`.
2. Run `cstack:resume-run <slug>`. It reconciles units with GitHub, settles orphans, and is idempotent. When it would hand the run to `cstack:orchestrate`, continue here instead.
3. Rebuild the step list. Mark each step done when its check holds, in order. Continue at the first step whose check fails.

| Step | Done when |
|---|---|
| 0 | `<store>/run.json` exists and `cstack:doctor` passes now. Always run the doctor again. |
| 1 | `gates/check-spec.mjs <store>/spec.md` exits 0. |
| 2 | `gates/profile-diff.mjs <repo>` approves. |
| 3 | `<orch> unit get E2E` shows `merged` or `done`. |
| 4 | `gates/check-plan.mjs` approves, `<orch> gate list` shows no open `H2`, and every U unit has an issue. |
| 5 | Every U unit is `merged`, `done`, `error` or `needs-human`, and no worker is active. |
| 6 | `cstack:post-merge-ci` reports nothing waiting. |
| 7 | `<orch> ledger summary` holds a `program-final` row at the current `origin/<base>` head. A base that moved since makes step 7 run again. |
| 8 | Never done on resume. Always close again. |

## On failure

Each step's failure goes to step 8 with the failure kind, the step, and the evidence. Never skip a gate to keep going. Retryable kinds (`usage_limit`, `crash`, `ci_timeout`) are handled inside `cstack:orchestrate` and `cstack:unit`. A program-level dead end (a failed gate after its retries, a hard stop from the mode skill) reaches the human in the report.

## Escalation

Reaches the human, batched into the final report: defaults taken at H1, a parked H2, PR #0 or unit PRs waiting to merge under stop, units in `needs-human` or `error`, a `setup` (billing) entry, a post-merge follow-up, council blockers, and a refused `--autonomy=send`.

Never reaches the human: retries, restarts, usage-limit waits, base syncs, CI flakes, and "should I keep going".

## Final report

Follow the mode skill's **Writing the reply**. Take every number from a gate, the store or GitHub, never from memory.

1. **Waiting on you**, first, when not empty. Each item with its options and a recommended choice.
2. **Result.** Done or not done, against the spec's done predicate.
3. **Merged base SHA.** `<final>`, and whether CI is green on it.
4. **E2E result per lane** at `<final>`, from `<store>/final-e2e-<sha12>.json`: lane id, pass or fail, and the one-line reason for a fail. Say which agent ran it.
5. **Trace.** One row per requirement: R id, its E lanes, the unit and its PR, and the evidence path (the lane result file and the unit's verdict file).
6. **PRs.** PR #0 and each unit PR, with state and merge SHA.
7. **Council.** The scores and any blocker, with its follow-up issue.
8. **Run.** Autonomy and its source from `<settings>`, parallelism, units by outcome, restarts, usage-limit waits, and the decision rows.
9. **Paths.** `<store>`, `<store>/decisions.tsv`, `<store>/report.md`.
