---
name: verify-head
description: "Use when a cstack unit has passed check-commit and needs a verdict at its exact HEAD. Spawns one read-only verifier subagent on a different model than the coder, gates its verdict file with check-verdict.mjs, and records only the gate's result in the ledger keyed by (unit, sha). A rejected verdict goes to cstack:repair."
---

<!-- Adapted from pstack skills/principle-prove-it-works/SKILL.md @ 519d36a (MIT, Lauren Tan). -->
<!-- Based on Cardinal's coder/verifier roles. -->

# Verify the head

The unit coordinator runs this skill at stage 6 of [the unit flow](../../docs/unit-flow.md). A verifier that never wrote the code checks the real artifact at one exact commit. The `check-verdict.mjs` gate decides. The ledger records what the gate decided, never what the verifier said.

## Inputs

- Plugin root (two directories up from this skill's base directory), repo root, store, unit id, issue `N`, base branch, worktree.
- Requirement ids for the unit. Standalone: every id in `<store>/intake-<unit>.json`. Under orchestrate: the ids in the unit's brief.
- Lane ids from `node <root>/gates/orch.mjs --store <store> unit get <unit>`. Empty means no e2e lanes.
- PR number from the same `unit get`, if one exists.

## Steps

### 1. Pin the head

```sh
sha=$(git -C <worktree> rev-parse HEAD)
```

The tree must be clean (`git status --porcelain` prints nothing). If it is not, stop. check-commit should have caught it. Run `cstack:implement-ticket` again for the last ticket.

The verdict path is `<store>/verdict-<unit>-<sha12>.json`, where `sha12` is the first 12 characters of `sha`.

### 2. Pick the judge model

Read config `models.judge` and `models.code`. The verifier must not share the coder's model where another is available. If they are equal, or both are `inherit`, use the first of `fable`, `opus`, `sonnet` that differs from the coder's model. Log the substitution with `cstack:show-me-your-work`. If `judge` is `inherit` and `code` is not, omit `model`.

### 3. Spawn one verifier

Spawn exactly one `Agent`:

- `subagent_type`: `cstack-verifier`, the plugin's verifier agent. Claude Code lists it with the plugin prefix.
- `model`: from step 2.
- No `isolation`. It reads the unit worktree at `sha`.
- No `run_in_background`. Wait for the completion notification. Do not poll.

Brief:

```
GOAL
Judge whether unit <unit> at HEAD <sha> delivers every requirement of issue #<N>.

SCOPE
Worktree: <worktree> at <sha>. Read-only.
Diff: git -C <worktree> diff origin/<base>...<sha>
Requirements: <R1: text>, <R2: text>.
Lanes: <ids or none>.

CONTEXT
Read first: <plugin root>/skills/cstack/SKILL.md
Intake: <store>/intake-<unit>.json
Earlier feedback (what was already found and fixed): <store>/feedback-<unit>.md
Verdict format: the header of <plugin root>/gates/check-verdict.mjs

ACCEPTANCE
Record exactly one verdict, as one single-quoted argument, never a heredoc: node <plugin root>/gates/record-verdict.mjs --store <store> --unit <unit> --sha <sha> --by <judge model> --verdict '<json>'. It writes <verdict path>. Nothing else changes.
head_sha is <sha>. Every requirement id above is assessed.
findings lists only unresolved problems that block approval, each specific enough to fix.

VERIFY
Run the test command yourself: <test_command>.
If lanes are given: node <plugin root>/gates/run-e2e.mjs <worktree> --sha <sha> --lanes <ids>
The coordinator then runs check-verdict.mjs on your file. It reruns the tests and rejects on any failure.

FORBIDDEN
Hidden paths (never read or list): <paths_hidden>.
No edits, no commits, no checkout, no stash, no push.

REPORT
The verdict path, the approve-or-reject call, and one line per finding.
```

### 4. Check the verifier left the tree alone

After it finishes:

- HEAD still equals `sha`. If not, the run is broken. Discard the verdict and start this skill again from step 1.
- `git -C <worktree> status --porcelain` prints nothing. If it prints anything, the verifier edited files. Discard the verdict, record `verifier-failed`, and spawn a fresh verifier once.
- The verdict file exists and carries `by`, which `record-verdict.mjs` adds. Never write, copy or edit a verdict file yourself, even to save a verdict the verifier reported in its reply: a verdict on disk must come from the verifier through the gate (cstack#41). With no recorded verdict, spawn a fresh verifier once. A second miss is failure `verification`.

### 5. Gate the verdict

```sh
node <root>/gates/check-verdict.mjs <worktree> --verdict <verdict path> --base origin/<base> --requirements <R1,R2> [--lanes <ids>] --json
```

- Exit 0. The verdict is `approved`.
- Exit 1. The verdict is `rejected`.
- Exit 2 (the file is missing or does not parse). Spawn one fresh verifier with the gate's error in the brief. A second exit 2 is `verifier-failed`, and the unit stops with failure `invalid_output`.

### 6. Record the gate's result

```sh
node <root>/gates/orch.mjs --store <store> ledger record <unit> <sha> <approved|rejected|verifier-failed> \
  --evidence <verdict path> [--pr <n>] --verifier <model used>
```

Record only the gate's result. Never record `approved` on the verifier's word. Log one row with `cstack:show-me-your-work`: the verdict, the SHA, the verdict path.

### 7. Route

- **approved.** Return to the caller. Next is `cstack:sync-base`.
- **rejected.** Run `cstack:repair` with source `verify` and the gate's findings (`check: detail` each). It returns `retry REPAIR-<n>` or `exhausted verification`.

## The verdict is void after any new commit

The ledger key is `(unit, sha)`. Any later commit (a repair, a SYNC merge, a CI fix) leaves the new HEAD with no verdict. Before publish, the caller runs `node <root>/gates/orch.mjs --store <store> ledger check <unit> <HEAD>`. Exit 0 is the only pass. Anything else means run this skill again.
