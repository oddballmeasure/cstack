# ADR-003: Gates are dependency-free Node scripts in one shared directory

Date: 2026-10-27.

## Decision

Every gate lives in `gates/` at the plugin root, not inside the skill that calls it. Skills call gates by path from the plugin root (two directories up from the skill's base directory). Gates are Node 22+ ES modules with no dependencies, and they share `gates/lib/`.

| Gate | Called by (phase) | Decides |
|---|---|---|
| `check-spec.mjs` | spec (P4) | spec IDs, coverage of R by E, measurable done predicate |
| `check-e2e.mjs` | e2e-plan (P4) | lanes per E, negative lanes per R, red check, mutation spot-check |
| `check-intake.mjs` | intake (P3) | classification, coverage exactly once, no cycles, target files exist |
| `check-plan.mjs` | plan (P5) | units cover every R and every lane, no cycles |
| `check-commit.mjs` | implement-ticket (P3) | clean tree, non-empty diff, no markers, trailers, paths, tests green |
| `check-verdict.mjs` | verify-head (P3) | head SHA match, requirement evidence, tests changed, paths, tests and lanes at head |
| `check-merge.mjs` | merge-gate (P3) | ledger approval at the exact head, required checks, reviews, merge state, base drift; merges only under `autonomy: send` |
| `run-e2e.mjs` | verify-head, unit (P3) | hidden suite results by lane id, run in a throwaway full clone |
| `isolate.mjs` | unit (P3) | implementer worktree with the hidden suite excluded by sparse checkout |
| `orch.mjs` | orchestrate (P5), merge gate | run store: units, ledger, inbox, gates, frontier |
| `pr-wait.mjs` | babysit-pr (P3) | PR events, one line each, for the Monitor tool |

## Why

- **One place, one test suite.** Gates are the trust boundary. Keeping them together makes the 100% coverage bar easy to enforce in CI (`npm run coverage:gates`).
- **Node, not shell.** Node gives branch coverage of spawned child processes for free, and JSON and globs (`path.matchesGlob`) are built in. Doctor stays in POSIX `sh` because it must run before anything else is known to work.
- **Output contract.** Every gate prints `PASS`/`FAIL <check>: <detail>` lines and a final verdict, or `--json`. Exit 0 approved, 1 rejected, 2 usage or environment error. Agents read the findings. They never re-judge an approved or rejected verdict.

## Isolation of hidden suites

ADR-001 found that the guard hook alone cannot hide a suite from Bash. `isolate.mjs` gives implementers a per-worktree sparse checkout without the hidden directories. `run-e2e.mjs` runs the suite in a separate `--shared` clone and prints only lane ids, pass or fail, and one cleaned line per failure. `--raw` output is limited to `CSTACK_ROLE=grader`.

Residual risk: the suite's blobs are still in the shared object store, so a determined agent could read them through git plumbing. The guard blocks Bash commands that name the hidden path, which covers the plain cases. A stronger fix (a separate grader repo) is not worth the setup cost until a scenario shows real leakage.

## Coverage exclusions

Two lines are excluded with `node:coverage disable`. One is the rethrow of non-usage errors in `lib/common.mjs`, which is a bug path by definition. The other is a local `--shared` clone failure in `run-e2e.mjs`.

## Path rule fix

The Phase 1 guard treated any path under a glob's static prefix as a match, so `ops/*.sh` also blocked `ops/readme.md`. Now a glob matches by `path.matchesGlob`, and `dir/**` also covers `dir` itself. The guard and the gates share this rule.
