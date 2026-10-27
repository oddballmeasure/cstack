---
name: post-merge-ci
description: "Use when a cstack run merged a unit and the base branch's CI on the merge commit must be judged, for example after each merge under cstack:orchestrate and at the run's close. Runs gates/post-merge.mjs: re-runs a red merge's failed Actions runs once, then files exactly one follow-up issue (labelled ready, or needs-human when the merged change was itself a post-merge follow-up)."
argument-hint: "--run <slug> [--wait]"
---

<!-- Adapted from Cardinal src/cardinal/daemon/post_merge.py (oddballmeasure/cardinal, same owner). -->

# Post-merge CI

A unit merges when its required checks pass on the PR head. Slower checks, and the base branch's own CI on the merge commit, finish later. This skill judges them. It never fixes code. A red base becomes a follow-up issue that a later unit works like any other.

`<root>` is the plugin root, two directories up from this skill's base directory. `<store>` is `<repo>/.cstack/runs/<slug>`, absolute.

## The gate

```sh
node <root>/gates/post-merge.mjs --store <store> --json
```

It reads every unit in state `merged` or `done` with a PR, takes the merge commit and merge time from GitHub, and judges each merge once. Its verdicts, kept in `<store>/post-merge.tsv`:

| State | Meaning |
|---|---|
| `waiting` | Checks still run, a re-run has not replaced its failed check yet, or no check is listed yet (first 10 minutes). |
| `rerun` | Failed Actions runs were re-run once with `gh run rerun <id> --failed`. Waiting for the result. |
| `passed` | Every check concluded success, skipped or neutral. |
| `no_checks` | No check was listed 10 minutes after the merge. |
| `filed` | Failed again after the re-run (or could not be re-run): one issue `CI failed on <base> after #<pr>: <checks>` with each check's log tail. |
| `expired` | No verdict 6 hours after the merge. |
| `filing` | A crash hit between the `filing` row and the issue. The gate never files it again. |
| `file-error` | `gh issue create` failed. The next run tries again without re-running CI. |

The follow-up is labelled `<prefix>:ready`, so the next program pass or a standalone `cstack:unit` picks it up. When the merged unit's issue was itself such a follow-up, the label is `<prefix>:needs-human`, so cstack never chases its own tail.

Exit 0: nothing red. Exit 1: a merge is `filed`, `filing`, `expired` or `file-error`. The `pending` count says how many merges still wait.

## Procedure

1. Run the gate. Read `pending` and each merge's state.
2. While `pending` is above 0, wait for it under the `Monitor` tool, never with `sleep`:
   - command: `node <root>/gates/post-merge.mjs --store <store> --wait`
   - timeout_ms: `3600000`
   It judges again every minute and prints its report when nothing waits. Under `cstack:orchestrate` mid-run, do not block the program on it. Run the gate once per drain instead, and use `--wait` only at Close.
3. For each red merge, log one row with `cstack:show-me-your-work`: the PR, the merge SHA, the state, the follow-up issue.
   - `filed`: report the issue and its label.
   - `filing`: search the repo for an issue with the title from the row (`gh issue list --repo <repo> --search "<title> in:title" --state all`). Report what you find. Do not file one by hand without the human.
   - `expired`: report the merge. Its checks never finished.
   - `file-error`: run the gate again once. If it fails again, report the error.

## Report

One line per merge: `#<pr> <merge sha12> <state>`, plus each follow-up issue with its label.
