---
name: plan
description: "Use when cstack needs a multi-unit plan from a spec and e2e plan, for example at step 4 of a program run after PR #0 merged. Writes <store>/plan.md and <store>/units.tsv (through orch unit add) that pass gates/check-plan.mjs, settles one-way doors with cstack:architect or cstack:arena and factual forks with cstack:prototype, then files one GitHub issue per unit (labelled <prefix>:ready only when its dependencies are met). Human gate H2 (approve the plan) unless config autonomy is send."
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
| `<log>` | `sh <root>/skills/show-me-your-work/scripts/log.sh <store>/decisions.tsv` |
| `<prefix>` | Config `label_prefix`. |

## Preconditions

1. Read the [cstack mode skill](../cstack/SKILL.md), then `<root>/templates/plan.md` and `<root>/templates/units.tsv`. The template comment is the format contract.
2. `node <root>/gates/check-spec.mjs <store>/spec.md` exits 0. If not, run `cstack:spec` first.
3. `<store>/e2e-plan.md` exists, and `<orch> unit get E2E` shows state `merged` or `done`. Implementers start from a base that holds the suite. If PR #0 is not merged, run `cstack:e2e-plan` first.
4. `node <root>/gates/profile-diff.mjs <repo>` ends with `gate profile-diff: approved`. If not, run `cstack:profile-repo`.
5. If `<store>/plan.md` exists and the gate in step 6 passes, skip to step 7. Never rewrite an approved plan.

When the spec has one or two requirements with an obvious approach, the plan is one unit. Say so in the decision log and write it anyway: orchestrate needs the row.

## Procedure

### 1. Read

Read `spec.md` (requirements R, e2e requirements E), `e2e-plan.md` (lanes with `Covers`), and `<repo>/.cstack/profile.json`. For a question the profile cannot answer, use `cstack:how`. Explorers read code only in a sparse worktree from `gates/isolate.mjs`, never in the main checkout, so they never see `paths_hidden`. Keep bulk in subagents (the plugin's `cstack-explorer` agent, model `models.gather`). Take file pointers back, not dumps.

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
- **Disjoint files.** Two units that run in parallel should not edit the same files. When they must, make one depend on the other.
- **The scaffold first.** A one-way door's sketch from step 2 ships as the first unit. Every later unit builds on it.

### 4. Write the store

1. Run `<orch> init` if `<store>/units.tsv` does not exist.
2. For each unit, write its brief to `<store>/units/U<n>.md` with the Write tool. Use the headings GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, FORBIDDEN, REPORT. CONTEXT names the requirement ids with their text, the lane ids, the dependency units and what each one provides, and any architect sketch path. VERIFY names `test_command` and the lane ids through `gates/run-e2e.mjs`.
3. Add each unit in dependency order:
   ```sh
   <orch> unit add U<n> --track <track> --state planned --brief units/U<n>.md --lanes <E ids> [--depends-on <U ids>]
   ```
   `<track>` is a short name for the area (`core`, `cli`, `api`). Units with no dependencies may start as `--state ready`. If a row already exists from an earlier attempt, fix it with `<orch> unit set` instead.
4. Write `<store>/plan.md` per the template: a short intro with the order, then one `## U<n> <title>` section per unit with `Files`, `Verify` and `Size`. Add the appendices from **Plan appendices**.

### 5. Gate

```sh
node <root>/gates/check-plan.mjs --units <store>/units.tsv --spec <store>/spec.md --e2e <store>/e2e-plan.md --plan <store>/plan.md --json
```

The gate skips the `E2E` row (track `e2e`). On rejection, fix the store from the findings and run it again. Allow 2 retries. A third rejection is failure `invalid_output`: stop and report the findings.

### 6. Human gate H2

Read config `autonomy` with `jq`.

- **`send`.** Skip H2. Log `"H2" "skipped" "autonomy send"`. Go to step 7.
- **`stop`.** Ask once with `AskUserQuestion`: "Approve this plan?" Options: "Approve (default)", "Change it" (the human says what). Put the unit list (id, title, size, depends on, lanes) and each product call from step 2 with its default in the question text. On a change, apply it, run the gate again, and ask again. Under `claude -p` there is no `AskUserQuestion`. Park the gate instead and stop: `<orch> gate park H2 --question "Approve plan <store>/plan.md?" --options "approve|change" --default approve`. Put the question first in your report. A later session resumes after `<orch> gate resolve H2 --answer <a>`.

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

Then:

```sh
gh issue create --repo <repo> --title "<unit title>" --body-file <store>/issue-U<n>.md $LABEL
<orch> unit set U<n> --issue <number from the URL> --state ready
```

Set `LABEL=--label <prefix>:ready` and `--state ready` only for units whose dependencies are met. A unit with unmet dependencies gets no state label and stays `planned`, so no standalone run can pick it up early. cstack:orchestrate adds `<prefix>:ready` when its dependencies merge. `orch unit ready` lists a planned unit once its dependencies merge. Before you create an issue, search for one with the same title (`gh issue list --repo <repo> --search "<title> in:title" --state open --json number,title`). Reuse it when it exists, so a resumed plan never files twice.

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
- Forks: each with its class and evidence.
