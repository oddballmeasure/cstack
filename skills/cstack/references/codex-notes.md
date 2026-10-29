# Codex notes

cstack skills are written in Claude Code terms. Read this file instead of the Claude Code notes when you run in Codex: your tools include `spawn_agent` and `apply_patch`, and shell commands see `CODEX_THREAD_ID`. Every Claude Code tool a skill names maps to a Codex action in the table below. Do what the right column says wherever a skill names the left one. The rules of the mode skill do not change. Facts marked ADR-010 were measured with Codex CLI 0.165.0 (`docs/adr/ADR-010-codex-spike.md`).

## Tool map

| Claude Code term | In Codex |
| --- | --- |
| `Agent` | `spawn_agent` with `task_name`, `message` (the brief) and, when the skill sets one, `model`. Wait with `wait_agent` and long timeouts. Children can spawn their own children. |
| `subagent_type` | Codex has no plugin agent types. For `cstack-<role>` or `comment-sicko`, start the brief with "First read `<plugin root>/agents/<name>.md` and follow it as your role." For `Explore`, see that row. For `general-purpose`, send the brief as it is. |
| `Explore` | A read-only child: `spawn_agent` with a brief that says "do not edit files". Check `git status` afterward. |
| `general-purpose` | A plain `spawn_agent` child. |
| `isolation` | No per-agent worktree. Create one yourself with `git worktree add <path> <branch or sha>` and name its absolute path in the brief. |
| `run_in_background` | Children always run in the background. Wait with `wait_agent`. |
| `Skill` | Run another cstack skill as `$cstack:<name>`, or read its `SKILL.md` from the plugin root and follow it. |
| `AskUserQuestion` | `request_user_input` exists only in Plan mode. Anywhere else, put one numbered question with its options first in your reply, then end the turn. In `codex exec` nobody answers: take the safe default and record it in the decision log. |
| `TodoWrite` | `update_plan`. |
| `Monitor` | Run the watcher in the foreground with `--timeout 1500`, and with `--once` for `inbox-wait`. Shorter timeouts only add turns. Act on each line it prints. Exit 3 means the time ran out with nothing to report, so run it again. A long foreground command is allowed (ADR-010, 400 s measured), and Codex checks on it about once a minute. |
| `TaskStop` | Stop a background terminal from the session (`/stop` in the CLI), or end the watcher's process. |
| `Read` | Shell: `sed -n`, `cat` or `rg`. The guard checks these commands as Bash. |
| `Grep` | `rg` in the shell. |
| `Glob` | `rg --files -g '<glob>'` in the shell. |
| `Edit` | `apply_patch`. The guard reads the paths in the patch (ADR-010). |
| `Write` | `apply_patch` with `*** Add File:`. |
| `Bash` | The shell tool. Hooks see it as `Bash`, so every guard rule for Bash applies (ADR-010). |

## Subagents

- Plugin agents in `agents/*.md` are not loaded by Codex. The role file is the brief, as the map above says.
- `model`: Codex takes Codex model names (see `codex debug models`). Where a skill says `models.<role>`, read `models_codex.<role>` instead. Its defaults are `gpt-6.1-sol` for `code`, `gpt-6-astra` for `judge` and `review`, and `gpt-6-luna` for `gather` (`gates/lib/harness.mjs`). So a verdict still comes from a model other than the one that wrote the code. `inherit` means omit `model`. Say which model judged in the verdict.
- Hooks fire inside children too, and the payload carries `agent_id` (ADR-010).

## Hooks and trust

- Codex runs plugin hooks only after the user trusts them once in `/hooks`. Untrusted hooks are skipped without a warning. `cstack:doctor` fails with `FAIL hooks (codex)` until the guard has run in the session. Do not start cstack work while that line fails, and never pass `--dangerously-bypass-hook-trust`.
- The Stop hook keeps a coordinator going with a `decision: block` reason. Follow the reason.

## Headless and detached work

- Detached Level B workers and coordinators run `codex exec` when the harness is Codex: `CSTACK_HARNESS`, then config `harness`, then the harness you run in (ADR-012). `gates/worker.mjs launch` checks `codex login status` first and refuses an API-key login. Codex loads the installed plugin, not a `--plugin-dir`, so `codex plugin add cstack@cstack` must point at the same cstack version.
- Codex has no per-session allowlist. In a session cstack launched, the guard applies the role's Bash deny rules from `gates/lib/permissions.mjs` (`role-deny`): no `sudo`, `ssh`, `curl`, force pushes, `gh pr merge`, other `claude` or `codex` sessions, and so on. Everything else is allowed, which is a weaker guarantee than Claude Code's `dontAsk` allowlist.
- `codex exec` waits for stdin while stdin is open. Always run it with stdin closed (`</dev/null`).
- On Ubuntu 24.04 the Codex sandbox fails (`bwrap: loopback: Failed RTM_NEWADDR`) until `bubblewrap` is installed and AppArmor's `bwrap-userns-restrict` profile is loaded.
- A sandboxed session cannot start a session outside its sandbox: the systemd user bus is out of reach, and a nested `codex` cannot write `~/.codex`. So coordinators (`worker.mjs launch --coordinator`, the daemon, program runs) run with `danger-full-access` and start the e2e author and workers through the supervisor, each in the configured sandbox. Units a coordinator runs in its own session are not sandboxed; the guard protects them. Never start the e2e author or a worker from a sandboxed session.

## Paths

| Thing | Location |
| --- | --- |
| Project instructions | `AGENTS.md` |
| Plugin manifest | `.codex-plugin/plugin.json`; Codex also reads `.claude-plugin/` |
| Installed plugin | `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/` |
| Transcripts | `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`, and `transcript_path` in hook payloads |
| cstack config and runs | `.cstack/config.json`, `.cstack/runs/<slug>/` |
