---
name: setup-cstack
description: Set up a repo for cstack on GitHub, GitLab or plain git. Writes .cstack/config.json with the chosen forge, creates the cstack labels, ignores the run store, and ends with a passing doctor run. Use for /cstack:setup-cstack [--forge github|gitlab|local] or "set up cstack in this repo".
disable-model-invocation: true
argument-hint: "[--forge github|gitlab|local] [--forge-host <host>]"
---

# Setup cstack

Setup prepares one target repo. Run it from inside that repo. `<root>` is the plugin root, two directories up from this skill's base directory. It is safe to run again: every step converges on the same end state.

## Steps

0. **Choose the forge.** The forge is where issues, change requests and CI live: `github` (the default), `gitlab` or `local` (plain git, any remote or none). Take it from the `--forge` argument, else from an existing config's `forge`, else ask once with AskUserQuestion, defaulting to GitHub. A self-hosted GitLab also needs its host: `--forge-host <host>`, else ask. Below, `<forge flags>` is `--forge <forge>`, plus `--forge-host <host>` when set. Pass them to every `forge.mjs` call: until step 6 writes the config, they are the only place the choice lives.
1. **Find the repo.** Run `git rev-parse --show-toplevel` and `node <root>/gates/forge.mjs repo --json <forge flags>`, which gives the repo `path` and its `defaultBranch`. Stop if either fails. On GitLab the path may nest groups (`group/sub/project`).
2. **Read the existing config.** If `.cstack/config.json` exists, load it. Keep every value the user set. Fill only missing keys.
3. **Find the test command.** Look at the repo, not the user:
   - `package.json` scripts (`test`, then `test:unit`), the lockfile picks `npm`, `pnpm`, `yarn` or `bun`.
   - `pyproject.toml` or `pytest.ini` gives `["pytest", "-q"]`. `uv.lock` gives `["uv", "run", "pytest", "-q"]`.
   - `Cargo.toml` gives `["cargo", "test"]`. `go.mod` gives `["go", "test", "./..."]`.
   - A `Makefile` with a `test` target gives `["make", "test"]`.
   - Run the command once. Record whether it passes. A red baseline is a WARN for the user, not a reason to stop.
4. **Find the required checks.** Run `node <root>/gates/forge.mjs required-checks <base> --repo <repo> <forge flags>`. On GitHub it reads rulesets and branch protection. On GitLab it lists the jobs of the base branch's newest pipeline that may not fail. Use the names it prints. If it prints `none`, set `[]` and tell the user that the merge gate will not wait for CI. On `local` there is no CI server: set `ci_command` (default: the test command from step 3), ask once whether to change it, and set `required_checks` to `["ci"]`. The merge gate runs `ci_command` in a clean worktree at each head and records the verdict under `.cstack/forge/`.
5. **Ask once.** Use AskUserQuestion for the decisions only the user can make, each with a default:
   - `paths_off_limits` (default: `.github/workflows/**`).
   - `paths_hidden` (default: `tests/acceptance/**`).
   - `autonomy` (default: `send`, which means the merge gate merges once every check, the verifier and the review loop pass; choose `stop` to merge every PR yourself).
   - Model per role (defaults: code `opus`, judge `fable`, review `sonnet`, gather `haiku`). Judge and review should differ from code.
6. **Write the config.** Start from `templates/config.json` in the plugin root (two directories up from this skill). Set `forge` to the choice from step 0, and `forge_host` when there is one. Write `.cstack/config.json` with 2-space JSON. Show the user the final file. Leave `permissions_allow` empty. It adds permission rules, such as `Bash(make lint)`, to the allowlist of every headless session cstack launches. The configured commands are already allowed, so a person adds rules here only when a worker reports a refused call it needs.
7. **Ignore local state.** Make sure `.gitignore` has the two lines `.cstack/*` and `!.cstack/config.json`, so the run store and the repo profile stay local and only the config is committed.
8. **Create the labels.** Skip this on `local`, where labels are plain strings on the local records. For each state in `ready`, `in-progress`, `done`, `error`, `needs-human`, `investigate`, `proposed`, run `node <root>/gates/forge.mjs labels ensure "<prefix>:<state>" --repo <repo> <forge flags> --color <color> --description "<text>"`. It creates the label or updates it. Colors: ready `0e8a16`, in-progress `fbca04`, done `5319e7`, error `b60205`, needs-human `d93f0b`, investigate `1d76db`, proposed `c5def5`.
9. **Verify.** Run `cstack:doctor` on the repo. Setup is done only when doctor exits 0. Report the WARN lines. In Codex, a `FAIL hooks (codex)` line means Codex has not trusted cstack's hooks yet, so the guard does not run. Codex asks for that trust once, in `/hooks`, and only the user can give it. Ask them to open `/hooks`, trust the cstack hooks, and run doctor again. Never work around it with `--dangerously-bypass-hook-trust`.
10. **Commit.** Do not commit. Tell the user which files changed (`.cstack/config.json`, `.gitignore`) so they can review and commit them.

## Rules

- Never overwrite a value the user set. Show a diff if a value would change and ask.
- Never create a branch or push in setup.
- Label creation is the only write to the forge.
