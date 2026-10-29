# ADR-012: Headless Codex sessions

Date: 2026-10-29.

## Context

Detached workers, coordinators and the e2e author were headless `claude -p` sessions. ADR-010 measured what `codex exec` offers in their place:
- JSONL events;
- the installed plugin's skills and hooks, with no per-invocation plugin directory;
- no per-session allowlist, only sandbox modes plus execpolicy rules from the user's and the repo's `.codex/rules/`;
- no billing source in the event stream.

## Decision

`gates/lib/harness.mjs` picks the harness: `CSTACK_HARNESS`, then config `harness`, then the harness the caller runs in (`CODEX_THREAD_ID`), then `claude`. `gates/worker.mjs` builds the session from it.

| | Claude Code | Codex |
|---|---|---|
| Command | `claude -p --output-format stream-json --verbose --strict-mcp-config --plugin-dir <root> --permission-mode dontAsk --settings <role file> "/cstack:..."` | `codex exec --json -C <repo> -s <codex_sandbox> [-c sandbox_workspace_write.network_access=true] -m <models_codex.code> "$cstack:..."`, with stdin closed |
| Billing | unset `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`; `exit` checks the init event's `apiKeySource` | unset `OPENAI_API_KEY` and `CODEX_API_KEY`; `launch` requires `codex login status` to say ChatGPT and refuses otherwise |
| Permissions | the role's allowlist in `dontAsk` mode (ADR-009) | the guard's `role-deny` rule: in a session that carries a cstack role marker and sends Codex payloads, it applies the role's `Bash(...)` deny rules from the same `gates/lib/permissions.mjs` |
| Exit text | stderr and the `result` event | stderr, `error` events and items, `turn.failed`, and the last agent message |
| Models | config `models` | config `models_codex`, defaulting to `gpt-6.1-sol` for `code`, `gpt-6-astra` for `judge` and `review`, and `gpt-6-luna` for `gather` |

Every role now also denies `codex *`, beside `claude *`, so a session cannot start another session.

Repo-level execpolicy rules were rejected. Codex does load `<repo>/.codex/rules/*.rules` in `codex exec`, and a `forbidden` rule blocked `git push --force` even under `danger-full-access` (measured). But those rules would also bind the user's own Codex sessions in that repo. The guard rule applies only to sessions cstack launched.

## Sandboxes and coordinators

Measured in the f1 runs on 2026-10-29 with Codex 0.165:
- `workspace-write` keeps `.git` read-only. cstack sessions get `<repo>/.git`, `~/.local/state/cstack` and the temp dir as writable roots, with the network on (`codexSandboxArgs`).
- A session started from inside the sandbox inherits it. Inside the sandbox, `systemctl --user` and `systemd-run --user` fail with "Failed to connect to bus", so the supervisor falls back to a detached child, and that child's `codex exec` cannot write `~/.codex`.
- Making `~/.codex` writable was rejected, because a session could then rewrite its own hook trust.

So coordinators run with `danger-full-access` (`COORDINATOR_SANDBOX`), and everything they start through the supervisor gets the configured sandbox. Units that a small program runs inside the coordinator's own session are therefore not sandboxed. The guard and the deny rules still apply to them.

## Consequences

- A Codex worker can run any command that is not denied, so its permissions are weaker than Claude Code's allowlist. The guard still blocks hidden-suite access, config writes, direct merges, autonomy raises and deploy approvals.
- Reads such as `cat ~/.ssh/id_ed25519` go through Bash in Codex. The Claude Code `Read(~/.ssh/**)` denies have no Bash equivalent yet. A follow-up is to add the credential paths to the guard's Bash text check.
- Codex runs the plugin version installed in `~/.codex/plugins/cache`, not the checkout a worker was launched from. Keep the two in step: `codex plugin add cstack@cstack` after an update.
- The usage-limit classifier matches Codex's "You've hit your usage limit" wording. The first live hit should confirm it.
- `review_via: claude`, which would send Codex verify and review to Claude, is not built yet. Under Codex, `models_codex.judge` and `review` default to a model other than `code`, which keeps the non-author rule.
- doctor validates `harness`, `models_codex` and `codex_sandbox` once doctor is ported to Node.

## Proof (phase C5)

On 2026-10-29, f1 passed under Codex: `run-fixture.mjs f1 --harness codex` scored 24/24 on the held-out grader, with cstack's own suite at 24/24. It took 22 minutes against a 2-hour budget, billed the ChatGPT plan, asked no questions, and produced 2 merged PRs. The council scored the change 9/10 on three GPT models. The result is `tests/fixtures/f1-cli-ledger/results/2026-10-29-codex.json`.

It took seven runs. Runs 1 to 6 each stopped earlier in the pipeline and were fixed one by one:
1. the sandbox kept `.git` read-only (#25);
2. a coordinator inside the sandbox could not start sessions (#26);
3. a heredoc file write tripped the guard's text check (#27);
4. the worktree's git dir stayed read-only (#28);
5. a broad deny rule overrode a specific allow rule (#31);
6. the host's gh 2.45 lacked `pr checks --json` (cstack#32; doctor now checks for it).
