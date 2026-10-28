# ADR-007: cstack defaults to full send

Date: 2026-10-28.

## Decision

`templates/config.json` and `cstack:setup-cstack` now default `autonomy` to `send`. The merge gate merges a PR only when every check passes: the ledger approval at the exact head, the review-loop APPROVE, required CI, no change requests, a clean merge state and no base drift. `stop` stays available per repo (config) and per run (`--autonomy=stop`, `cstack:full-stop`).

## Why

The maintainer decided this on 2026-10-28, after Phases 0-7 passed. The decision from the start was "full-stop until approved, then straight to full-send". The f1 L4 run merged 3 PRs under `send`, through the gates, and the held-out grader scored 24/24.

## What does not change

- ADR-006 still holds. A run can lower autonomy from `run.json`. Raising a `stop` repo to `send` for one run still needs `CSTACK_PROGRAM_AUTONOMY=send` in the environment of the human-launched session.
- The guard still blocks every direct `gh pr merge`. Only the gate merges.
- Existing repos keep the autonomy their config states. The testbed config is explicitly `stop`, because the L3 scenarios expect merge-ready PRs.
