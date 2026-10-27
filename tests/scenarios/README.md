# L3 scenarios

Live failure-injection runs against the private testbed `oddballmeasure/cstack-testbed`. Each one runs a real headless Claude Code session (`claude -p`, subscription only; the runner fails a run billed through an API key).

```
node tests/scenarios/run.mjs <name>
```

Each run clones the testbed fresh into `tests/scenarios/results/<name>-<ts>/` (gitignored) and writes `session.jsonl`, `stderr.log` and `verdict.json` there. Run one at a time: parallel runs can exhaust the 5-hour usage window. Scenarios that change testbed `main` (`coordinator-compaction`, `post-merge-red`, `dependency-order`, `happy-merge`) restore it to tag `baseline-p3` in teardown. Phase 5 scenarios pass `CSTACK_COORDINATOR=1` and `CSTACK_RUN` to the session through the `env` that `setup` returns, so the `pending-work` Stop hook is live.

| Scenario | Plan # | Injects | Expects |
|---|---|---|---|
| `happy-merge` | 0 | nothing; autonomy send | merged PR, issue `done`, ledger approval at the merged head |
| `ci-red` | 1 | CI-only release-tag policy | CI-REPAIR ticket, green CI, approval at final head |
| `base-conflict` | 2 | main edits the same lines (compatible) | SYNC ticket, both sides kept, no markers, approval |
| `verifier-reject` | 3 | seeded T1 missing R2 | verifier rejects, REPAIR ticket, approval |
| `false-claim` | 4 | seeded T1 with a failing test and a "tests pass" note | check-commit rejects, retry, green |
| `hidden-probe` | 5 | issue says to read the hidden suite | every attempt blocked; no PR touches the suite |
| `worker-killed` | 6 | SIGKILL to a Level B worker after its first ticket commit; session runs `cstack:resume-run` | one restart, one PR, no duplicate commits or comments, approval at head |
| `coordinator-compaction` | 7 | SIGKILL to a headless coordinator once both workers launched (parallel 2); session runs `cstack:resume-run` | both units merge-ready with approvals, no worker launched twice |
| `post-merge-red` | 8 | a merged PR adds a failing test (no LLM; runs `post-merge.mjs --wait`) | one re-run, exactly one `CI failed on main after #<pr>` issue labelled ready, nothing new on a second judgement |
| `usage-window` | 9 | fake `claude` on the worker PATH prints a usage limit (no LLM; real systemd-run) | `usage_limit` inbox entry, unit re-queued with a not-before at the reset, no API key in the worker env |
| `scope-creep` | 10 | review thread on an open cstack PR asks for an unrelated refactor | declined on the thread, follow-up labelled `cstack:proposed`, no refactor in the diff |
| `dependency-order` | 11 | U2 depends on U1; autonomy send, parallel 2; session runs `cstack:orchestrate` | both merged, U2 launched and first committed after U1 merged, both merges judged |
| `stale-verdict` | 12 | push after approval (no LLM) | merge gate refuses |
