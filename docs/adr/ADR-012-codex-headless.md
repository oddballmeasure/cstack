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

## Consequences

- A Codex worker can run any command that is not denied, so its permissions are weaker than Claude Code's allowlist. The guard still blocks hidden-suite access, config writes, direct merges, autonomy raises and deploy approvals.
- Reads such as `cat ~/.ssh/id_ed25519` go through Bash in Codex. The Claude Code `Read(~/.ssh/**)` denies have no Bash equivalent yet. A follow-up is to add the credential paths to the guard's Bash text check.
- Codex runs the plugin version installed in `~/.codex/plugins/cache`, not the checkout a worker was launched from. Keep the two in step: `codex plugin add cstack@cstack` after an update.
- The usage-limit classifier matches Codex's "You've hit your usage limit" wording. The first live hit should confirm it.
- `review_via: claude`, which would send Codex verify and review to Claude, is not built yet. Under Codex, `models_codex.judge` and `review` default to a model other than `code`, which keeps the non-author rule.
- doctor validates `harness`, `models_codex` and `codex_sandbox` once doctor is ported to Node.
