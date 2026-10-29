# ADR-001: Phase 0 spike results

Date: 2026-10-27. Claude Code 2.1.285, model `claude-opus-5-5`, a Linux dev host (Linux).

## Decision

Keep the two-level delegation design from the plan (section 2.2), and allow Level A nesting up to depth 3. PreToolUse hooks enforce hidden and off-limits paths. Headless `claude -p` under `systemd-run --user` is the Level B worker runtime. `pr-wait` under the Monitor tool is the waiting mechanism, including in headless sessions.

## Measurements

Evidence: `spike/results/run{1,2,3}.txt` and the run scripts `spike/run{1,2,3}.sh`, removed from the tree before the directory listing (they are in git history before PR #15). The spike runs used `--dangerously-skip-permissions`; no cstack launch does any more (ADR-009). Each run used `systemd-run --user --wait`, with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset, in a scratch git repo, and loaded the probe plugin through `--plugin-dir`.

| # | Question | Result | Evidence |
|---|---|---|---|
| 1 | Does the plugin install from the private GitHub marketplace? | **Yes.** `claude plugin marketplace add oddballmeasure/cstack --scope local`, then `claude plugin install cstack@cstack --scope local`. A headless call to `cstack:hello` returned `CSTACK_HELLO_OK`. | install log in PR description |
| 2 | Can a subagent spawn a subagent? | **Yes, up to depth 3.** main → L1 → L2 → L3 all ran. The L3 tool list has no `Agent` tool, so L3 is a leaf. | run1 `NEST: NESTED_CHILD_OK`; run3 |
| 3 | Does `Skill` work inside a subagent? | **Yes.** The plugin-defined subagent `cstack-probe:nester` invoked `cstack-probe:probe-skill` and got `PROBE_SKILL_OK`. | run1 |
| 4 | Does headless `claude -p` under `systemd-run` run on the subscription with API keys unset? | **Yes.** `apiKeySource: "none"` in the init event, with exit 0. A `systemd-run --user` unit does not inherit the login PATH, so the script must set `PATH` (first try exited 127). `total_cost_usd` is still reported as an estimate. Use `apiKeySource` as the billing guard, as Cardinal does. | run1 init line |
| 5 | Do plugin PreToolUse hooks fire in subagents and `-p` sessions? | **Yes, at every level.** The hook log shows `agent_id` for subagent calls. Exit 2 blocked `Read` in main, L1 and L2, and models reported the block without working around it. | run1, run3 |
| 6 | Does the Monitor tool work in `-p` mode? | **Yes.** The session ended its turn, stayed alive, woke on the event (`MONITOR_WOKE MONITOR_EVENT_FIRED`), then exited. This supports tstack's babysit model for Level B workers. | run2 |

## Findings that change the plan

1. **Hooks must match tool fields, not raw input text.** The probe hook did a substring match on the whole input. It blocked an `Agent` spawn only because the brief *mentioned* the hidden path. The real `hidden-paths` hook must parse `tool_input` per tool: `file_path` and `path` for Read, Edit, Write, Grep and Glob, the `command` for Bash, and nothing for Agent or Skill.
2. **Bash is the weak point.** The command-string check on Bash is heuristic: `cat $(echo hid)den/...` would get past it. Hidden suites therefore also need filesystem isolation for implementer workers. Use a worktree checkout without the hidden directory (sparse checkout), and give `run-e2e.sh` its own clone. Phase 2 owns this.
3. **Workers inherit user-level MCP servers.** The claude.ai connector appeared in every headless session and subagent. Level B workers should launch with `--strict-mcp-config` and an explicit MCP config.
4. **Depth budget is 3.** pstack-style coordinator → sub-coordinator → worker fits inside Level A. Level B is still needed for crash survival and context limits, not for depth.

## Not measured yet

- `isolation: "worktree"` inside headless sessions (Phase 3).
- Behaviour when the subscription usage window runs out mid-run (scenario `usage-window`, Phase 5).
- Whether hooks fire for tools that MCP servers provide.
