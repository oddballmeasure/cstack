---
name: architect
description: "Use when cstack faces a one-way door (a public interface, an on-disk format, a module boundary several units build on), for example while cstack:plan cuts units. Sketches types, signatures and module structure with not-implemented bodies, runs cstack:arena for at least two structurally distinct candidates, and returns one synthesized sketch plus a rationale. Also for /cstack:architect."
argument-hint: "<task> [--run <slug>] [--checkpoint]"
---

<!-- Adapted from pstack skills/architect/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# Architect

Sketch types, function signatures, class shapes and module boundaries with `not implemented` bodies and pseudocode. Synthesize across candidates on different models, then fill in code against the chosen sketch.

Read the [cstack mode skill](../cstack/SKILL.md) first. Read config `models` with `jq` from `<repo>/.cstack/config.json`. Without a config, use the defaults in `<root>/templates/config.json` and say so. `<root>` is the plugin root, two directories up from this skill's base directory.

Under `cstack:plan`, the output is a design package that becomes the first unit, not code. Phase D then belongs to that unit's worker. Write the package to `<store>/architect/<topic>/` when a run store exists, else to `/tmp/cstack-architect/<topic>/`.

## Start

Open a TodoWrite list with one entry per phase before you start: 1 Ground, 2 Sketch, 3 Agree, 4 Implement, 5 Scrap.

## Phase A: Ground the problem

Build a real model of every system the new code touches. Run `cstack:how` over the relevant subsystems. Naming a file is not grounding. Produce the explanation `cstack:how` prescribes. If the design redefines ownership or layering, read the history of the existing shape too (`git log` on its files, the PRs that made it), so its rationale becomes a constraint, not a guess.

Explorers read code only in a sparse worktree from `gates/isolate.mjs`, never in a checkout that holds `paths_hidden`.

Skip Phase A only for greenfield work with no surrounding system.

## Phase B: Sketch

Run `cstack:arena` with the design-sketch task and the Phase A grounding. Pass [the runner prompt](references/runner-prompt.md) as each runner's brief.

Runners come from config `models`: one on `code`, one on `judge`. If both name the same model, add a third runner on `review`. A role set to `inherit` means omit `model`.

Design it twice. Require at least two structurally distinct candidates before synthesis, even when the first looks sufficient. This is [Exhaust the Design Space](../cstack/references/principles/exhaust-the-design-space.md) made concrete. Whole-shape alternatives, not point fixes inside one shape.

Screen every candidate against [the design red flags](references/design-red-flags.md) before synthesis. Assume the next contributor is an agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Prefer the design where a change that looks right from one file is right for the whole repo.

Compare viable candidates on interface depth. Prefer the design that hides more complexity behind a smaller, simpler public surface. A rich interface can keep call chains short by concentrating capability instead of scattering it across layers.

Arena returns one synthesized design package. Its synthesis note fills the rationale's "Synthesis decision" section.

## Phase C: Agree (opt-in)

Default: go straight to Phase D with the synthesized design. No human checkpoint.

Opt in when the caller passes `--checkpoint` or asks to see the design first. Then show the synthesized design and wait for sign-off with `AskUserQuestion`. Under `claude -p`, park it instead: `node <root>/gates/orch.mjs --store <store> gate park architect-<topic> --question "<one line>" --options "approve|change" --default approve`.

The synthesis can ship as its own commit either way, as the scaffold-first mode of [Foundational Thinking](../cstack/references/principles/foundational-thinking.md). Planned and scoped breakage during fill-in is fine, per [Outcome-Oriented Execution](../cstack/references/principles/outcome-oriented-execution.md).

If the human pushes back on the shape, treat that as Phase A evidence. Ground again and re-run Phase B before writing more code.

## Phase D: Implement against the sketch

Replace `not implemented` bodies with code, and pseudocode with logic. Under cstack the plugin's `cstack-worker` agent does this inside a unit, through `cstack:implement-ticket`. The sketch is the contract. A deviation is a signal to surface, not friction to absorb. If a function needs a parameter the sketch did not anticipate, ask whether the sketch was wrong, the requirement was missed, or the implementation is overreaching.

## Phase E: Scrap when the architecture is wrong

If implementation keeps producing friction the sketch cannot absorb, throw the sketch out. Do not bolt fixes onto a wrong design, per [Redesign from First Principles](../cstack/references/principles/redesign-from-first-principles.md) and [Fix Root Causes](../cstack/references/principles/fix-root-causes.md).

The signal is a pattern, not one instance:

- The same shape of workaround appears across unrelated code.
- Several unrelated edge cases each need a special-case branch.
- Types need escape hatches (`any`, casts, optional fields that are always set) to compile.
- The "we need a lock" reflex appears where the sketch said the state was not shared.
- Callers must know the abstraction's internal rules to use it.
- Two or more independent Phase D deviations have the same shape.

Use judgment. A few edge cases do not condemn an architecture. Complexity in the data is not complexity in the design.

When you scrap:

1. Run `cstack:how` again over what was built.
2. Redesign as if the new constraints had been day-one assumptions.
3. Subtract before you add, per [Subtract Before You Add](../cstack/references/principles/subtract-before-you-add.md). The new sketch is smaller than the old one before it grows.
4. Return to Phase B and run arena again.

## Outputs

Write the caller's usage first and derive the type sketch from it. For a small change: one file with the new types and signatures. For larger work: a module map plus type definitions. The rationale ships beside it, shaped per [the rationale template](references/rationale-template.md), including the usage sketch and the synthesis decision.

Log the decision with `cstack:show-me-your-work`: the chosen shape, the runner models, and the package path.
