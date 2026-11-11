---
name: plan
description: "Use when cstack needs a multi-unit plan from a spec and e2e plan, for example at step 4 of a program run after PR #0 merged. Writes <store>/plan.md and <store>/units.tsv (through orch unit add) that pass gates/check-plan.mjs, settles one-way doors with cstack:architect or cstack:arena and factual forks with cstack:prototype, then files one GitHub issue per unit (labelled <prefix>:ready only when its dependencies are met). Human gate H2 (approve the plan) unless the run's autonomy is send."
argument-hint: "--run <slug>"
---

<!-- Adapted from pstack skills/poteto-mode/playbooks/multi-phase-plan.md @ 519d36a (MIT, Lauren Tan). -->

# Plan

This skill turns `spec.md`, the repo profile and `e2e-plan.md` into units. A unit is one piece of work that ends as one PR (`docs/unit-flow.md`). `cstack:orchestrate` runs the units. Each unit's worker sees only its issue, its brief and its lane ids, so the plan is the product. A vague unit fails quietly, because a worker cannot ask you a question.

This skill does not implement anything.

## Names

Shell variables do not persist between Bash calls. Resolve each name once and write the absolute value into every command.

| Name | Value |
|---|---|
| `<root>` | The plugin root, two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<slug>` | The `--run` slug. |
| `<store>` | `<repo>/.cstack/runs/<slug>`, absolute. It holds `spec.md` and `e2e-plan.md`. |
| `<orch>` | `node <root>/gates/orch.mjs --store <store>` |
| `<log>` | `node <root>/skills/show-me-your-work/scripts/log.mjs <store>/decisions.tsv` |
| `<prefix>` | Config `label_prefix`. |

## Preconditions

1. Read the [cstack mode skill](../cstack/SKILL.md), then `<root>/templates/plan.md` and `<root>/templates/units.tsv`. The template comment is the format contract.
2. `node <root>/gates/check-spec.mjs <store>/spec.md` exits 0. If not, run `cstack:spec` first.
3. `<store>/e2e-plan.md` exists, and `<orch> unit get E2E` shows state `merged` or `done`. Implementers start from a base that holds the suite. If PR #0 is not merged, run `cstack:e2e-plan` first.
4. `node <root>/gates/profile-diff.mjs <repo>` ends with `gate profile-diff: approved`. If not, run `cstack:profile-repo`.
5. If `<store>/plan.md` exists and the gate in step 5 passes, do not rewrite it. Skip to step 7 when H2 is settled: `<store>/decisions.tsv` has an `H2` row (approved or skipped), or `<store>/gates.md` shows H2 resolved with `approve`. Otherwise skip to step 6.

When the spec has one or two requirements with an obvious approach, the plan is one unit. Say so in the decision log and write it anyway: orchestrate needs the row.

## Procedure

### 1. Read

Read `spec.md` (requirements R, e2e requirements E), `e2e-plan.md` (lanes with `Covers`), and `<repo>/.cstack/profile.json`. For a question the profile cannot answer, use `cstack:how`. Explorers read code only in a sparse worktree, never in the main checkout, so they never see `paths_hidden`. Make it with `node <root>/gates/isolate.mjs <repo> cstack/explore-<slug> /tmp/cstack-explore-<slug> --base origin/<base_branch>`. When the explorers are done, run `git -C <repo> worktree remove --force /tmp/cstack-explore-<slug>` and `git -C <repo> branch -D cstack/explore-<slug>`. Keep bulk in subagents (the plugin's `cstack-explorer` agent, model `models.gather`). Take file pointers back, not dumps.

### 2. Settle open questions

List every fork the plan depends on. Classify each one, as the mode skill says:

- **Factual fork.** Running something can answer it (behaviour, timing, an API's output, a library's limits). Run `cstack:prototype`. Keep the scratch path and the observed output for the appendix.
- **One-way door.** A shape that is costly to change later: a public interface, a data format on disk, a module boundary several units build on. Run `cstack:architect` (it runs `cstack:arena` inside). Its synthesized sketch becomes the first unit, or the contract every unit names in CONTEXT.
- **Product or preference call.** No run settles it. Pick the default that the spec's goals favour, write it in the plan, and list it for H2. Never stop the run for it.

Log one row per fork with the class and the evidence.

### 3. Cut units

Each unit is one change with its own evidence (`sequence-verifiable-units`).

- **One PR each.** Size S, M or L. Split an L that touches more than one module boundary.
- **Lanes, not requirements.** Every unit lists at least one lane id from `e2e-plan.md`. Every lane belongs to some unit. A unit covers R when one of its lanes has R in `Covers`. Do not repeat R ids in `units.tsv`.
- **Dependencies are context relays.** `U2 depends on U1` means U2 starts only after U1 merges, and U2's brief names what U1 built. Prefer independent units. Add a dependency only when the code needs it.
- **Human checkpoints are gates.** When the guideline or the human asks for a sign-off before later work starts (for example a UI prototype approved before any feature unit), declare a named gate. Give it an id such as `PROTO` and put `gate:PROTO` in each held unit's `depends_on`. The held units start only after a person approves the gate. A unit may also depend on the `E2E` row (PR #0). Never use a gate for a product call that a default settles.
- **Disjoint files.** Two units that run in parallel should not edit the same files. When they must, make one depend on the other.
- **The scaffold first.** A one-way door's sketch from step 2 ships as the first unit. Every later unit builds on it.

### 4. Write the store

1. Run `<orch> init` if `<store>/units.tsv` does not exist.
2. For each unit, write its brief to `<store>/units/U<n>.md` with the Write tool. Use the headings GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, FORBIDDEN, REPORT. CONTEXT names the requirement ids with their text, the lane ids, the dependency units and what each one provides, and any architect sketch path. VERIFY names `test_command` and the lane ids through `gates/run-e2e.mjs`.
3. Add each unit in dependency order:
   ```sh
   <orch> unit add U<n> --track <track> --state planned --brief units/U<n>.md --lanes <E ids> [--depends-on <U ids, gate:<id>>]
   ```
   `<track>` is a short name for the area (`core`, `cli`, `api`). Units with no dependencies may start as `--state ready`. If a row already exists from an earlier attempt, fix it with `<orch> unit set` instead.
4. Write `<store>/plan.md` per the template: a short intro with the order, then one `## U<n> <title>` section per unit with `Files`, `Verify` and `Size`, and one `## Gate <id> <title>` section per named gate with a `Question` line. Add the appendices from **Plan appendices**.

### 5. Gate

```sh
node <root>/gates/check-plan.mjs --units <store>/units.tsv --spec <store>/spec.md --e2e <store>/e2e-plan.md --plan <store>/plan.md --json
```

The gate skips the `E2E` row (track `e2e`). It rejects a `gate:<id>` dependency with no `## Gate <id>` section in `plan.md`. On rejection, fix the store from the findings and run it again. Allow 2 retries. A third rejection is failure `invalid_output`: stop and report the findings.

### 6. Human gate H2

Read the run's effective autonomy with `node <root>/gates/run-settings.mjs --store <store>`. It is config `autonomy`, overridden by `<store>/run.json` when `cstack:program` ran with `--autonomy`.

Log the `H2` row as soon as H2 is decided, before step 7, so a resumed run does not skip or repeat it.

- **`send`.** Skip H2. Log `"H2" "skipped" "autonomy send"`. Go to step 7. Named gates are not skipped: they are checkpoints the guideline asked for, and `cstack:orchestrate` asks for each one under any autonomy.
- **`stop`.** Ask once per plan revision with `AskUserQuestion`: "Approve this plan?" Options: "Approve (default)", "Change it" (the human says what). Put the unit list (id, title, size, depends on, lanes) and each product call from step 2 with its default in the question text. On a change, apply it and run the gate again. The changed plan is a new revision, so ask about it once. Under `claude -p` there is no `AskUserQuestion`. Park the gate instead and stop: `<orch> gate park H2 --question "Approve plan <store>/plan.md?" --options "approve|change" --default approve`. Put the question first in your report. The person resolves it by running `<orch> gate resolve H2 --answer <a>` in their own terminal. Never run it yourself: the mode skill's rule is that only a human's answer resolves a gate. The deny rule on headless sessions is a second layer behind that rule, not the reason for it. A later session resumes after the person resolves it.

### 7. File the issues

One issue per unit, in id order. Skip a unit whose `issue` column is set. Write `<store>/issue-U<n>.md` with the Write tool:

```
<one paragraph: the change, for whom>

Requirements:
- R1: <text from spec.md>

Lanes: E1.1, E1.2 (hidden suite; run through gates/run-e2e.mjs)
Depends on: #<issue of U1> (U1)
Plan: <store>/plan.md, section U<n>
Brief: <store>/units/U<n>.md

<footer line from <root>/templates/footer.md>
```

Then, for each unit:

1. Search for an issue with the same title: `node <root>/gates/forge.mjs issue list --search "<title>" --in title --state open`. If one exists, reuse it, so a resumed plan never files twice: run only the `unit set` line below with its number.
2. If the unit's dependencies are met, file it as ready:
   ```sh
   node <root>/gates/forge.mjs issue create --title "<unit title>" --body-file <store>/issue-U<n>.md --label <prefix>:ready
   <orch> unit set U<n> --issue <number it prints> --state ready
   ```
3. Otherwise, file it with no state label:
   ```sh
   node <root>/gates/forge.mjs issue create --title "<unit title>" --body-file <store>/issue-U<n>.md
   <orch> unit set U<n> --issue <number it prints>
   ```

A `gate:<id>` dependency is not met until the gate is approved. A unit with unmet dependencies stays `planned`, so no standalone run can pick it up early. cstack:orchestrate adds `<prefix>:ready` when its dependencies merge. `orch unit ready` lists a planned unit once its dependencies merge.

### 8. Log

One row per unit (evidence: the issue number and the brief path), one for the gate's last line, one for H2.

## Plan appendices

Add these sections after the units in `plan.md`. They explain and record. The unit sections stay a how-to.

- `## Appendix A. Prototype evidence`: each factual fork, the scratch path, and the observed output that settled it.
- `## Appendix B. Alternatives rejected`: each approach weighed and why it lost.
- `## Appendix C. Risks`: each risk, the unit it lands in, and what the worker watches.
- `## Appendix D. Product calls`: each default taken and what the other option would change.

Write them under `cstack:technical-writing`, then `cstack:unslop`.

## Report

- The plan path and the gate's last line.
- Units: id, title, size, depends on, lanes, issue.
- H2: approved, skipped (send), or parked with the question first.
- Named gates: each id, its question, and the units it holds.
- Forks: each with its class and evidence.
