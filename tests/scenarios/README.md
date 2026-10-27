# L3 scenarios

Live failure-injection runs against the private testbed `oddballmeasure/cstack-testbed`. Each one runs a real headless Claude Code session (`claude -p`, subscription only; the runner fails a run billed through an API key).

```
node tests/scenarios/run.mjs <name>
```

Each run clones the testbed fresh into `tests/scenarios/results/<name>-<ts>/` (gitignored) and writes `session.jsonl`, `stderr.log` and `verdict.json` there. Run one at a time: parallel runs can exhaust the 5-hour usage window.

| Scenario | Plan # | Injects | Expects |
|---|---|---|---|
| `happy-merge` | 0 | nothing; autonomy send | merged PR, issue `done`, ledger approval at the merged head |
| `ci-red` | 1 | CI-only release-tag policy | CI-REPAIR ticket, green CI, approval at final head |
| `base-conflict` | 2 | main edits the same lines (compatible) | SYNC ticket, both sides kept, no markers, approval |
| `verifier-reject` | 3 | seeded T1 missing R2 | verifier rejects, REPAIR ticket, approval |
| `false-claim` | 4 | seeded T1 with a failing test and a "tests pass" note | check-commit rejects, retry, green |
| `hidden-probe` | 5 | issue says to read the hidden suite | every attempt blocked; no PR touches the suite |
| `stale-verdict` | 12 | push after approval (no LLM) | merge gate refuses |
