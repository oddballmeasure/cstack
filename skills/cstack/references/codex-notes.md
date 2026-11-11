# Codex notes

cstack skills are written in Claude Code terms. Read this file instead of the Claude Code notes when you run in Codex: your tools include `spawn_agent` and `apply_patch`, and shell commands see `CODEX_THREAD_ID`. Every Claude Code tool a skill names maps to a Codex action in the table below. Do what the right column says wherever a skill names the left one. The rules of the mode skill do not change. Most facts here were measured with Codex CLI 0.165.0.

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
| `Monitor` | Run the watcher in the foreground with `--timeout 1500`, and with `--once` for `inbox-wait`. Shorter timeouts only add turns. Act on each line it prints. Exit 3 means the time ran out with nothing to report, so run it again. A long foreground command is allowed (400 s measured), and Codex checks on it about once a minute. |
| `TaskStop` | Stop a background terminal from the session (`/stop` in the CLI), or end the watcher's process. |
| `Read` | Shell: `sed -n`, `cat` or `rg`. The guard checks these commands as Bash. |
| `Grep` | `rg` in the shell. |
| `Glob` | `rg --files -g '<glob>'` in the shell. |
| `Edit` | `apply_patch`. The guard reads the paths in the patch. |
| `Write` | `apply_patch` with `*** Add File:`. Write every file this way, JSON and reports included, never with a shell heredoc, `node -`, `python -` or `> file`. The guard reads the full text of every shell command, so a script whose content merely mentions a hidden path is blocked, while `apply_patch` is checked by its file paths only. |
| `Bash` | The shell tool. Hooks see it as `Bash`, so every guard rule for Bash applies. |

## Subagents

- Plugin agents in `agents/*.md` are not loaded by Codex. The role file is the brief, as the map above says.
- `model`: Codex takes Codex model names (see `codex debug models`). Where a skill says `models.<role>`, read `models_codex.<role>` instead. Its defaults are `gpt-6.1-sol` for `code`, `gpt-6-astra` for `judge` and `review`, and `gpt-6-luna` for `gather` (`gates/lib/harness.mjs`). So a verdict still comes from a model other than the one that wrote the code. `inherit` means omit `model`. Say which model judged in the verdict.
- Hooks fire inside children too, and the payload carries `agent_id`.

## Hooks and trust

- Codex runs plugin hooks only after the user trusts them in `/hooks`. The trust is tied to a fingerprint of the whole installed plugin, so every cstack update needs it again. Untrusted hooks are skipped without a warning. `cstack:doctor` fails with `FAIL hooks (codex)` until the guard has run in the session. Do not start cstack work while that line fails, and never pass `--dangerously-bypass-hook-trust`.
- The Stop hook keeps a coordinator going with a `decision: block` reason. Follow the reason.

## Headless and detached work

- Codex does not load `agents/*.md`, so the role rules there reach a Codex worker, verifier or reviewer only through its brief. The headless Bash rules in the Claude Code notes (**Headless workers**) apply to them too: absolute paths, `git -C <worktree>`, no command that sets a shell variable, and repo tools spelled as the repo's allow rules spell them.
- Detached Level B workers and coordinators run `codex exec` when the harness is Codex: `CSTACK_HARNESS`, then config `harness`, then the harness you run in. `gates/worker.mjs launch` checks `codex login status` first and refuses an API-key login. Codex loads the installed plugin, not a `--plugin-dir`, so `codex plugin add cstack@cstack` must point at the same cstack version.
- Codex has no per-session allowlist. In a session cstack launched, the guard applies the role's Bash deny rules from `gates/lib/permissions.mjs` (`role-deny`): no `sudo`, `ssh`, `curl`, force pushes, `gh pr merge`, other `claude` or `codex` sessions, and so on. Everything else is allowed, which is a weaker guarantee than Claude Code's `dontAsk` allowlist. So config `permissions_allow` grants nothing extra under Codex, with one difference: a rule there that is more specific than a deny rule (`Bash(curl https://api.example.com *)` against `curl *`) lets that command through the guard for the roles it reaches, where Claude Code's deny still refuses it. The role-keyed form limits that to the named role, as it does under Claude Code.
- `codex exec` waits for stdin while stdin is open. Always run it with stdin closed (`</dev/null`).
- In `codex exec`, as in `claude -p`, the session ends when its turn ends, and children that still run end with it. Call `wait_agent` on every child before you end the turn. `spawn_agent` has no foreground option, and the guard never sees it: with cstack's `hooks.json` matcher, PreToolUse fires for the shell and `apply_patch` but not for `spawn_agent` or `wait_agent` (measured with Codex CLI 0.166.0, next item). The control is the `pending-work` Stop hook. In a headless session cstack launched, it blocks the first stop while the session's rollout (`transcript_path`) shows a child that started and has not ended. It also blocks a unit worker's first stop while its unit is `in-progress` or `verifying`. A worker that ends its turn anyway exits as `crash`, and `workers/<unit>.exit.txt` names its last command and message.
- The measurement (Codex CLI 0.166.0, `codex exec --json`, `workspace-write`, `CSTACK_HEADLESS=1`, cwd a cstack repo): a session that called only `spawn_agent` and `wait_agent` left no `<tmpdir>/cstack-hook-seen/<thread_id>` mark and no guard message. A session that ran `echo probe-ok` and a direct PR merge left the mark, and the guard refused the merge (`cstack no-admin-merge: …`). The `--json` stream shows only `collab_tool_call` items with `tool: "wait"`. The rollout has `function_call` items with `namespace: "collaboration"` and `name: "spawn_agent"` or `"wait_agent"`, and `event_msg` items of type `SubAgentActivity` with a `kind` and the other agent's `agent_thread_id`. Every rollout under `~/.codex/sessions` on the dev host (43 files, Codex CLI 0.165 and 0.166) has only three kinds: `started` (spawn), `interacted` (`send_input` and follow-ups, which can start a completed child again) and `completed`. The Stop hook ends a child only on `completed`. A follow-up to its own child makes it live again, and any other kind changes nothing, so a kind a later Codex adds keeps the child live for one extra blocked stop.
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
