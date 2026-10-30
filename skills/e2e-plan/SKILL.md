---
name: e2e-plan
description: "Use when cstack needs an end-to-end test suite for a spec, for example at step 3 of a program run after spec.md passed check-spec. Launches one e2e author (the plugin's cstack-e2e-author agent, headless, CSTACK_ROLE=e2e-author) that writes <store>/e2e-plan.md and a hidden suite under paths_hidden with lane-prefixed TAP test names, proves it with a red check and a mutation spot-check, and passes gates/check-e2e.mjs. Then ships the suite as PR #0 through the unit ship stages with unit id E2E."
argument-hint: "--run <slug> [--issue <n>]"
---

# E2E plan

This skill turns `spec.md` into `e2e-plan.md` and a hidden e2e suite. The suite is the judge for the whole run: implementers start from a base that contains it, and the program's final proof is this suite passing at the base head. Implementers never read it. They see lane ids and one-line reasons from `gates/run-e2e.mjs`.

Two sessions take part:

- **The coordinator** is the session that runs this skill. It prepares the worktree, sets config, launches the author, runs the gates and ships PR #0. It never reads or writes the suite. The guard hook blocks it from `paths_hidden`.
- **The author** is the plugin's `cstack-e2e-author` agent, launched with `CSTACK_ROLE=e2e-author`. It writes the plan and the suite and proves them. It never writes product code.

Read the [cstack mode skill](../cstack/SKILL.md) first. The format contract for the plan is the comment block in `<root>/templates/e2e-plan.md`. The ship stages follow `docs/unit-flow.md` in the plugin root.

## Names

Shell variables do not persist between Bash calls. Resolve each name once and write the absolute value into every command and into the brief.

| Name | Value |
|---|---|
| `<root>` | The plugin root, two directories up from this skill's base directory. |
| `<repo>` | The target repo root: `git rev-parse --show-toplevel`. |
| `<slug>` | The `--run` slug, the same one `cstack:spec` used. |
| `<store>` | `<repo>/.cstack/runs/<slug>`, absolute. It holds `spec.md`. |
| `<orch>` | `node <root>/gates/orch.mjs --store <store>` |
| `<log>` | `node <root>/skills/show-me-your-work/scripts/log.mjs <store>/decisions.tsv` |
| `<N>` | The tracking issue for PR #0 (step 3). |
| `<branch>` | `cstack/<N>-e2e-suite` |
| `<wt>` | `~/.local/state/cstack/worktrees/<owner>-<name>/<branch with / replaced by ->`, expanded to an absolute path. |
| `<hidden>` | The literal prefix of the first config `paths_hidden` glob, for example `tests/acceptance`. Write it only into files (the brief, the command file). Never put it in a coordinator Bash command: the guard blocks any coordinator command that names a hidden path. |
| `<judge>` | Config `models.judge`. `inherit` means omit `--model`. |
| `<author>` | The plugin's `cstack-e2e-author` agent under its plugin-prefixed name: the plugin name `cstack`, a colon, then `cstack-e2e-author`. |

## Procedure

### 1. Preconditions

1. `node <root>/gates/check-spec.mjs <store>/spec.md` exits 0. If not, run `cstack:spec` first.
2. Read config with `jq` from `<repo>/.cstack/config.json`: `repo`, `base_branch`, `paths_hidden`, `e2e_command`, `setup_command`, `models.judge`, `limits`, `autonomy`, `label_prefix`. Without a config, stop and ask the human to run `/cstack:setup-cstack`.
3. `paths_hidden` is not empty and its first glob has a literal directory prefix. Else stop with failure `setup`.
4. If `<store>/e2e-plan.md` exists and the gate in step 7 passes on it, skip to step 8. Progress lives in the store and on the branch.

### 2. Choose the driver and the e2e command

These are the coordinator's choices, because the author cannot write config.

**Driver.** Read the spec's E requirements. Pick one driver per surface: `cli` (spawn the command, assert stdout, stderr and exit code), `http` (a Node test runner or curl against a started server), `browser` (Playwright), `library` (public API only).

- If the repo has `.claude/skills/verify-<app>/`, name it in the brief. The author reuses its launch, doctor and drive recipes.
- If the surface is `browser` or a long-running service, the app runs today, and no verify skill exists, run `cstack:create-verification-skill` first.
- For `cli` and `library` surfaces, and for a repo with no app yet, the suite's own harness is the driver.

Log the choice.

**e2e command.** If config `e2e_command` is set, keep it. If it is null, choose a command that runs every file in the suite and prints TAP on stdout. For a Node repo the default is:

```json
["node", "--test", "--test-reporter=tap", "<hidden>/**/*.test.mjs"]
```

(Node expands the glob itself. A bare directory argument does not work with `node --test`.) For other stacks, pick the stack's test runner with a TAP reporter (for example `bats --tap <hidden>`). Write the JSON array to `<store>/e2e-command.json` with the Write tool. Step 4 applies it.

### 3. Open the E2E unit

1. **Tracking issue.** Use `--issue <n>` from the caller if given. Else create one:
   ```sh
   node <root>/gates/forge.mjs issue create --title "Add the hidden e2e suite for <spec title>" --body-file <store>/e2e-issue.md
   ```
   Write `<store>/e2e-issue.md` first: the spec path, the E ids, and the line "cstack adds a hidden end-to-end suite. Implementers see lane results only." End it with the footer from `<root>/templates/footer.md`.
2. **Claim.** `node <root>/gates/settle.mjs <N> --state in-progress --repo-dir <repo>`.
3. **Register the unit.** Run `<orch> init` if `<store>/units.tsv` does not exist. Then `<orch> unit add E2E --track e2e --issue <N> --state ready` if `<orch> unit get E2E` fails, and `<orch> unit set E2E --state in-progress`.
4. **Isolate.**
   ```sh
   node <root>/gates/isolate.mjs <repo> <branch> <wt>
   git -C <wt> sparse-checkout disable
   <orch> unit set E2E --branch <branch>
   ```
   `isolate.mjs` hides `paths_hidden` with a sparse checkout, as it does for implementers. This worktree belongs to the author, who must write there, so turn sparse checkout off. No implementer ever uses this worktree.

### 4. Set the e2e command (when config had none)

The author cannot write config. The guard blocks every file-tool write to `.cstack/config.json` for every role. The coordinator sets it through a gate that changes that one key, and the human reviews the change in PR #0.

```sh
node <root>/gates/set-e2e-command.mjs <wt> --command-file <store>/e2e-command.json
git -C <wt> add .cstack/config.json
git -C <wt> commit -m "Set e2e_command for the hidden suite" -m "Cstack-Unit: E2E
Cstack-Ticket: E2E-CONFIG
Refs: #<N>"
```

Log the command and the commit SHA. Gates in this skill read the config from `<wt>`, not from `<repo>`, until PR #0 merges.

### 5. Launch the author

Write the brief to `<store>/brief-e2e.md` with the Write tool. Use the headings GOAL, SCOPE, CONTEXT, ACCEPTANCE, VERIFY, FORBIDDEN, REPORT. It holds:

- GOAL: `<store>/e2e-plan.md` and a suite under `<hidden>/` that pass the gates below.
- CONTEXT: the absolute paths of `<root>/skills/cstack/SKILL.md` (read it first), this skill's `SKILL.md` (follow **The author's job**), `<store>/spec.md`, `<root>/templates/e2e-plan.md`; the worktree `<wt>`; the store `<store>`; the slug; the issue `<N>`; the driver and any verify skill path; the `e2e_command` as written in `<wt>/.cstack/config.json`.
- ACCEPTANCE and VERIFY: the red check, the mutation spot-check and the gate commands from **The author's job**, verbatim with absolute paths.
- FORBIDDEN: everything outside `<hidden>/`, `<store>` and `/tmp/cstack-mutation/<slug>/`; config; pushes; GitHub writes; product code.
- REPORT: the report section of the agent file.

**Default: a headless session.** The guard hook reads `CSTACK_ROLE` from the environment of the session that runs the hook, and every hook inherits the session's environment. A prefix on one Bash command does not change it. So only a session started with `CSTACK_ROLE=e2e-author` can write the suite. Launch the author as its own `claude -p` session under systemd (ADR-001), with the worktree as its working directory.

Generate the author's permission settings first. The session runs with `--permission-mode dontAsk`: it may write only inside `paths_hidden` of `<wt>` and the run store, and every call outside its allowlist is refused without a prompt (ADR-009):

```sh
node <root>/gates/run-settings.mjs --permissions e2e-author --repo-dir <repo> --worktree <wt> --out <store>/e2e-author.settings.json
```

Write `<store>/e2e-author.sh` with the Write tool. The start command below runs it with `sh`:

```sh
#!/bin/sh
cd <wt>
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN CSTACK_ROLE=e2e-author PATH=<dir of node>:<home>/.local/bin:/usr/local/bin:/usr/bin:/bin \
  claude -p --agent <author> --model <judge> \
  --strict-mcp-config --plugin-dir <root> --permission-mode dontAsk --settings <store>/e2e-author.settings.json \
  --output-format stream-json --verbose \
  "$(cat <store>/brief-e2e.md)" > <store>/e2e-author.jsonl 2> <store>/e2e-author.stderr
echo $? > <store>/e2e-author.exit
```

Under Codex (see the Codex notes), the script runs `codex exec --json -C <wt> <sandbox flags> -m <models_codex.judge>` in place of `claude -p ...`, with `env -u OPENAI_API_KEY -u CODEX_API_KEY CSTACK_ROLE=e2e-author`, `</dev/null`, and the same output and exit files. The sandbox flags are the exact output of `node <root>/gates/run-settings.mjs --codex-sandbox auto --repo-dir <repo> --worktree <wt> --store <store>`: paste that line into the script as it is. It makes the repo's common `.git`, the run store, `~/.local/state/cstack` and the temp dir writable, which the author needs to commit and report (ADR-012). Codex loads no `--agent`, so the brief starts with "First read `<root>/agents/cstack-e2e-author.md` and follow it as your role." With the `CSTACK_ROLE` marker, the guard limits its writes to `paths_hidden` and applies the role's deny rules.

Drop `--model <judge>` when `models.judge` is `inherit`. Fill `<dir of node>` from `dirname "$(command -v node)"` and `<home>` from `$HOME`: a systemd unit does not inherit the login `PATH`. The hard-coded `--plugin-dir` makes the author load this plugin's hooks and agent. `--strict-mcp-config` keeps user MCP servers out.

Start it and wait on it with the `Monitor` tool. Never a sleep loop.

- Start: `rm -f <store>/e2e-author.exit && node <root>/gates/supervise.mjs start --name cstack-e2e-<slug> --cwd <wt> --log-dir <store> -- sh <store>/e2e-author.sh`. The host supervisor picks systemd, launchd, Task Scheduler or a detached process (ADR-011).
- Monitor command, timeout `1800000`:
  ```sh
  node <root>/gates/supervise.mjs wait cstack-e2e-<slug> --timeout 1700 && { cat <store>/e2e-author.exit 2>/dev/null || echo "author ended without an exit code"; }
  ```
  `timeout: 1700s` means the author is still running: re-arm. "Ended without an exit code" means the session was killed: treat it as a failure below.

When it ends, check billing: the init event in `<store>/e2e-author.jsonl` must show `"apiKeySource":"none"`. Then check refusals: `jq -c 'select(.type=="result") | .permission_denials' <store>/e2e-author.jsonl`. A non-empty list means the author's allowlist refused a call it needed. Treat the run as a failure with kind `setup`, and report each refused call with the fix: a rule in config `permissions_allow`. The author's report is the `result` event's text: `jq -r 'select(.type=="result") | .result' <store>/e2e-author.jsonl`.

**Fallback: an in-session subagent.** Use it only when the headless launch cannot run: no `claude` on `PATH`, or no `sh` (Windows without Git Bash). Spawn the plugin's `cstack-e2e-author` agent with the `Agent` tool, `model` from `models.judge`, and the brief as the prompt. The brief tells it to prefix every Bash command with `CSTACK_ROLE=e2e-author`. That prefix reaches the commands it runs, but not the guard, which sees this session's environment. So the fallback works only when this whole session was started with `CSTACK_ROLE=e2e-author` and does no implementation work in the run. In any other session the guard blocks every write to the suite, which is correct. Then stop with failure `setup` and say why. Log which mode ran.

**After the author ends:**

- `QUESTION E<n>` in the report: the E has no observable surface. Run `cstack:spec` with the question as its only open question, then relaunch the author with the amended spec. Do this once. A second question is failure `invalid_output`.
- `E2E_COMMAND_CHANGE`: check that the array prints TAP and stays inside the suite, write it to `<store>/e2e-command.json`, run step 4 again, and relaunch the author with the earlier brief, its report and the new command. Do this once.
- `git -C <wt> status --porcelain` prints anything: the author left uncommitted files. Relaunch once with that output in the brief.
- Any other failure: relaunch once with a fresh session, the original brief and the previous report. A second failure is failure `invalid_output`.

### 6. The author's job

The author runs these steps. They follow plan section 6.1, steps 1 to 7.

1. **Map each E to a surface.** Read `spec.md`. For each E, name the user-visible behaviour and where the user sees it. An E with no observable surface is not a lane. Report it as `QUESTION E<n>: <question>` and stop.
2. **Pick the driver** from the brief. Reuse the project verify skill when the brief names one.
3. **Write the lanes** into `<store>/e2e-plan.md`, in the template's format. Each E gets 1 or more lanes `E<n>.<m>`. Each lane has `Kind`, `Covers` (a subset of the E's Covers line), `Driver`, `Script` (numbered steps from the user's point of view, including setup and teardown), `Evidence` (`/tmp/cstack-e2e/<run>/<lane>.log`, or `.png` for screenshots) and one `Pass when` predicate with an exact value.
4. **Add negative lanes.** Every R gets at least one negative lane: bad input, a missing file, permission denied, a conflict. Assert the exact error text and exit or status code from the spec.
5. **Write the suite** under `<hidden>/`. Rules:
   - Each test name starts with its lane id and a space, for example `E1.2 rejects an empty title`. `run-e2e.mjs` finds lanes by that prefix in TAP.
   - One test per lane. A lane may hold several assertions.
   - Each test sets up its own state in a fresh temporary directory and cleans it up. Lanes never depend on each other or on order.
   - Drive the product only through its public surface, the same way a user does. Find it from the repo root (the test's working directory), never from a path inside the suite.
   - Each failure message names the expectation and the observation, for example `expected exit 2, got 0; stderr: ""`. That line is all an implementer will see.
   - Write the lane's evidence (command, stdout, stderr, exit code, or a screenshot) to its evidence path. Take `<run>` from env `CSTACK_E2E_RUN`, else `local`.
   - No dependency the repo does not already have, unless the spec allows it.
   Commit the suite with the trailers in the agent file.
6. **Red check.** Run the suite at the worktree head through the grader:
   ```sh
   CSTACK_ROLE=grader node <root>/gates/run-e2e.mjs <wt> --json
   ```
   Every lane must FAIL, and fail because the behaviour is missing: the command or route does not exist, or it gives the wrong output. Classify each lane:
   - `FAIL`, right reason: record the one-line reason.
   - `PASS`: the requirement is already met, or the test asserts nothing real. Fix the test, or report the met requirement.
   - `ERROR`: the test broke before it reached the product (syntax error, missing fixture, helper crash, timeout, lane not reported, `setup_command` failed). It is a broken test. Fix it and run again.
   For more detail on an ERROR, add `--raw` (allowed for the grader role only). Repeat until every lane is a right-reason FAIL. Record the final run as the `## Red check` table.
7. **Mutation spot-check.** Pick at least max(2, ceil(20% of lanes)) distinct lanes. Prefer negative lanes and lanes with exact outputs, spread over different E ids. In a scratch copy outside the repo:
   ```sh
   CSTACK_ROLE=e2e-author git clone --quiet <wt> /tmp/cstack-mutation/<slug>/repo
   ```
   - If the product exists, the scratch clone holds the reference behaviour.
   - If it does not exist yet, write a minimal reference stub inside the scratch clone. The stub implements only what the chosen lanes need, exactly as the spec says. Never commit it and never copy it into `<wt>`.
   For each chosen lane: run the e2e command in the scratch clone and confirm the lane PASSES against the reference. If it does not, the lane or the stub is wrong: fix it first. Then break the one behaviour the lane guards (wrong exit code, wrong text, wrong order, a missing check), run again, and confirm the lane FAILS. Restore the break before the next lane. A check you have never seen fail proves nothing, and a check that cannot pass proves nothing either. Record each row in the `## Mutation spot-check` table: the lane, what you broke, and `yes` when the lane caught it. Delete `/tmp/cstack-mutation/<slug>/` at the end.
8. **Gate the plan:**
   ```sh
   node <root>/gates/check-e2e.mjs <store>/e2e-plan.md --spec <store>/spec.md --config <wt>/.cstack/config.json --json
   ```
   Fix the findings and rerun. After 2 failed reruns, stop and report the findings.

If a suite fix after the red check changes a lane, run the red check again for the whole suite. The recorded table must match the committed suite.

### 7. Gate the result (coordinator)

The author's tables are model claims. Check them yourself:

1. `node <root>/gates/check-e2e.mjs <store>/e2e-plan.md --spec <store>/spec.md --config <wt>/.cstack/config.json --json` exits 0.
2. `node <root>/gates/run-e2e.mjs <wt> --json` at the branch head. Every lane in the plan is reported and fails, and no lane passes. Compare the lane ids with the plan's lanes. The exit code is non-zero by design: the red result is the pass condition here.
3. `git -C <wt> diff --name-only origin/<base_branch>...HEAD` lists only files under `paths_hidden` and `.cstack/config.json`. Run it without naming the hidden prefix in the command.

All three pass: record the approval for the head and the lanes, and log it.

```sh
<orch> ledger record E2E <head sha> approved --evidence <store>/e2e-plan.md --verifier check-e2e
<orch> unit set E2E --lanes <comma list of every lane id>
```

Any check fails: relaunch the author once with the findings (step 5). A second failure is failure `invalid_output`.

### 8. Ship PR #0

PR #0 goes through the ship stages of `docs/unit-flow.md` with unit id `E2E`, issue `<N>`, worktree `<wt>` and branch `<branch>`. Follow `cstack:unit`'s procedure for each stage:

| Stage | Owner | Note for E2E |
|---|---|---|
| 8 Publish | `cstack:unit` | `<orch> ledger check E2E <head>` must exit 0 first. Then `node <root>/gates/publish.mjs <wt>`. |
| 9 PR | `cstack:file-pr` | The body starts `Closes #<N>`. It lists the lanes by id and title (from the plan, not the suite source), the red-check summary and the mutation summary. If step 4 ran, add a section "Config change for review" that names the `e2e_command` it set. |
| 10 Babysit | `cstack:babysit-pr` | DIRTY or BEHIND: run `cstack:sync-base`, then step 7 again on the new head. A failed check: read it with `gates/ci-log.mjs`. A suite fix goes back to the author (step 5), never to an implementer. Skip step 10b (`cstack:review-loop`): a reviewer may not read the hidden suite, and you must not print its diff. `check-e2e`, the red check and the mutation spot-check judge it, and `check-merge.mjs` accepts that for unit `E2E` when the diff touches only `paths_hidden` and `.cstack/config.json` (ADR-006). Log `skip: hidden suite`. |
| 11 Merge gate | `cstack:merge-gate` | Merges only under the run's effective autonomy `send` (`gates/run-settings.mjs`), as for any unit. |
| 12 Settle | `cstack:settle` | Settle `<N>` and set the unit state. |

When step 4 changed the config, put the config change first in the final report so the human reviews it. Under `autonomy: stop` the human reviews it before merging. Under `send` the human reviews it after the merge. The change is one revertible line.

On failure at any stage, follow **On failure** in `cstack:unit` with unit `E2E`.

## Report

- The e2e-plan path and the gate's last line.
- Lanes: total, positive and negative, and per E.
- The red check: lane count and the distinct failure reasons.
- The mutation spot-check: lanes and breaks.
- The headless or fallback mode, and whether billing showed `apiKeySource: none`.
- The config change, if any, first.
- PR #0: link, head SHA, merge-gate verdict or merge SHA.
- Questions sent back to `cstack:spec`, if any.
