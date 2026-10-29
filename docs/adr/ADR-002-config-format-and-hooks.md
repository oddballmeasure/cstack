# ADR-002: Config is JSON, and one guard script owns the PreToolUse rules

Date: 2026-10-27.

## Config format

The plan named `.cstack/config.toml`. cstack uses **`.cstack/config.json`** instead.

Why: hooks and gate scripts must parse the config with no dependencies. `jq` and Node read JSON natively. TOML needs a parser library in Node and has no reliable POSIX shell reader. Cardinal's TOML stayed readable because Python ships `tomllib`. cstack has no Python runtime.

The schema is `templates/config.json`. `doctor.mjs` is the schema check. Unknown keys fail, as in Cardinal.

## Guard

`hooks/scripts/guard.mjs` is the single PreToolUse entry. It enforces four rules: `hidden-paths`, `off-limits`, `no-sleep-loops`, `no-admin-merge`.

- It matches per-tool path fields. It never matches Agent or Skill prompt text (ADR-001 finding 1).
- Bash and Glob/Grep pattern checks are literal-prefix heuristics. They are defence in depth only. Hidden suites also need filesystem isolation (Phase 2).
- ~~The Bash rules apply in any repo, with or without a config. Install cstack at project or local scope, not user scope.~~ Superseded (2026-10-29, directory listing): every rule, Bash rules included, applies only in a cstack context. That is a cwd or tool target inside a repo with `.cstack/config.json`, or a session that carries one of the markers cstack's own launches set (`CSTACK_ROLE`, `CSTACK_RUN`, `CSTACK_UNIT`, `CSTACK_COORDINATOR`). Anywhere else the guard exits 0, so any install scope is safe.
- The merge rule blocks `gh pr merge` and the merge API from the model. The merge gate script runs `gh` itself as a subprocess, which the hook does not see. Only the gate can merge.
- The `pending-work` Stop hook moves to Phase 5, because it needs the run store.
