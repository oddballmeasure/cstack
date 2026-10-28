# cstack

Agent-only coding harness for Claude Code. It combines Cardinal's issue lifecycle and gates, pstack's playbooks and verification, and tstack's proof and PR discipline.

Status: Phase 8 (scale). `/cstack:program` runs a guideline prompt from spec to a merged, verified SHA. Phase 8 adds the scout, the polling daemon, deploy, and the self-improvement skills. `docs/cardinal-parity.md` maps each Cardinal capability to its cstack owner and proof, and marks what is not live-tested yet. See the plan: https://claude.ai/artifact/TJdT2EKGEKWQte5LAvrqq3. Decisions are in `docs/adr/`.

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

## Unattended work

- **Scout.** `/cstack:scout` proposes small, verified issues labelled `cstack:proposed`. Approve one by swapping the label for `cstack:ready`. Close it with a comment to reject it; the next pass reads why. Settings are under `scout` in `.cstack/config.json`. The default autonomy is `propose`.
- **Daemon.** `/loop 10m /cstack:daemon` in a session started as `CSTACK_COORDINATOR=1 claude` works every `cstack:ready` issue as a detached worker. For a service, use `skills/daemon/references/cstack-daemon@.service` (instructions in `skills/daemon/SKILL.md`). Set `retry_after_hours` (24 or more) to requeue retryable failures.
- **Deploy.** `cstack:deploy` runs a merged revision's committed `deploy.sh` and `deploy.json` once, then polls health. Configure `deploy` in `.cstack/config.json`. A person approves each deploy unless `deploy.auto` is true.

## Tests

- `node tests/lint/lint.mjs`, `npm test`, `npm run coverage:gates` (100% line and branch on the gates).
- L3 scenarios: `tests/scenarios/README.md`.
- L4 fixture programs: `tests/fixtures/README.md`.
