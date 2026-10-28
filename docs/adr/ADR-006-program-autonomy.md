# ADR-006: The program skill, and a per-run autonomy that can only be raised by the human's launch

Date: 2026-10-28.

## Decision

Phase 7 adds `cstack:program`, the top-level skill. It chains the existing skills through the nine steps of plan section 5 (preflight, frame, understand, e2e first, plan, execute, integrate, final proof, close). It also adds `cstack:full-send` and `cstack:full-stop` (tstack ports that set autonomy for one run), `cstack:cstack-help` (a pstack port), and the L4 fixture runner `tests/fixtures/run-fixture.mjs`.

`/cstack:program --autonomy=stop|send` and `--parallel=N` override config for one run. The program writes them once to `<store>/run.json`. The decisions already made by the user apply: under `send`, plan approval (H2) is skipped; spec approval (H1) is one batched `AskUserQuestion` with defaults, and a headless run takes and logs the defaults; the default autonomy stays `stop`.

## The override rule

`gates/lib/run.mjs` computes the effective autonomy. `check-merge.mjs`, `run-settings.mjs` and the `pending-work` Stop hook all use it:

| config | run.json `autonomy` | `CSTACK_PROGRAM_AUTONOMY` in the gate's session | Effective |
|---|---|---|---|
| any | absent | any | config |
| any | `stop` | any | `stop` |
| `send` | `send` | any | `send` |
| `stop` | `send` | `send` | `send` |
| `stop` | `send` | unset or anything else | `stop`, with a note |
| any | unreadable, not an object, or not `stop`/`send` | any | `stop` (fail closed) |

In short, `run.json` may only lower autonomy, unless the session that runs the merge gate has `CSTACK_PROGRAM_AUTONOMY=send`.

## Why this rule

The guard hook keeps every session from writing `.cstack/config.json` through a file tool, and `check-commit`/`check-verdict` reject a diff that changes it. The run store is not protected that way: every session in a run, implementers included, can write files in it. A `run.json` that could raise autonomy by itself would let an implementer turn a `stop` run into a `send` run with one Write call.

Alternatives considered:

- **Accept `run.json` only when git does not track it.** That does not help. The store is gitignored, so an implementer's file is untracked too.
- **Record a hash of `run.json` in the decision log and check it in the gate.** The log is in the same writable store, so the attacker writes both.
- **Lower only, never raise.** Safe, but then `--autonomy=send` in a `stop` repo does nothing, and the user's decision for headless `send` runs cannot work.

The environment of the session that runs the gate is the one input an implementer does not control. It is set when the process starts:

- The human sets it when launching Claude Code (`CSTACK_PROGRAM_AUTONOMY=send claude`), or the headless coordinator launch sets it (`run-fixture.mjs` does, with `systemd-run --setenv`).
- `gates/worker.mjs launch` passes it to Level B workers only when its own process has it as `send`. Otherwise it passes it empty, so a value in the systemd user manager's environment cannot leak in.
- The guard hook blocks any Bash command that sets it (`no-autonomy-raise`): an assignment, `export`, `declare`, `read`, `systemctl --user set-environment`, or `systemd-run --setenv=`. Reading it with `printenv` is allowed.

## PR #0 and the review gate

Phase 6 made `check-merge` require a review-loop `APPROVE` round for every diff that is not docs-only. PR #0 holds the hidden suite. A reviewer may not read `paths_hidden`, and a coordinator that printed the diff would put the suite in the context that later briefs implementers. So `check-merge` accepts unit `E2E` without a review round when every changed file is under `paths_hidden` or is `.cstack/config.json`. `check-e2e`, the red check and the mutation spot-check judge that diff instead, and `cstack:e2e-plan` records the approval in the ledger. A PR #0 that touches anything else still needs a review.

## Residual risk

- The guard reads Bash text. An agent could write a script file that sets the variable and run it through `systemd-run`. That needs a deliberate bypass of a named rule, the same class of risk ADR-003 accepts for git plumbing reads of the hidden suite. A scenario that shows it happening is the trigger to move the launch secret out of the environment (for example a token file outside the repo that only the launcher can read).
- An implementer inside a `send` run could call `check-merge --merge` itself. That is no escalation: the gate still needs the ledger approval at the exact head and every other check.
- The PR #0 review exemption trusts that the config change in PR #0 is the `e2e_command` line. The human reviews it after the merge under `send`, as `cstack:e2e-plan` already says.
