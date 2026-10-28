---
name: deploy
description: "Use when a merged cstack revision should be deployed with the repo's committed deploy.sh and deploy.json, after a unit or program merges, or when the human asks to deploy a merge commit. Runs the committed script once (local or ssh, per config deploy), then polls health until healthy or timed out. A person approves every deploy unless config deploy.auto is true."
argument-hint: "<merge sha> | <PR number>"
---

<!-- Adapted from Cardinal src/cardinal/skills/deployment-manager/SKILL.md and src/cardinal/deploy/ (oddballmeasure/cardinal, same owner). -->

# Deploy

A deploy touches production, so it is a hard stop (mode skill rule 7). The gate runs the script that the merge commit holds, never a working tree's copy, and only once per revision. A zero exit from the script is not success. Only a healthy health check is.

Read the [cstack mode skill](../cstack/SKILL.md) first.

## Names

| Name | Value |
|---|---|
| `<root>` | The plugin root, two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<sha>` | The merge commit. For a PR number, read `gh pr view <n> --repo <repo slug> --json mergeCommit --jq .mergeCommit.oid`. |
| `<deploy>` | `node <root>/gates/deploy.mjs <sha> --repo-dir <repo>` |

## What the repo provides

- Config `deploy`: `{"transport": "local" | "ssh", "local_directory": "<dir, local only>", "auto": false}`. `null` or absent means deploys are off. Stop and say so.
- Committed at the merge commit, both at the root or both under `deploy/`: `deploy.sh`, and `deploy.json` with `host`, `user`, `port` (default 22), `working_directory`, `deploy_timeout_seconds`, and `health` (`command`, `expected_stdout`, `timeout_seconds`, `interval_seconds`).

## Procedure

1. **Fetch.** `git -C <repo> fetch -q origin`. The gate deploys only a revision on `origin/<base_branch>`.
2. **Plan.** Run `<deploy> --plan --json`. It checks the layout and `deploy.json`, and prints the target, the script path and its sha256, and the health command. A rejection ends here. Report the FAIL line.
3. **Approve.**
   - Config `deploy.auto` is `true`: go to step 4 and run `<deploy> --json`.
   - Otherwise a person must approve. Put the plan in an `AskUserQuestion`: the revision, the PR, the target, the script sha256 and the health command, with "do not deploy" as the safe default. On yes, give the person this exact command to run in their own terminal, and wait for them to say it ran:
     ```sh
     node <root>/gates/deploy.mjs <sha> --repo-dir <repo> --approved
     ```
     The guard hook blocks any session from running `deploy.mjs` with `--approved` (rule `no-deploy-approval`), so the approved run is always the person's own command.
   - Under `claude -p` there is no one to ask. Do not deploy. Put the question and the command first in your final message.
4. **Read the result.** The gate writes `<repo>/.cstack/deploys/<sha>.json`: the script's exit code and output tails, every health observation, and `status`:

| Status | Meaning | Do |
|---|---|---|
| `healthy` | The script exited 0 and health matched `expected_stdout`. | Report the deployed revision. |
| `script_failed` | The script exited non-zero or timed out (exit 124). | Report the stderr tail. Failure kind `deploy`. |
| `health_timeout` | The script ran, but health never matched in `timeout_seconds`. | Report the last health output. Failure kind `deploy`. |
| `running` | An earlier run started and never finished. | Report it. A person checks the host, then removes the file to allow another run. |

A second call for the same revision runs nothing. It reports the recorded result. Failure kind `deploy` is never retried by `cstack:daemon`.

## Report

The revision, the target, the status, the number of health polls, and the result file path. On a failure, the tail that shows why. Never claim a deploy you did not see reported `healthy` by the gate.
