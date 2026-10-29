# How cstack works

cstack is four kinds of parts. **Skills** hold the procedure and the judgement. **Subagents** do bounded work in a fresh context. **Gates** are deterministic scripts that decide pass or fail. **Hooks** enforce the rules that must never depend on a model remembering them.

## The four parts

| Part | Where | What it does | Example |
|---|---|---|---|
| Skills | `skills/<name>/SKILL.md` | A procedure an agent follows, with the exact commands and limits. User skills start a run; chained skills are called by other skills. | `program`, `unit`, `verify-head` |
| Subagents | `agents/*.md` | Fresh-context workers with a narrow role and tool set. They return results; the coordinator reviews them. | `cstack-worker` implements; `cstack-verifier` judges; `cstack-reviewer` reviews; `cstack-e2e-author` writes the hidden suite |
| Gates | `gates/*.mjs` | Dependency-free Node scripts. They print `PASS`/`FAIL` lines (or JSON) and exit 0, 1 or 2. An agent reads the findings; it never re-judges the verdict. | `check-commit`, `check-verdict`, `check-merge`, `run-e2e` |
| Hooks | `hooks/` | Claude Code hooks that run on every tool call in every session and subagent, and act only in a cstack context (a repo with `.cstack/config.json`, or a session cstack launched). | `guard.mjs` blocks hidden-suite reads, config edits, direct merges and sleep loops; `pending-work.mjs` stops a coordinator ending its turn with work in flight |

## A program, start to finish

`/cstack:program <guideline>` runs nine steps. Each step has a gate, and each transition is a row in the decision log.

1. **Preflight.** `doctor` checks tools, config, labels and hooks.
2. **Frame.** `spec` turns the guideline into numbered requirements (R1..Rn), end-to-end requirements (E1..En) that cover them, and a measurable done predicate. `check-spec` decides. Open questions go out once, with defaults.
3. **Understand.** `profile-repo` describes every tracked file, re-reading only files whose hash changed.
4. **E2E first.** `e2e-plan` has a separate author write lanes and a hidden suite. The red check shows every lane fails on the current code. The mutation spot-check shows planted breaks get caught. `check-e2e` decides. The suite merges as PR #0 before any product code.
5. **Plan.** `plan` splits the work into units with dependencies, each mapped to requirements and lanes. `check-plan` decides that every requirement and every lane is covered.
6. **Execute.** `orchestrate` runs units in dependency order, in-session or as detached headless workers, and drains their results from an inbox.
7. **Integrate.** `post-merge-ci` judges every merge commit, re-runs a failure once, then files one follow-up issue.
8. **Final proof.** A fresh verifier runs the whole hidden suite at the merged commit, and a three-model `council` reviews the cumulative diff.
9. **Close.** The decision log is audited, and the report maps each requirement to its lanes, PR and evidence.

## One unit, start to finish

`cstack:unit` takes one unit (or one GitHub issue) through 13 stages. The contract is [unit-flow.md](unit-flow.md).

| Stage | What happens | Who decides |
|---|---|---|
| Isolate | A worktree is created with the hidden suite left out of the checkout. | `isolate` |
| Intake | The issue is classified and split into 1 to 4 tickets. | `check-intake` |
| Implement | A worker writes the change and tests and commits with `Cstack-Unit`/`Cstack-Ticket`/`Refs` trailers. | `check-commit` reruns the tests itself |
| Verify | A verifier on another model checks every requirement at the exact head. | `check-verdict`, recorded in the ledger by SHA |
| Sync | The base is merged in; conflicts become a SYNC repair ticket. | `sync-base` |
| PR and babysit | The PR is opened and watched; CI failures become CI-REPAIR tickets with the log tail. | `pr-wait` under the Monitor tool |
| Review | A review loop on a third model reads the diff; findings become REPAIR tickets. | the review ledger |
| Merge gate | Merge only with a ledger approval and a review approval at this exact SHA, green required checks, no change requests, and no base drift under the PR's files. | `check-merge` |

Every failure ends in a named kind (`tests_failed`, `verification`, `ci_failed`, `base_conflict` and others), a label, and a comment. Nothing fails silently.

## Two levels of delegation

- **In session.** For small programs, the coordinator runs units itself and uses subagents for implementing, verifying and reviewing. Subagents can nest three levels deep.
- **Detached workers.** For larger programs, each unit runs as its own headless session (`claude -p`, or `codex exec` under Codex) under the host supervisor: `systemd-run --user` on Linux, launchd on macOS, Task Scheduler on Windows, or a detached process (ADR-011). It has no permission bypass: it runs in `dontAsk` mode with an allowlist for its role, and a refused call ends the unit as `denied` (ADR-009). A unit survives a coordinator crash, a context compaction or a usage-limit pause, and the coordinator picks up its result from the run store.

## Two harnesses

cstack is one plugin for Claude Code and Codex. Skills are written in Claude Code terms. Under Codex, the mode skill sends the agent to `skills/cstack/references/codex-notes.md`, which maps each tool to its Codex action. For example, `Agent` becomes `spawn_agent`, and a `Monitor` wait becomes a foreground watcher with `--timeout`.

The two harnesses differ in a few places:

| | Claude Code | Codex |
|---|---|---|
| Hooks | the same `hooks.json` | the same `hooks.json`, run once the user trusts them in `/hooks` |
| Edits | `Edit` and `Write` | `apply_patch`; the guard reads the paths in the patch |
| Headless | `claude -p` | `codex exec`, ChatGPT login only |
| Permissions | a per-role allowlist in `dontAsk` mode | the role's deny rules, applied by the guard |
| Models | config `models` | config `models_codex` |

ADR-010 has the measurements, and ADR-012 covers the headless backend.

## Autonomy

`autonomy` in `.cstack/config.json` is `send` (the merge gate merges) or `stop` (every PR ends merge-ready for a person). A run can always lower it. Raising a `stop` repo to `send` for one run needs `CSTACK_PROGRAM_AUTONOMY=send` in the environment of the session a person launched, and the guard blocks agents from setting that variable (ADR-006). Either way, only the merge gate merges. The guard blocks every direct `gh pr merge`.

## Where things live

| Path | Contents |
|---|---|
| `.cstack/config.json` (target repo, committed) | Test and e2e commands, required checks, hidden and off-limits paths, autonomy, model roles, limits |
| `.cstack/runs/<slug>/` (target repo, ignored) | Run store: units, verdict ledger, inbox, decision log, spec, plan, intake, feedback |
| `docs/adr/` | Why each design choice was made, including what live runs forced us to change |
| `tests/` | Unit tests for every gate and hook, live scenarios (L3) and fixture programs (L4) |
