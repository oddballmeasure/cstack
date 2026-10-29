# ADR-009: Role allowlists instead of a permission bypass

Date: 2026-10-29.

## Decision

No session that cstack launches uses `--dangerously-skip-permissions`. Unit workers, coordinators, the daemon, the e2e author, and the L3 and L4 test launchers all run with `--permission-mode dontAsk --settings <file>`. `gates/run-settings.mjs --permissions <role>` writes the file from `gates/lib/permissions.mjs`. It holds:

- `permissions.allow`: what the role runs, and nothing else.
- `permissions.deny`: the shared deny list.
- `defaultMode: "dontAsk"`.
- `disableBypassPermissionsMode: "disable"`.

dontAsk refuses every call that would otherwise prompt, at once and without a prompt, so a headless session never hangs on a permission. The guard hook is the second layer, unchanged.

| Role | Launched by | Settings file |
|---|---|---|
| worker | `gates/worker.mjs launch --unit` | `<store>/workers/<unit>.settings.json` |
| coordinator | `gates/worker.mjs launch --coordinator`, the daemon unit's `ExecStartPre`, `tests/fixtures/run-fixture.mjs` | `<store>/workers/coordinator.settings.json`, `<repo>/.cstack/permissions/coordinator.json` |
| e2e-author | `cstack:e2e-plan` | `<store>/e2e-author.settings.json` |
| grader | none yet: for a separate headless verification session | |

The lists come from what the skills run and what nine real L3 unit sessions ran (`tests/scenarios/results/*/session.jsonl`):

- git, gh, node and jq;
- the plugin's own scripts;
- the configured `setup_command`, `test_command` and `e2e_command`;
- package-manager `install`, `ci`, `run` and `test`, and `npx playwright`;
- the Agent, Skill and Monitor tools.

File edits are limited by role:

- **worker:** the repo's worktrees under `~/.local/state/cstack/worktrees/<owner>-<name>/` and `.cstack/runs/`.
- **e2e author:** `paths_hidden` of its own worktree and `.cstack/runs/`.
- **grader:** `.cstack/runs/` only.

Every role may read the repo, its worktrees, the plugin, `/tmp` and `~/.claude/projects` (the transcript audit in `cstack:show-me-your-work`).

The deny list covers four groups:

- privilege and remote shells: `sudo`, `su`, `ssh`, `scp`, `rsync`;
- network tools: `curl`, `wget`, `nc`, WebFetch, WebSearch;
- account-level and irreversible GitHub and git actions;
- credential stores, the user's own configuration, `.cstack/config.json`, and `claude` itself, so a session cannot start an unrestricted one.

All roles but coordinator also deny `systemd-run`. cstack's ssh deploy and the merge gate's `gh pr merge` run as subprocesses of gate scripts, which permission rules do not see.

`permissions_allow` in `.cstack/config.json` adds rules to every role. Only a person edits the config, because both the guard and the deny list protect it.

## Failing loudly

In `-p` mode a refused call comes back to the model as an error, and the `result` event lists it in `permission_denials`. `worker.mjs exit` reads that list. A unit that did not settle gets inbox status `denied`, and `workers/<unit>.denied.txt` lists every refused call. A unit that settled anyway gets a note in its exit line.

`cstack:orchestrate`, `cstack:daemon` and `cstack:resume-run` never relaunch a `denied` unit, because the relaunch would be refused again. They settle it with failure kind `setup` and report the refused calls. The e2e author's launch checks the same field.

## Evidence

On 2026-10-29, Claude Code 2.1.308, two headless haiku sessions ran under `--permission-mode dontAsk`.

The exploratory session, with a hand-written allow list:

- Allowed `node --version`, `R=/x; node --version`, `git --version && node --version`, and a redirect to a literal allowed path.
- Refused a redirect to `$S/b.txt`, `curl`, `node -e`, `cat` outside the working directory, and `rm`.

The smoke session ran under `systemd-run --user --wait`, with the generated worker settings, the plugin loaded and `CSTACK_RUN` set:

- `git -C <repo> commit --allow-empty` ran and made the commit.
- `curl -sI https://example.com` was refused ("Permission to use Bash with command curl -sI https://example.com has been denied.").
- The `result` event listed it in `permission_denials`.
- `worker.mjs exit` on that transcript printed `U1 denied 1 tool call(s) refused by the role's allowlist, first: Bash: curl -sI https://example.com` and pushed a `denied` inbox entry.

A third probe ran with the same flags:

- `CSTACK_ROLE=grader node ...` and `CSTACK_ROLE=e2e-author git ...` ran under literal prefixed allow rules.
- `CSTACK_ROLE=other node ...` was refused: an allow rule does not match past an unknown assignment.
- `CSTACK_ROLE=e2e-author curl ...` was refused: a deny rule matches past any assignment.
- The Monitor tool ran `node --version` and was refused `curl`, so Monitor commands go through the same Bash rules.

The lists therefore carry role-prefixed copies of the Bash rules a role runs with a prefix.

## Consequences

- Bash rules match command text. `Bash(node *)`, the configured test command, and anything a package script runs can still do whatever a program can, so the allowlist is a guard against mistakes and drift, not a sandbox. ADR-001's filesystem isolation and the guard hook keep their roles.
- Redirects must name a literal path. A redirect into `$VAR/...` is refused, because the target cannot be resolved. `skills/cstack/references/claude-code-notes.md` tells headless sessions to write literal absolute paths and never to work around a refusal.
- A rule the lists missed shows up as a `denied` unit, not as a silent bypass. The first real Level B run is the test of the lists. Widen them in `gates/lib/permissions.mjs` when a refusal is a cstack need, or in `permissions_allow` when it is the repo's.
- The spike scripts that used the bypass are gone (`spike/` was removed for the directory listing).
