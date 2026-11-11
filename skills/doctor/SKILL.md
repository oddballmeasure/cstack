---
name: doctor
description: Use when a cstack skill or the user needs to know whether a repo is ready for cstack work. Runs a read-only health check of tools, config, hooks, labels and the run store, and reports each check as PASS, WARN or FAIL.
---

# Doctor

Doctor checks that a target repo can run cstack. It changes nothing. Setup is the job of `cstack:setup-cstack`.

## Run it

1. Find this skill's base directory. Claude Code prints it when it loads the skill. In Codex, it is `<plugin root>/skills/doctor`.
2. Run `node <base dir>/scripts/doctor.mjs <repo dir>` with the Bash tool.
3. Add `--offline` only when the forge is not reachable, as the first argument: `node <base dir>/scripts/doctor.mjs --offline <repo dir>`. After the repo dir it is ignored. Offline mode skips the repo, branch and label checks.

## What it checks

| Check | FAIL when |
|---|---|
| Tools | `git`, `jq`, `node` (22 or later) or the forge CLI is missing, or the forge CLI is not logged in. The forge CLI is `gh` for config `forge` `github` and `glab` for `gitlab`. Forge `local` needs none. |
| Worker PATH | A tool this session finds is not on the PATH a detached worker gets: `git`, `jq`, `node`, the harness and forge CLIs, or the first word of a configured command. |
| Config | `.cstack/config.json` is missing, does not parse, or breaks the schema in `templates/config.json`. Unknown keys fail, and so does a `permissions_allow` key that is not a role (`worker`, `coordinator`, `e2e-author`, `grader`). A list-form `permissions_allow` rule that opens a network tool (`curl`, `agent-browser`, `playwright` and the rest of `NETWORK_COMMANDS` in `gates/lib/permissions.mjs`) is a WARN: move it under the role that needs it. `docs_paths` must be `null` or a list of globs. `docs_paths: []` is a WARN: it means no file is a doc, while `null` or no key keeps the default doc test. |
| Config committed | `.cstack/config.json` is not on the base branch as the forge sees it: `origin/<base>`, or the local `<base>` under forge `local` with no remote. Unit worktrees are cut from there. A local config that differs from the committed one, or cstack lines in `.gitignore` that are not committed there, is a WARN. |
| Commands | `test_command[0]` or `e2e_command[0]` does not resolve. A command with a `/` must be an executable file under the repo root. |
| Run store | `.cstack/runs/` is not writable. A missing `.gitignore` entry is a WARN. |
| Hooks | A self-test shows the cstack guard no longer blocks a direct `gh pr merge`. |
| Hooks (codex) | In a Codex session, the guard did not run in this session. Trust cstack's hooks once in `/hooks`, then run doctor again. |
| Forge | On GitHub or GitLab, the repo or base branch cannot be read, or any `<prefix>:` state label is missing. No required checks is a WARN. |
| Local forge | Forge `local` only: `.cstack/forge/` cannot be created. No `ci` in `required_checks` is a WARN. |
| Daemon plugin | Never fails, and does not run on Windows. When this repo has a `cstack-daemon@` systemd user unit (enabled, or with its own unit file or drop-ins), a WARN when its `CSTACK_PLUGIN` is unset, holds no cstack plugin, or holds a version other than the installed one: the install for this repo in `~/.claude/plugins/installed_plugins.json`, else the user-scope install, else the plugin running doctor. The fix is in `cstack:daemon`, **Plugin path**. |

## Report

- Show the FAIL and WARN lines to the user. Do not show the PASS lines unless asked.
- For each FAIL, give the fix in one line. Most fixes are "run `/cstack:setup-cstack`". For `config committed`, the fix is "commit `.cstack/config.json` and `.gitignore` on a branch and merge it", which the last step of setup does.
- Exit code 1 means at least one FAIL. Do not start cstack work on a repo that fails doctor.
