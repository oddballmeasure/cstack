# ADR-002: Config is JSON, and one guard script owns the PreToolUse rules

Date: 2026-10-27.

## Config format

The plan named `.cstack/config.toml`. cstack uses **`.cstack/config.json`** instead.

Why: hooks and gate scripts must parse the config with no dependencies. `jq` and Node read JSON natively. TOML needs a parser library in Node and has no reliable POSIX shell reader. Cardinal's TOML stayed readable because Python ships `tomllib`. cstack has no Python runtime.

The schema is `templates/config.json`. `doctor.sh` is the schema check. Unknown keys fail, as in Cardinal.

## Guard

`hooks/scripts/guard.mjs` is the single PreToolUse entry. It enforces four rules: `hidden-paths`, `off-limits`, `no-sleep-loops`, `no-admin-merge`.

- It matches per-tool path fields. It never matches Agent or Skill prompt text (ADR-001 finding 1).
- Bash and Glob/Grep pattern checks are literal-prefix heuristics. They are defence in depth only. Hidden suites also need filesystem isolation (Phase 2).
- The Bash rules apply in any repo, with or without a config. Install cstack at **project or local scope**, not user scope. Otherwise its merge and sleep rules apply to every session on the machine.
- The merge rule blocks `gh pr merge` and the merge API from the model. The merge gate script runs `gh` itself as a subprocess, which the hook does not see. Only the gate can merge.
- The `pending-work` Stop hook moves to Phase 5, because it needs the run store.
