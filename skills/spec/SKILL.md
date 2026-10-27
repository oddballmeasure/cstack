---
name: spec
description: "Use when cstack needs a spec from a guideline prompt (text or a file path), for example at step 1 of a program run. Writes <store>/spec.md per templates/spec.md: problem, users, goals, non-goals, requirements R1..Rn, e2e requirements E1..En with Covers lines, constraints and a measurable done predicate. Batches every open question into one AskUserQuestion call with a default per question (headless: takes the defaults and logs them). Ends when gates/check-spec.mjs passes."
argument-hint: "<guideline text or path> [--run <slug>]"
---

# Spec

This skill turns a guideline prompt into one spec file that the gate `gates/check-spec.mjs` accepts. The spec is the contract for everything after it: `cstack:e2e-plan` turns each E requirement into hidden e2e lanes, and the plan assigns those lanes to units. A vague requirement here becomes a weak lane later. Write for that reader.

This skill does not design or implement anything. It reads the repo only to ground constraints.

## Names

Shell variables do not persist between Bash calls. Resolve each name once and write the absolute value into every command.

| Name | Value |
|---|---|
| `<root>` | The plugin root, two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<slug>` | The `--run` slug from the caller. Without one, derive it from the guideline title: lowercase, every run of non-alphanumerics to `-`, at most 40 characters. |
| `<store>` | `<repo>/.cstack/runs/<slug>/`, absolute. Create it with `mkdir -p`. |
| `<log>` | `sh <root>/skills/show-me-your-work/scripts/log.sh <store>/decisions.tsv` |

## Procedure

1. Read the [cstack mode skill](../cstack/SKILL.md) and the template `<root>/templates/spec.md`. The template's comment block is the format contract. Keep its eight `## ` headings, spelled exactly.
2. **Read the guideline.** If the argument is a readable file path, read the file. Else the argument is the guideline text. Copy it unchanged to `<store>/guideline.md` so a resumed run starts from the same words. If `<store>/spec.md` already exists and passes the gate, report it and stop. Do not rewrite an approved spec.
3. **Read the repo to ground constraints.** Use it only for facts the spec must respect: language and runtime version, test command, entry points that already exist, config `paths_hidden`, and anything the guideline names. Read `<repo>/.cstack/profile.json` if it exists. For a question the profile cannot answer, use `cstack:how`. Explorers read code only inside a sparse worktree made by `gates/isolate.mjs`, never in the main checkout, so they never see `paths_hidden`. For an empty or new repo, skip this step and say so in the decision log.
4. **Write the spec** to `<store>/spec.md`. Follow **Writing each section**.
5. **Collect open questions** (see **Open questions**). Ask them in one batch, or take the defaults in a headless run. Apply the answers to the spec.
6. **Run the gate:**
   ```sh
   node <root>/gates/check-spec.mjs <store>/spec.md --json
   ```
   On rejection, fix the spec from the gate's findings and run the gate again. Allow at most 2 retries. A third rejection is failure `invalid_output`: stop and report the findings.
7. **Log** with `cstack:show-me-your-work`. One row for the spec (evidence: the spec path and the gate's last line), one row per failed gate run, one row per question with the answer or the default taken, and one row per derived E requirement.

## Writing each section

- **Problem.** Two or three sentences. Who hurts, and how. No solution words.
- **Users.** One bullet per user type. Name what they already use.
- **Goals.** Outcomes a user can observe. Each goal leads to at least one requirement.
- **Non-goals.** Copy the guideline's exclusions. Add each extra that a reasonable implementer would build on their own, so nobody builds it. "None." only when nothing tempts.
- **Requirements.** Every non-blank line is exactly `- R<n>: <one observable behaviour>`, numbered from R1 with no gaps. The gate rejects any other line in this section.
  - One behaviour per R, observable at the product's surface: a command and its output, a response, a screen, a file the user reads.
  - Put exact values in backticks: output text, exit codes, status codes, file formats. Copy them from the guideline verbatim. Never round or paraphrase an exact value.
  - Name the failure behaviour in the same R as its success path, or in its own R. `cstack:e2e-plan` needs a negative lane for every R, so every R needs a way to fail.
  - Describe behaviour, never implementation (no module names, no data structures).
- **E2E requirements.** Every E is `- E<n>: <a user-visible flow>` on one line, followed by an indented `  Covers: R1, R3` line. Number from E1 with no gaps.
  - An E is a flow a user runs from start to end through the real surface. It names the starting state, the actions, and the visible result.
  - Every R appears in at least one Covers line. Covers names only R ids that exist.
  - Keep the guideline's own e2e requirements as the first E ids, in its order.
- **Constraints.** Runtime and versions, dependency rules, file locations, entry points, platform limits. From the guideline first, then the repo facts from step 3.
- **Done predicate.** One falsifiable sentence. It names a number or an `exact value` and contains "pass" or "when". Prefer the hidden suite as the judge, for example: "Done when all `<n>` lanes in e2e-plan.md pass at the base branch head through `e2e_command`, and `<test command>` exits 0." If the lane count is not known yet, name the E count instead.

No `TBD` or `TODO` outside HTML comments. The gate rejects them. An unknown is an open question, not a placeholder.

## A guideline with no e2e requirements

Derive them from the goals. Write one E per goal as the flow a user runs to reach that goal, then add Covers lines until every R is covered. Log one row per derived E:

```sh
<log> "spec" "derived E<n> from goal '<goal>'" "the guideline has no e2e requirements" "<store>/spec.md" "derived"
```

Also ask about them in the question batch, with "keep the derived E requirements" as the default.

## Open questions

An open question is a product or preference call that changes a requirement, a non-goal or the done predicate, and that the guideline and the repo cannot answer. Classify first, as the mode skill says: if running something can answer it, run it and do not ask.

Gather every open question first, then ask once.

- Put all of them in **one** `AskUserQuestion` call. Never ask a second time in this skill. The tool takes at most 4 questions per call. With more than 4, ask the 4 that change the most requirements, and take the defaults for the rest.
- Every question has a default. Write the spec with the defaults first, so the spec is complete before you ask. Make the default the first option and end its label with `(default)`.
- Each option says what changes in the spec, for example "R4 rejects amounts above 1,000,000 with exit 2".

**Headless runs.** Under `claude -p` there is no `AskUserQuestion` tool. Do not ask in plain text and wait. Take every default and log each one:

```sh
<log> "spec" "<question> -> <default>" "headless run, AskUserQuestion unavailable, default taken" "<store>/spec.md" "default"
```

List the defaults taken in your report, first, so the human can overturn one at the spec approval gate.

## Report

- The spec path and the gate's last line.
- Counts: R requirements, E requirements, derived E requirements.
- Questions asked and their answers, or defaults taken (headless).
- Anything in the guideline you left out on purpose, and why.
