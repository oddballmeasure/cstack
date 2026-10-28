---
name: cstack-help
description: "Use when the user asks how to use cstack rather than asking it to do work: which cstack skill fits a situation, how to set cstack up, how /cstack:program, /cstack:unit, full-send and full-stop differ, what the principles are, or how the scenarios and evals test cstack. Answers with a prompt the user can send and the file the answer came from. Never starts the work. Also for /cstack:cstack-help <question>."
argument-hint: "[<question>]"
---

<!-- Adapted from pstack skills/poteto-help/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# cstack help

Answer the user's question about cstack, hand them a prompt they can send, and name the file the answer came from. For a help question, do not start the work. The user asked how, and a cstack run spends real usage, so let them send the prompt.

A message that asks for work, such as "use cstack to fix issue 12", is not a help question. Route it per the [cstack mode skill](../cstack/SKILL.md) and do the work there.

This file maps questions to the skills that hold the answers. Those files own the details. Read the file you route to before you quote it, and trust it when it disagrees with this map. Give the user the path inside the plugin, for example `skills/program/SKILL.md`.

## Find out what they need

Infer the need from the message. A named situation, such as "which skill reviews a PR?", goes straight to its section. If the need is still unclear, ask one `AskUserQuestion` with these options, then answer only the section they pick:

- Get set up
- Run a whole program from an idea
- Work one issue
- Pick a skill for a situation
- Fix a run that went wrong
- Test cstack itself

Check the state that changes the answer, and mention it only when it does:

- No `.cstack/config.json` in the repo means `/cstack:setup-cstack` has not run. Every skill then uses the defaults in `templates/config.json`.
- No `.claude/skills/verify-<app>/` in the repo means agents have no scripted way to drive the app. Mention `cstack:create-verification-skill` when the question is about proving a change works in a browser or a long-running service.

## Get set up

1. Install at local scope inside the repo cstack should work on. User scope would apply cstack's guard to every session on the machine. The commands are in `README.md`.
2. Run `/cstack:setup-cstack`. It writes `.cstack/config.json` (base branch, test command, hidden paths, required checks, model roles, autonomy), creates the labels, ignores the run store, and ends with `cstack:doctor`.
3. When something looks wrong, run `cstack:doctor`. It is read-only.

`autonomy` defaults to `send`: the merge gate merges once CI, the verifier and the review loop pass. `stop` makes cstack end every PR merge-ready for you to merge.

## Run a whole program

`/cstack:program <guideline text or path>` runs the pipeline in `skills/program/SKILL.md`: preflight, spec (H1), profile, the hidden e2e suite as PR #0, plan (H2), orchestrated units, post-merge CI, a final e2e proof at the merged SHA by an agent that wrote no code, a council review, and an audited report.

- `--autonomy=send` merges through the merge gate and skips H2. It needs a session the human launched with `CSTACK_PROGRAM_AUTONOMY=send` (ADR-006), else it stays `stop`.
- `--autonomy=stop` ends at each merge-ready PR. Merge it, then `/cstack:program --resume <slug>`.
- `--parallel=N` runs up to N units at once as detached workers.
- A good guideline states the problem, the users, the goals, the non-goals, and end-to-end requirements with exact outputs. A thin one gets `cstack:sharpen` first. `tests/fixtures/f1-cli-ledger/guideline.md` is a worked example.

## Work one issue

`/cstack:unit <issue>` runs one GitHub issue through the 13 stages in `docs/unit-flow.md`: claim, isolate, profile, intake, implement, verify, sync, publish, PR, babysit with review, merge gate, settle.

- `/cstack:full-send <issue>` is the same with autonomy `send` for this run. It merges when the gate passes.
- `/cstack:full-stop <issue>` is the same with autonomy `stop` for this run. It ends with Ready to merge, Waiting for required approval, or Blocked.

## Pick a skill

The default answer is `/cstack:program` for an idea and `/cstack:unit` for an issue. They run most of the others. Name a skill directly when the user wants one part on its own. Read the skill before you recommend it, and give one example prompt.

| The user wants to | Skill |
|---|---|
| Turn an idea into a spec with requirement ids | `cstack:spec` (after `cstack:sharpen` for a thin idea) |
| Get a hidden end-to-end suite for a spec | `cstack:e2e-plan` |
| Cut a spec into units and issues | `cstack:plan` |
| Settle a one-way door, or get several attempts at one artifact | `cstack:architect`, `cstack:arena` |
| Settle a factual question by running something | `cstack:prototype` |
| Run a planned set of units to the end | `cstack:orchestrate` |
| Pick up a run after a crash or a pause | `cstack:resume-run` |
| Pause a run safely | `cstack:pause-safely` |
| See how a run is going | `cstack:status` |
| Know how code works, or where new code should live | `cstack:how` |
| Fix a bug test-first | `cstack:tdd` |
| Prove a change works, before and after | `cstack:prove` |
| Review a diff in rounds until it is clean | `cstack:review-loop` |
| Get three scored opinions on a change or a design | `cstack:council` |
| Tear a change apart from several angles | `cstack:interrogate` |
| Know what a small diff could break | `cstack:blast-radius` |
| Strip narration comments from a diff | `cstack:no-comments` |
| Reply on a PR thread | `cstack:leaving-pr-comments` |
| Judge a merge commit's CI on the base branch | `cstack:post-merge-ci` |
| Give agents a scripted way to drive the app | `cstack:create-verification-skill`, then `cstack:maintain-verification-skill` |
| Keep and audit a decision log | `cstack:show-me-your-work` |
| Clean AI tells out of prose, or write docs to a standard | `cstack:unslop`, `cstack:technical-writing` |

The unit stages (`cstack:intake`, `cstack:implement-ticket`, `cstack:repair`, `cstack:verify-head`, `cstack:sync-base`, `cstack:file-pr`, `cstack:babysit-pr`, `cstack:merge-gate`, `cstack:settle`, `cstack:profile-repo`) run inside `cstack:unit`. The user rarely calls one alone. If a skill directory is missing from this table, read its frontmatter and route by its description.

Close calls:

- `cstack:review-loop` gates a merge: one reviewer per round on a different model, with a ledger. `cstack:council` gives three scored opinions and changes nothing. `cstack:interrogate` attacks a change from several angles and changes nothing.
- `cstack:interrogate` reviews the diff. `cstack:blast-radius` looks for breakage outside the diff.
- `cstack:resume-run` continues a run. `cstack:status` only reports on it.

## The principles

The mode skill (`skills/cstack/SKILL.md`) holds ten non-negotiables and 24 principles under `skills/cstack/references/principles/`. The core ones: models find and argue, gates decide; proof is evidence observed in this session; only a non-author verdict counts; implementers never read the hidden suite; progress lives in git and the run store. Users steer with the names, as in "apply prove it works, show me the real output".

## Fix a run that went wrong

| Symptom | Fix |
|---|---|
| A hook blocked a command | Read the rule name in the message (`hidden-paths`, `off-limits`, `no-sleep-loops`, `no-admin-merge`, `no-autonomy-raise`). Run `cstack:doctor` before changing anything. |
| `--autonomy=send` did not merge | The session lacked `CSTACK_PROGRAM_AUTONOMY=send`. `node <root>/gates/run-settings.mjs --store <store>` prints why. Relaunch with it set. |
| The coordinator stopped mid-run | `/cstack:program --resume <slug>`, or `cstack:resume-run <slug>` for a plain orchestrate run. |
| A unit hit the usage limit | Nothing. The worker re-queues it after the reset. |
| The program ended at PR #0 | Autonomy `stop`. Merge PR #0, then resume. |
| A unit is `needs-human` | Read its issue comment. It holds the question and the options. |

## Test cstack itself

- **L0 lint and L1 gates.** `node tests/lint/lint.mjs`, `npm test`, `npm run coverage:gates` (100% line and branch).
- **L2 evals.** `evals/<case>/` with `claude plugin eval`, as ADR-005 describes. Always pass `--no-publish`.
- **L3 scenarios.** `node tests/scenarios/run.mjs <name>` against the private testbed. One at a time. `tests/scenarios/README.md` lists them.
- **L4 fixtures.** `node tests/fixtures/run-fixture.mjs f1-cli-ledger` runs a whole program on the testbed and grades it with a held-out suite. `tests/fixtures/README.md` has the details.

## Reply

Lead with the answer. Give at most one example prompt in a code block, adapted from [the recipes](references/recipes.md) when one fits. Keep it short unless the user asked for the whole map.
