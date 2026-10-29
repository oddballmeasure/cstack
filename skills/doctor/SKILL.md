---
name: doctor
description: Use when a cstack skill or the user needs to know whether a repo is ready for cstack work. Runs a read-only health check of tools, config, hooks, labels and the run store, and reports each check as PASS, WARN or FAIL.
---

# Doctor

Doctor checks that a target repo can run cstack. It changes nothing. Setup is the job of `cstack:setup-cstack`.

## Run it

1. Find this skill's base directory. Claude Code prints it when it loads the skill.
2. Run `node <base dir>/scripts/doctor.mjs <repo dir>` with the Bash tool.
3. Add `--offline` only when GitHub is not reachable. Offline mode skips the repo, branch and label checks.

## What it checks

| Check | FAIL when |
|---|---|
| Tools | `git`, `jq`, `node` (22 or later) or `gh` is missing, or `gh` is not logged in. |
| Config | `.cstack/config.json` is missing, does not parse, or breaks the schema in `templates/config.json`. Unknown keys fail. |
| Commands | `test_command[0]` or `e2e_command[0]` does not resolve. A command with a `/` must be an executable file under the repo root. |
| Run store | `.cstack/runs/` is not writable. A missing `.gitignore` entry is a WARN. |
| Hooks | The cstack guard does not block a direct `gh pr merge` in a self-test. |
| GitHub | The repo or base branch cannot be read, or any `<prefix>:` state label is missing. No required checks is a WARN. |

## Report

- Show the FAIL and WARN lines to the user. Do not show the PASS lines unless asked.
- For each FAIL, give the fix in one line. Most fixes are "run `/cstack:setup-cstack`".
- Exit code 1 means at least one FAIL. Do not start cstack work on a repo that fails doctor.
