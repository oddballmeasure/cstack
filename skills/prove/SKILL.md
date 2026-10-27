---
name: prove
description: "Use when a cstack ticket, repair or PR is about to be called done, or anyone is about to claim a change works. Reproduce the failure, fix, then run the same reproduction and watch it pass. Saves the evidence under the run store. When no proof method exists, it says so instead of claiming."
---

<!-- Adapted from tstack skills/full-send/SKILL.md @ 92e38e2 (MIT, Theo Browne). Proof section. -->

# Prove

Proof is evidence you observed yourself in this session: command output, a reproduction, or a screenshot. A claim without it is a model claim (rule 1 of the [cstack mode skill](../cstack/SKILL.md)). Read that skill first, and [Prove It Works](../cstack/references/principles/prove-it-works.md).

Green mocked tests do not prove user-visible behaviour. A test that stubs the part the user touches proves only the code around the stub.

## Where evidence goes

Save every piece under `<store>/evidence/`. `<store>` is the run store, `<repo root>/.cstack/runs/<slug>/`, as an absolute path. A brief gives you this path. Outside a run, use `<repo root>/.cstack/runs/adhoc/`.

Name each file `<unit>-<ticket>-<n>-<phase>.<ext>`:

- `<unit>` and `<ticket>` are the ids from the brief (`U1`, `T1`, `REPAIR-1`). Outside a run, use a short slug for both.
- `<n>` counts proofs for this ticket, from 1.
- `<phase>` is `before` or `after`.
- `<ext>` is `txt` for command output and `png` for a screenshot.

Capture command output with the command line, the head commit and the exit code in the file:

```sh
f=<store>/evidence/U1-T1-1-before.txt
mkdir -p "$(dirname "$f")"
{ echo "\$ <command>"; echo "head $(git rev-parse HEAD)"; <command>; echo "exit $?"; } >"$f" 2>&1
```

The before and after files of one proof carry the same first line. That is how a verifier checks that you ran the same reproduction.

## Procedure

1. **Pick the most direct method the change allows.** In order of preference:
   - Reproduce the original failure, fix, then watch the same reproduction pass.
   - For new behaviour, run the user-visible path (CLI command, HTTP request, browser step) and show the new output. The before file shows the old output or the error.
   - Add one focused test that fails without the change, when the behaviour has none and the repo has a test setup. Use `cstack:tdd`.
   - Run the checks that the repo's CI runs (config `test_command`, typecheck, lint). These support a proof. Alone they prove only that nothing known broke.
   - For UI and runtime behaviour, run the app and look at the change. Save a screenshot when you can take one.
2. **Capture before.** Run the reproduction on the unfixed code. Save it as `before`. Confirm it fails for the reason in the ticket. If it passes, or fails for another reason, fix the reproduction first. Do not touch the product code yet.
3. **Fix.** Make the change.
4. **Capture after.** Run the identical reproduction. Save it as `after`. Confirm it passes.
5. **Check the claim against the files.** Read both files back. The command lines match. The exit codes and outputs show the change. Fix what does not match.

A reproduction that passed before the fix proves nothing. Say so and find a better one.

## When no proof method exists

Some changes have no reachable proof here: a production-only path, hardware, a third-party service, or behaviour with no observable output. Then:

1. Do not claim the change works. Do not write "verified", "tested" or "works".
2. Write `<store>/evidence/<unit>-<ticket>-unproven.md`. Give the change, every method you tried, why each one could not prove it, and the closest check you did run.
3. Put `unproven: <one line reason>` in your report. The verifier and the PR body carry this line forward.

An unproven change is not a failure by itself. Hiding it is.

## Report

For each proof, give:

- The method, in one line.
- The before and after file paths.
- The observed result, labelled measured.

For a PR body, add one short line that says how the change was proved, or the `unproven:` line.
