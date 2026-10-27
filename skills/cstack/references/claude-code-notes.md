# Claude Code notes

<!-- Adapted from pstack docs/harness/claude-code.md @ 519d36a (MIT, Lauren Tan). -->

cstack skills use Claude Code tool names directly. This file lists the tools and behaviours they rely on. Facts marked ADR-001 were measured in the Phase 0 spike (`docs/adr/ADR-001-phase-0-spike.md`, Claude Code 2.1.285).

## Tools

| Tool | Use in cstack |
| --- | --- |
| `Agent` | Spawn a subagent. Fields: `subagent_type`, `model`, `isolation`, `run_in_background`, `prompt`, `description`. |
| `Skill` | Run another cstack skill by name, for example `cstack:unslop`. It works inside subagents (ADR-001). |
| `AskUserQuestion` | Ask the human a decision question. It is absent in `claude -p`, so ask in plain text there and take the safe default. |
| `TodoWrite` | Keep the step list. When the session has no `TodoWrite`, keep the list in the reply and update it at each phase. |
| `Monitor` | Wait on a watcher script. The session ends its turn, stays alive, and wakes on the event. It works in `-p` mode (ADR-001). |
| `Grep`, `Glob` | When the session lacks them, use `Bash` with `rg`. |

## Subagents

- `subagent_type: "general-purpose"` writes code and keeps the session's MCP servers.
- `subagent_type: "Explore"` is for read-only work. It still has `Bash`, so the brief says "do not edit files", and the parent checks `git status` afterward.
- Plugin agents from `agents/<name>.md` take the plugin prefix (`cstack:` plus the file name). Use them where a skill names one.
- `isolation: "worktree"` gives the agent its own git worktree. Name the branch or commit it checks out. Its behaviour inside headless sessions is not measured yet (Phase 3).
- `model` takes only `opus`, `sonnet`, `haiku`, `fable`, or omit it to inherit the session model. cstack picks it from the config `models` role: `code`, `judge`, `review`, `gather`. A role set to `inherit` means omit `model`.
- Subagents run in the background by default and notify the parent when they finish. Do not pass `run_in_background: true`.
- There is no resume field. To continue work, spawn a fresh agent and put the earlier brief, directives, and report in its prompt.
- Attachments are file paths listed in the brief.

## Depth

Subagents nest to depth 3: main, L1, L2, L3. The L3 tool list has no `Agent` tool, so L3 is a leaf (ADR-001). Plan coordinator, sub-coordinator, worker inside that budget.

## Hooks

Plugin `PreToolUse` hooks fire in the main session, in every subagent level, and in `-p` sessions. The hook payload carries `agent_id` for subagent calls. Exit code 2 blocks the call, and the model reports the block (ADR-001).

Hooks must match parsed `tool_input` fields, not the raw input text. Check `file_path` and `path` for Read, Edit, Write, Grep and Glob, and `command` for Bash. Do not match Agent or Skill input, because a brief that only mentions a path is not an access. The Bash check is heuristic, so hidden suites also need filesystem isolation (ADR-001).

## Headless workers

- Run `claude -p` under `systemd-run --user`. The unit does not inherit the login `PATH`, so the script sets `PATH` (ADR-001).
- Unset `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` to run on the subscription. Check `apiKeySource: "none"` in the init event as the billing guard. `total_cost_usd` is an estimate only.
- Launch with `--strict-mcp-config` and an explicit MCP config. Without it, workers inherit user-level MCP servers (ADR-001).
- Load a local plugin with `--plugin-dir` for tests.

## Paths

| Thing | Location |
| --- | --- |
| Project instructions | `CLAUDE.md`, or `AGENTS.md` when no `CLAUDE.md` exists |
| User rules | `~/.claude/rules/*.md`, loaded into each new session |
| Skills | `.claude/skills/`, `~/.claude/skills/`, or a plugin's `skills/` |
| Plugin manifest | `.claude-plugin/plugin.json` |
| Transcripts | `~/.claude/projects/<slug>/<session>.jsonl`. The slug is the workspace path with each `/` and `.` changed to `-`. Subagent transcripts are in `<session>/subagents/`. |
| cstack config and runs | `.cstack/config.json`, `.cstack/runs/<slug>/` |

## No built-in PR tool

Use `gh` for pull requests, checks, and review threads.
