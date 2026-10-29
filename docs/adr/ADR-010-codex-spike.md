# ADR-010: Codex spike results (phase C0)

Date: 2026-10-29. Codex CLI 0.165.0, logged in with ChatGPT, default model `gpt-6.1-sol`, on a Linux dev host (Ubuntu 24.04). Node 26.13.

## Decision

cstack becomes one plugin for two harnesses, Claude Code and Codex, on any host. The Codex plan (phases C1 to C6, plus CH for hosts) goes ahead as written, with the changes listed under *Findings that change the plan*. Codex already loads cstack's Claude-format plugin, skills and hooks as they are. The work is in subagent briefs, waiting, the headless backend and the host supervisor, not in packaging.

## Measurements

Evidence: probe runs `run1` to `run4` with `codex exec --json`, in a scratch git repo. They used a probe plugin installed from a local marketplace, whose hooks log their stdin and block any command that contains `BLOCKME`. The probe plugin and logs were throwaway (`/tmp/c0`), so they are not in the tree.

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | Does Codex install cstack as it is? | **Yes.** `codex plugin marketplace add <path>` read `.claude-plugin/marketplace.json`, then `codex plugin add cstack@cstack` installed version 0.1.0 into `~/.codex/plugins/cache/cstack/cstack/0.1.0`. No Codex manifest was needed. A local-path marketplace copies the whole working tree, untracked files included. | install output |
| 2 | Are the skills visible? | **Yes, all 52, as `cstack:<name>`.** `codex debug prompt-input` lists every one of them, including the 9 that are user-only in Claude Code (`disable-model-invocation`). Codex does not read that frontmatter key. | prompt-input dump |
| 3 | Does a skill run? | **Yes.** The model reads `SKILL.md` from the plugin cache with a shell `cat`, then follows it. | run2 |
| 4 | Do plugin hooks fire without trust? | **No, and nothing says so.** With no trust recorded, no hook ran, and the run gave no warning. Trust is stored in `config.toml` as `hooks.state."<key>".trusted_hash`. `--dangerously-bypass-hook-trust` runs them anyway and emits two `error` items saying so. | run2 (no hook log), run3 |
| 5 | What do the hook payloads look like? | **Like Claude Code's.** Every payload has `session_id`, `transcript_path` (under `~/.codex/sessions/`), `cwd`, `hook_event_name`, `model` and `permission_mode`; tool events add `turn_id`, `tool_name`, `tool_input` and `tool_use_id` (`exec-…`). The shell tool arrives as **`tool_name: "Bash"` with `tool_input.command`**, the same as Claude Code. Edits arrive as `tool_name: "apply_patch"` with the patch text in `tool_input.command` and absolute paths (`*** Add File: /abs/path`). Reads go through Bash (`cat notes.txt`). There is no Read, Grep or Glob tool. | run3 hook log |
| 6 | Does exit 2 block? | **Yes.** A PreToolUse hook with exit 2 blocked the command, and the model reported the hook's stderr text word for word without working around it. | run3 |
| 7 | Does a Stop hook keep the session going? | **Yes.** `{"decision":"block","reason":…}` on stdout made the model take another turn. The second Stop payload had `stop_hook_active: true`, and its block was not repeated. | run3 |
| 8 | What do hooks get in their environment? | `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `PLUGIN_ROOT` and `PLUGIN_DATA` point at the plugin cache and `~/.codex/plugins/data/<plugin>-<marketplace>`. No `CODEX_*` variable is set. The parent process's environment is passed through. | run3 hook log |
| 9 | Do subagents work in `codex exec`? | **Yes.** `spawn_agent {task_name, model, message, fork_turns}` started a `gpt-6-luna` child, and `wait_agent {timeout_ms}` returned its answer. The `--json` stream shows only the `wait` call (`collab_tool_call`), so the full calls are visible only in the session rollout file. `agents/*.md` is not loaded. | run4, rollout |
| 9b | Do hooks fire inside a subagent? | **Yes.** The child's `echo BLOCKME-CHILD` was blocked, and the parent reported the block. The child's payload adds `agent_id` and `agent_type` (`default`), and has its own `transcript_path` and `model` (`gpt-6-luna`). The spawn and wait calls reach PreToolUse as `tool_name: "collaborationspawn_agent"` and `"collaborationwait_agent"`. | run5 |
| 9c | Is `matcher` a regex, and does `Edit|Write` catch `apply_patch`? | **Yes to both.** With the matcher `Read|Edit|Write|Bash`, PreToolUse fired for `Bash` and for `apply_patch`, although the payload still says `tool_name: "apply_patch"`. So cstack's current `hooks.json` matcher already covers Codex edits. | run6, run7 |
| 10 | What does `codex exec --json` emit? | `thread.started`, `turn.started`, `item.started` and `item.completed` (with item types `agent_message`, `command_execution` with `exit_code`, `file_change`, `collab_tool_call` and `error`), then `turn.completed` with `usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`). There is no cost field. | run2 to run4 |
| 11 | What does a usage limit look like? | **Not seen live.** The binary has the error kind `UsageLimitReached` and the message "You've hit your usage limit…". Match `/hit your usage limit/` and the error kind, and confirm the shape the first time it happens. | binary strings |
| 12 | Can execpolicy rules express the role allowlists? | **Yes, for prefixes.** `prefix_rule(pattern=["gh","pr","merge"], decision="forbidden", justification=…)` is checked by `codex execpolicy check -r <file> <argv…>` and returns JSON with `decision` set to `allow`, `forbidden` or no match. | execpolicy check |
| 13 | Does the Codex sandbox work on this host? | **No.** `workspace-write` and `codex sandbox` both fail with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`, because Ubuntu 24.04 sets `kernel.apparmor_restrict_unprivileged_userns=1`. Every shell call and `apply_patch` failed in `workspace-write`. Probes run 2 to 4 used `-s danger-full-access`. | run1, `codex sandbox -- echo hi` |
| 14 | Does `codex exec` wait for stdin? | **Yes, if stdin is open.** It prints "Reading additional input from stdin..." and blocks until stdin closes, even when a prompt argument is given. Launchers must use `stdin: "ignore"` or `</dev/null`. | run2, first try |
| 15 | How long can one shell command run? | **At least 400 s, without a kill.** `sleep 400` ran to the end (400.05 s, exit 0). The model polled the running command about once a minute, and each poll was a model turn. The run used 650k input tokens, 96% of them cached. So the plan's "about 5 minutes" limit is wrong: the real cost of a long wait is one turn per minute. | run4 |

## Findings that change the plan

1. **The guard needs no Bash changes for Codex.** The shell arrives as `Bash` with `tool_input.command`, so the existing Bash rules apply. The existing `Edit|Write` matcher already sends `apply_patch` to the guard (row 9c). C2 only teaches the guard to read paths from the patch text: the `*** Add/Update/Delete File:` and `*** Move to:` lines, which hold absolute paths. Today the guard sees no `file_path` and lets the edit through.
2. **Untrusted hooks are skipped without a sound.** The guard is cstack's main safety layer, so cstack must prove the hooks fire before it does any work in Codex. doctor runs a guard self-test session. Every cstack-launched `codex exec` first runs a canary: the hook writes a marker for each session, and the run stops if the marker is missing. cstack never passes `--dangerously-bypass-hook-trust`.
3. **Harness detection uses the payload, not the environment.** Codex sets no `CODEX_*` variable for hooks, and the parent's `CLAUDE*` variables pass through, so a variable is not a safe signal. Detect Codex from `turn_id` in the payload, or from `transcript_path` under `.codex/`. Inside a session, skills tell the harnesses apart by their tool list (`spawn_agent` against `Agent`).
4. **User-only skills need `agents/openai.yaml`** with `policy.allow_implicit_invocation: false`, as planned. Codex lists all 52 skills to the model today.
5. **The Codex sandbox does not work on Ubuntu 24.04 out of the box.** The fix is an AppArmor profile that allows user namespaces for the Codex binary (root once), or `-s danger-full-access` and relying on cstack's guard and worktree isolation. doctor detects this with `codex sandbox -- true` and says which is in use. The C4 headless backend takes the sandbox mode from config, with no silent fallback.
6. **Launchers close stdin** for `codex exec`, or it hangs.
7. **Usage-limit classification is provisional** until a live run hits the limit.
8. **Waiting is cheaper with long single commands than with many short ones, but it is never free.** A foreground watcher with `--timeout` works, as planned. Keep the default timeout at 25 minutes so a re-arm is rare. Count the polling turns in the Codex budget for f1.
9. **The JSON stream does not show subagent spawns.** Run telemetry that needs them reads the rollout file named by `transcript_path`.

## Not measured yet

- Hook trust: the key format inside `hooks.state` and whether trust survives a plugin version bump. This needs the interactive `/hooks` screen, so it is Monty's step in C1.
- Per-invocation execpolicy rules for `codex exec`. Only the `--ignore-rules` flag exists; rules load from the user and project rule directories. C4 measures this.
- The Codex desktop app (C6).
