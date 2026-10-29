---
name: setup-cstack
description: Set up a repo for cstack. Writes .cstack/config.json, creates the cstack labels, ignores the run store, and ends with a passing doctor run. Use for /cstack:setup-cstack or "set up cstack in this repo".
disable-model-invocation: true
---

# Setup cstack

Setup prepares one target repo. Run it from inside that repo. It is safe to run again: every step converges on the same end state.

## Steps

1. **Find the repo.** Run `git rev-parse --show-toplevel` and `gh repo view --json nameWithOwner,defaultBranchRef`. Stop if either fails.
2. **Read the existing config.** If `.cstack/config.json` exists, load it. Keep every value the user set. Fill only missing keys.
3. **Find the test command.** Look at the repo, not the user:
   - `package.json` scripts (`test`, then `test:unit`), the lockfile picks `npm`, `pnpm`, `yarn` or `bun`.
   - `pyproject.toml` or `pytest.ini` gives `["pytest", "-q"]`. `uv.lock` gives `["uv", "run", "pytest", "-q"]`.
   - `Cargo.toml` gives `["cargo", "test"]`. `go.mod` gives `["go", "test", "./..."]`.
   - A `Makefile` with a `test` target gives `["make", "test"]`.
   - Run the command once. Record whether it passes. A red baseline is a WARN for the user, not a reason to stop.
4. **Find the required checks.** Read branch protection and rulesets for the base branch: `gh api repos/<repo>/branches/<base>/protection` and `gh api repos/<repo>/rules/branches/<base>`. Use the required status check names. If none exist, set `[]` and tell the user that the merge gate will not wait for CI.
5. **Ask once.** Use AskUserQuestion for the decisions only the user can make, each with a default:
   - `paths_off_limits` (default: `.github/workflows/**`).
   - `paths_hidden` (default: `tests/acceptance/**`).
   - `autonomy` (default: `send`, which means the merge gate merges once every check, the verifier and the review loop pass; choose `stop` to merge every PR yourself).
   - Model per role (defaults: code `opus`, judge `fable`, review `sonnet`, gather `haiku`). Judge and review should differ from code.
6. **Write the config.** Start from `templates/config.json` in the plugin root (two directories up from this skill). Write `.cstack/config.json` with 2-space JSON. Show the user the final file. Leave `permissions_allow` empty. It adds permission rules, such as `Bash(make lint)`, to the allowlist of every headless session cstack launches (ADR-009). The configured commands are already allowed, so a person adds rules here only when a worker reports a refused call it needs.
7. **Ignore local state.** Make sure `.gitignore` has the two lines `.cstack/*` and `!.cstack/config.json`, so the run store and the repo profile stay local and only the config is committed.
8. **Create the labels.** For each state in `ready`, `in-progress`, `done`, `error`, `needs-human`, `investigate`, `proposed`, run `gh label create "<prefix>:<state>" --repo <repo> --color <color> --description "<text>" --force`. Colors: ready `0e8a16`, in-progress `fbca04`, done `5319e7`, error `b60205`, needs-human `d93f0b`, investigate `1d76db`, proposed `c5def5`.
9. **Verify.** Run `cstack:doctor` on the repo. Setup is done only when doctor exits 0. Report the WARN lines.
10. **Commit.** Do not commit. Tell the user which files changed (`.cstack/config.json`, `.gitignore`) so they can review and commit them.

## Rules

- Never overwrite a value the user set. Show a diff if a value would change and ask.
- Never create a branch or push in setup.
- Label creation is the only write to GitHub.
