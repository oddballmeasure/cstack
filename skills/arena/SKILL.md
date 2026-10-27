---
name: arena
description: "Use when cstack must not lock in one attempt at a non-trivial artifact, for example a one-way-door design from cstack:architect or a contested unit split in cstack:plan. Spawns N parallel candidates on models from config, has a judge on another model score them, picks a base and grafts the best parts of the others. Also for /cstack:arena."
argument-hint: "<task> [--n <count>]"
---

<!-- Adapted from pstack skills/arena/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# Arena

Read the [cstack mode skill](../cstack/SKILL.md) first. Read config `models` with `jq` from `<repo>/.cstack/config.json`. Without a config, use the defaults in `<root>/templates/config.json` and say so. `<root>` is the plugin root, two directories up from this skill's base directory.

Open a TodoWrite list with one entry per phase before you launch anything: Frame, Fan out, Cross-judge, Pick, Graft, Verify.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate produces.
2. Derive the rubric: 3 to 6 concrete, gradeable criteria for success on this task. It is the picker's tool in Phase D. Candidates see only the task.
3. Pick the runners from config `models`. Default: one runner on `code` and one on `judge`. If both name the same model, add one on `review`. A role set to `inherit` means omit `model`. Add runners when the arena covers several design directions. Use the same model N times when the work is generation-bound rather than judgment-sensitive.
4. Give each candidate its own output location, per [Separate Before Serializing Shared State](../cstack/references/principles/separate-before-serializing-shared-state.md). A writer gets `isolation: "worktree"`. A design candidate writes to `<out>/candidate-<n>/`, where `<out>` is `<store>/arena/<topic>/` in a run, else `/tmp/cstack-arena/<topic>/`.

## Phase B: Fan out

Spawn all N subagents in one message with the `Agent` tool. Use `subagent_type: "general-purpose"` for candidates that write files. Each brief has the headings GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, FORBIDDEN, REPORT and holds: the task, the path to the shared grounding, the candidate's own output path, the mode skill's absolute path (read it first), config `paths_hidden` and `paths_off_limits` under FORBIDDEN, and the instruction to produce the artifact plus a short rationale that names the alternatives it considered and what it rejected.

Agents run in the background and notify you when they finish. Wait for the notifications. Do not poll.

If a candidate produces no output, go on with N-1 and note the dropout.

## Phase C: Cross-judge

After every candidate has finished, spawn one read-only judge (`subagent_type: "Explore"`, brief says "do not edit files"). Its model is a config role not used by any runner, `review` by default. If every role names the same model, use it and note that the judge shares the runners' model. The judge sees the rubric and the candidates by path label, scores each criterion, and recommends a base with its reasons. It runs while you read in Phase D.

## Phase D: Pick a base

Read every candidate end to end before you pick. Score each against the rubric criterion by criterion, not on overall feel, and compare with the judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both reasonings before you decide.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or the smaller API, per the [Laziness Protocol](../cstack/references/principles/laziness-protocol.md).

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand so the result stays coherent under one model, per [Redesign from First Principles](../cstack/references/principles/redesign-from-first-principles.md). Do not paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. If they diverge wildly, Phase A was under-specified. Reframe and run again rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per [Prove It Works](../cstack/references/principles/prove-it-works.md). If verification finds a problem the arena missed, either Phase A was wrong (reframe and run again) or a candidate caught it and you missed the graft (go back to Phase E).

## Outputs

One synthesized artifact, with a short synthesis note beside it: the base and why, the judge's verdict and model, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result. Log the pick with `cstack:show-me-your-work`.
