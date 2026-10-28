# cstack

Agent-only coding harness for Claude Code. It combines Cardinal's issue lifecycle and gates, pstack's playbooks and verification, and tstack's proof and PR discipline.

Status: Phase 7 (program). Every phase in the plan is built: `/cstack:program` runs a guideline prompt from spec to a merged, verified SHA. See the plan: https://claude.ai/artifact/TJdT2EKGEKWQte5LAvrqq3. Decisions are in `docs/adr/`.

## Install (private)

Install at local scope, inside the repo cstack should work on. User scope would apply cstack's guard (no direct merges, no sleep loops, no hidden-suite reads) to every session on the machine.

```
claude plugin marketplace add oddballmeasure/cstack --scope local
claude plugin install cstack@cstack --scope local
```

Local development without install:

```
claude --plugin-dir /path/to/cstack
```

## Quickstart

1. In the target repo, run `/cstack:setup-cstack`. It writes `.cstack/config.json`, creates the labels, ignores the run store, and ends with `/cstack:doctor`.
2. Run a program from an idea:
   ```
   /cstack:program docs/idea.md
   ```
   The default autonomy is `send` (ADR-007): the merge gate merges each PR once CI, the independent verifier and the review loop pass. It never merges past a failing gate.
3. To merge everything yourself, set `"autonomy": "stop"` in `.cstack/config.json`, or pass `--autonomy=stop` for one run. Each PR then ends merge-ready. Merge it, then run `/cstack:program --resume <slug>`.
   In a repo whose config says `stop`, raising one run to `send` needs the variable as well as the flag (ADR-006):
   ```
   CSTACK_PROGRAM_AUTONOMY=send claude
   /cstack:program docs/idea.md --autonomy=send --parallel=2
   ```

One issue instead of an idea: `/cstack:unit <issue>`, `/cstack:full-send <issue>` or `/cstack:full-stop <issue>`. For "which skill?", ask `/cstack:cstack-help`.

## Tests

- `node tests/lint/lint.mjs`, `npm test`, `npm run coverage:gates` (100% line and branch on the gates).
- L3 scenarios: `tests/scenarios/README.md`.
- L4 fixture programs: `tests/fixtures/README.md`.
