<p align="center">
  <img src=".claude-plugin/icon.png" alt="cstack logo" width="200">
</p>

# cstack

## Why I built cstack

I wanted to hand an AI agent a well-researched idea and get back working, tested, merged code that I could actually trust, without having to sit there approving every step.

My first attempt was **Cardinal**, my own autonomous harness. It was a Python service that worked GitHub issues end to end: it triaged each issue, planned it, implemented it, verified it, opened the PR, watched CI and merged. Its main lesson was that a coding agent's account of its own work is not evidence. Cardinal worked because deterministic code checked every claim the model made: the exact commit, the tests, which files changed, and CI. But it was a runtime I had to build, host and maintain.

Then two plugins showed that the same discipline could live as plain instructions to the agent itself:

- **pstack**, by Lauren Tan, teaches an agent how to think. It has principles, playbooks for design, investigation and review, multi-model adversarial review, a decision log you can audit, and an orchestration store for long programs.
- **tstack**, by Theo Browne, teaches an agent how to ship. Its rule is that proof is evidence you observed yourself. It adds full-send and full-stop permission grants, a review loop with a second model, a PR watcher that never stops waiting while checks are pending, and takeover and modernize for inherited work.

cstack combines the three. It takes pstack's way of thinking, tstack's way of shipping and Cardinal's methodology, and packages them as a Claude Code plugin made only of skills, subagents, hooks and small gate scripts.

| From | What cstack kept |
|---|---|
| Cardinal | The issue lifecycle (intake, implement, verify, sync, PR, CI, merge, post-merge CI); gates that check every model claim; a hidden grader the implementer never sees; progress kept in git, not in memory; the scout |
| pstack | The mode skill and its principles; `how`, `architect`, `arena`, `interrogate` and `blast-radius`; verification skills; the decision log; the orchestration store |
| tstack | Proof before claims; `full-send` and `full-stop`; the review loop and council; the PR watcher; `takeover` and `modernize`; comment etiquette |

The result is one command, `/cstack:program`, that turns a guideline into merged, verified code. [Sample prompt](#sample-prompt) shows what to give it.

## What it is

cstack is a Claude Code plugin that takes a written idea to merged, tested code on your default branch. It is made only of skills, subagents, hooks and small gate scripts. There is no server and no runtime to install.

Give it a guideline (the problem, the goals, the behaviour you expect end to end) and run `/cstack:program`. It writes a spec, writes a hidden end-to-end test suite before any product code exists, plans the work as units, builds each unit in its own worktree, has a different model verify and review it, and merges each PR only when every gate passes. At the end, a fresh agent that wrote no code runs the whole hidden suite on the merged commit.

## Philosophy

cstack exists because a coding agent's account of its own work is not evidence. These rules shape every skill.

**Models find and argue. Gates decide.** An agent may claim that tests pass, a requirement is met or CI is green. cstack never takes that claim as is. Small deterministic scripts in `gates/` check each claim against the repo, git and GitHub, and a failing gate is final for that round. The agents do the judgement, the writing and the coordination. The gates do the deciding.

**Proof is something observed in this session.** Command output, a reproduction, a screenshot. "It compiles" and green mocked tests do not prove user-visible behaviour. When there is no way to prove a change, the agent says so instead of claiming it works.

**Only a non-author verdict counts.** The agent that wrote a change never approves it. A separate verifier, on a different model, judges each unit at one exact commit, and a review loop on yet another model reads every diff. A new commit voids the verdict.

**Write the test first, and hide it.** Before any product code, a dedicated author writes an end-to-end suite from the spec. It runs that suite against the empty repo to show every lane fails for the right reason, and plants deliberate breaks to show the lanes catch them. Implementers can run the suite but never read it. They work in a sparse checkout without it, and a hook blocks every attempt to reach it, so they build to the requirement and not to the test.

**Progress lives in git and files, not in context.** Commit trailers, a run store under `.cstack/runs/`, an append-only decision log. Any session can stop, crash or be compacted, and a fresh one resumes from disk.

**Bound everything, and fight scope.** Every loop has a number in the config. Reaching it is a classified failure, never an approval. Review findings that are not about the change become follow-up issues, not more code in the PR.

**Encode lessons in structure.** When a rule matters, it becomes a hook, a gate or a lint, not another paragraph of instructions. Instructions are not enforcement.

**Never block on the human for reversible work. Always stop for irreversible work.** cstack decides what an experiment can settle. It stops before force-pushing a shared branch, deploying, deleting data, or messaging people outside the run.

More on how this fits together: [docs/how-it-works.md](docs/how-it-works.md). Every skill: [docs/skills.md](docs/skills.md).

## What it has done

Each fixture is a written brief plus a held-out grader that cstack never sees. The grader runs only after the program ends, against what merged.

| Fixture | What cstack built | Held-out grader | Time (budget) | PRs merged | Questions asked |
|---|---|---|---|---|---|
| f1 | An expense-ledger CLI | 24/24 | 53 min (2 h) | 3 | 0 |
| f2 | An HTTP URL shortener with persistence and rate limiting | 30/30 | 1 h 57 min (6 h) | 4 | 0 |
| f3 | A kanban web app with drag and drop and keyboard moves, tested with Playwright | 25/25 | 3 h 21 min (12 h) | 4 | 0 |

Runs and failure-injection scenarios are logged in [docs/scenario-log.md](docs/scenario-log.md).

## Install

From your shell:

```
claude plugin marketplace add oddballmeasure/cstack
claude plugin install cstack@cstack
```

Or in one command (Claude Code 2.1.292 or later): `claude plugin install cstack --marketplace oddballmeasure/cstack`.

**Codex (preview).** cstack also installs in the Codex CLI:

```
codex plugin marketplace add oddballmeasure/cstack
codex plugin add cstack@cstack
```

Call skills as `$cstack:<name>`, for example `$cstack:doctor`. Codex skips plugin hooks until you trust them once in `/hooks`, and cstack's guard is one of those hooks. Codex support is still being built, so for now use it only for the in-session skills (ADR-010).

Any install scope works. cstack's hooks act only inside a cstack context: a repo whose root has `.cstack/config.json` (written by `/cstack:setup-cstack`), or a session that cstack itself launched. In every other project they exit at once and change nothing.

## Requirements

- Claude Code, Node 22 or later, `git` and `jq`.
- The GitHub CLI (`gh`), logged in with access to the repo. cstack works through issues, labels, pull requests and CI checks, so the target repo must be on GitHub.
- For detached work, a host supervisor: a systemd user session on Linux, launchd on macOS or Task Scheduler on Windows. On any other host, cstack falls back to a detached process, which cannot survive a reboot (ADR-011). That covers the e2e author's own session, programs of more than 5 units or with `parallel` above 1, the daemon, and runs that survive the terminal closing. Without it, `/cstack:unit`, the review skills, small programs (run in your session) and the e2e author (as an in-session subagent, with limits; see `skills/e2e-plan/SKILL.md`) still work.

## Quickstart

1. In the target repo, run `/cstack:setup-cstack`. It writes `.cstack/config.json`, creates the labels, ignores the run store, and ends with `/cstack:doctor`.
2. Write a guideline: the problem, who it is for, goals and non-goals, and the end-to-end behaviour you expect (commands or requests with exact results, including failure paths).
3. Run it:
   ```
   /cstack:program docs/idea.md
   ```

The default autonomy is `send` (ADR-007): the merge gate merges each PR once CI, the verifier and the review loop pass. To merge everything yourself, set `"autonomy": "stop"` in `.cstack/config.json` or pass `--autonomy=stop`. Each PR then ends merge-ready, and you resume with `/cstack:program --resume <slug>`.

One issue instead of an idea: `/cstack:unit <issue>`. Not sure which skill to use: `/cstack:cstack-help`.

## Sample prompt

This is a complete guideline for `/cstack:program`. Save it as `docs/idea.md` in an empty repo that has been set up with `/cstack:setup-cstack`. Then run `/cstack:program docs/idea.md`.

To build your own app, keep the structure and replace the parts between `<objective>` and `<constraints>`. The section that matters most is `<e2e_requirements>`. cstack writes its hidden test suite from it before any product code exists, so each item needs an action someone can perform and an exact result someone can check, including the failure paths.

<details>
<summary>Show the sample prompt (Shelf, a reading-list web app)</summary>

```xml
<prompt>
<role>
You are running a cstack program. You plan, build, verify and ship one small application from this
guideline, end to end, without a person in the loop except where the guardrails say to stop. You are
evidence-driven: you trust what a gate, a test or a command output shows, not what an agent says.
</role>

<objective>
Build Shelf, a small reading-list web app. A reader adds books they want to read, moves each one through
"to read", "reading" and "done", rates finished books, and sees how many they read per month. One
person on one machine uses it. The data must survive restarts.
</objective>

<context>
- Repo: empty except for README.md and .cstack/config.json (from /cstack:setup-cstack).
- Stack: Node 22 or later, with no runtime dependencies. node:http serves a JSON API and static files.
  The UI is plain HTML, CSS and JavaScript with no build step.
- Persistence: one JSON file, path from env SHELF_DATA (default ./data/shelf.json), with atomic writes.
- Entry point: server.mjs. Port from env PORT (default 3000).
- Tests: node:test for units. The end-to-end suite may use Playwright (devDependency @playwright/test,
  Chromium only).
</context>

<users_and_goals>
Users: one reader, on desktop or phone.
Goals:
- Add a book in under 10 seconds: title required, author optional.
- See the list grouped by status, newest first in each group.
- Move a book between statuses with a click, or from the keyboard.
- Rate a book 1 to 5 stars once it is done.
- See books finished per month for the last 12 months.
Non-goals: accounts, sharing, sync between devices, book covers, external book APIs, imports.
</users_and_goals>

<requirements>
R1. POST /api/books with {"title", "author"?} creates a book with status "to-read" and returns 201 and
    the book (id, title, author, status, rating: null, created_at, finished_at: null).
R2. A title is required and is trimmed. It must be 1 to 200 characters, and author is 0 to 120
    characters. Anything else returns 400 with {"error": "<field>: <reason>"}.
R3. GET /api/books returns every book, sorted by created_at, newest first.
R4. PATCH /api/books/:id with {"status"} moves a book between "to-read", "reading" and "done". Moving
    to "done" sets finished_at. Moving away from "done" clears finished_at and rating.
R5. PATCH /api/books/:id with {"rating": 1..5} works only on a "done" book. Otherwise it returns 409
    with {"error": "rating: book is not done"}.
R6. DELETE /api/books/:id returns 204. An unknown id on any route returns 404 with
    {"error": "not found"}.
R7. GET /api/stats/monthly returns 12 entries [{"month": "YYYY-MM", "done": n}], oldest first, ending
    with the current month.
R8. Data persists across a server restart, and a crash during a write never leaves a corrupt file.
R9. The UI at / shows three columns (To read, Reading, Done) and an add form. Every action is
    reachable by keyboard: Tab to a card, then use the "Move" menu or press 1, 2 or 3.
R10. GET /health returns 200 with {"ok": true}.
</requirements>

<e2e_requirements>
E1. Adding "Dune" by "Frank Herbert" in the UI shows it at the top of "To read" within 1 second.
    Covers R1, R9.
E2. Submitting the add form with an empty or spaces-only title shows "Title is required" next to the
    field, and no book is created. Covers R2.
E3. POST /api/books with a 201-character title returns 400 with {"error": "title: 1-200 characters"}.
    Covers R2.
E4. Moving "Dune" to "Reading" and then to "Done" places it in the Done column, with a "Finished"
    date of today. Covers R4, R9.
E5. Rating a "to-read" book through the API returns 409 with {"error": "rating: book is not done"}.
    Covers R5.
E6. Setting 4 stars on a done book shows 4 filled stars after a page reload. Covers R5, R8.
E7. After a server restart, all books, statuses and ratings are unchanged. Covers R8.
E8. Pressing 2 on a focused card moves it to "Reading", with no mouse. Covers R9.
E9. GET /api/stats/monthly returns 12 entries, and the last entry counts the books finished this month.
    Covers R7.
E10. DELETE on an unknown id returns 404 with {"error": "not found"}. Covers R6.
E11. GET /health returns 200 with {"ok": true}. Covers R10.
</e2e_requirements>

<constraints>
- No runtime npm dependencies. devDependencies are limited to @playwright/test.
- Every API response is JSON with the right status code, and no stack traces ever reach the client.
- Book titles are rendered as text, never as HTML (no XSS).
- npm test runs the unit tests and passes on a clean clone.
</constraints>

<process>
Follow cstack's program pipeline. Do not skip a gate.
1. Preflight: doctor checks tools, config, labels and hooks.
2. Frame: write the spec (R and E numbers as above, plus a measurable done predicate). Gate: check-spec.
3. Understand: profile the repo.
4. E2E first: a separate author writes the hidden suite. Every lane fails on the empty repo, and
   planted breaks are caught. It merges as PR #0. Gate: check-e2e.
5. Plan: split the work into units with dependencies, each mapped to requirements and lanes.
   Gate: check-plan.
6. Execute: each unit is built in its own worktree. A verifier on a different model judges it at the
   exact commit, then the review loop runs, then the merge gate.
7. Integrate: judge CI on every merge commit.
8. Final proof: a fresh agent runs the whole hidden suite on the merged commit, and a council
   reviews the full diff.
9. Close: audit the decision log and write the report.
</process>

<guardrails>
- Never read or edit the hidden e2e suite while implementing. Run it only through the gate.
- Only the merge gate merges. Never merge past a red check, an open blocker or a stale verdict.
- Fight scope: a review finding that is not about this change becomes a follow-up issue.
- Stop and ask before anything irreversible: force-pushing a shared branch, deleting data, deploying.
- Do not add features, dependencies or files outside this guideline.
</guardrails>

<output_format>
End with one report:
1. Summary: what shipped, the merged SHA, and the time taken.
2. Requirements trace: each R, then its E lanes, then the PR, then where the evidence is.
3. Hidden suite result at the merged SHA, lane by lane.
4. Decisions taken without asking, and why.
5. Follow-ups filed, with links.
6. Known limits and risks.
</output_format>

<evaluation_criteria>
The program succeeds when:
- every E lane passes at the merged SHA, run by an agent that wrote none of the code;
- CI is green on the merge commit;
- every R maps to at least one merged PR and one passing lane;
- no question needed a person, apart from the guardrails;
- the code stays small enough for one person to maintain.
</evaluation_criteria>

<rules>
- A claim without a command output, a test result or a gate verdict behind it is not a result.
- Label every assumption as an assumption in the decision log.
- Prefer the smallest change that passes the gate.
- Write behaviour-level tests at the boundary (HTTP and UI), not tests of private helpers.
</rules>

<starter_prompt>
In Claude Code, in the target repo:
- /cstack:setup-cstack
- Save this prompt as docs/idea.md.
- /cstack:program docs/idea.md
- To merge every PR yourself: /cstack:program docs/idea.md --autonomy=stop
- To check progress at any time: /cstack:status
</starter_prompt>

<final_check>
Before reporting done, check:
- Does every E lane pass at the exact merged SHA, and not just on a branch?
- Did any verdict come from the agent that wrote the code?
- Is anything in the report a claim without evidence?
- Did any PR grow beyond its unit?
- What would make a reader distrust this result?
</final_check>
</prompt>
```

</details>

## Examples

| You type | What happens |
|---|---|
| `/cstack:setup-cstack` | Detects the base branch and test command, writes `.cstack/config.json`, creates the `cstack:*` labels, gitignores the run store, then runs the read-only `/cstack:doctor`. |
| `/cstack:unit 42` | Takes GitHub issue #42 end to end: claims it, builds it in its own worktree, has a separate verifier and reviewer check it, opens a PR, watches CI, and merges through the merge gate (or leaves it merge-ready under `autonomy: stop`). |
| `/cstack:program docs/idea.md` | Turns a written guideline into a spec, a hidden end-to-end suite, a plan of units and a series of merged PRs, then has a fresh agent run the hidden suite on the result. |
| "What could this rename break?" | `cstack:blast-radius` traces every caller and consumer of the change in the repo before it answers, instead of reading only the diff. |
| "Tear this branch apart" | `cstack:interrogate` sends the diff to reviewers on different models, then checks each finding against the code before reporting it. |
| `/cstack:status` | A short report on the current run: units by state, what is verified, and anything waiting on you with a recommended choice. |

## Unattended work

- **Scout.** `/cstack:scout` surveys the repo and proposes small, verified issues labelled `cstack:proposed`. Approve one by swapping the label for `cstack:ready`. Close it with a comment to reject it, and the next pass reads why.
- **Daemon.** `/loop 10m /cstack:daemon`, in a session started as `CSTACK_COORDINATOR=1 claude`, works every `cstack:ready` issue as a detached worker. `skills/daemon/references/cstack-daemon@.service` runs it as a service.
- **Deploy.** `cstack:deploy` runs a merged revision's committed `deploy.sh` once, then polls health. A person approves each deploy unless the config sets `deploy.auto`.

## Before you rely on it

- **Permissions.** No cstack session bypasses permissions. Detached sessions run with `--permission-mode dontAsk` and an allowlist for their role, so anything outside it is refused at once instead of prompting. The allowlist names commands broadly (`git`, `gh`, `node`, your configured test command), and your test command and `node` scripts can still do anything a program can. Run it on repos where that is acceptable. When a worker needs a command its role does not allow, it stops with status `denied` and lists the refused calls, and you add a rule to `permissions_allow` in `.cstack/config.json`.
- **Usage.** A program runs many agents and subagents. Large runs can use up a Claude subscription's usage window. cstack waits for the reset and resumes, but plan for it.
- **Branch protection.** Where GitHub does not enforce required checks (for example, private repos on some plans), cstack's merge gate is the only thing enforcing them. Keep `required_checks` in the config current.
- **Not yet live-tested:** a real scout pass, a daemon tick and a deploy. Unit tests cover them. [docs/cardinal-parity.md](docs/cardinal-parity.md) marks the status of every capability.

## What cstack runs, sends and stores

cstack has no server and no telemetry. It sends nothing to its author. Everything below runs on your machine, under your own accounts.

**Commands it runs**

- **`git`**: branches, commits, worktrees, rebases, and pushes to your repo's `origin` (a force push only with `--force-with-lease`, on the run's own branches).
- **`gh`**, with your own `gh` login, calling the GitHub API for the repo you point it at: read and create issues, labels, comments, pull requests and reviews; read check runs and CI logs; merge a PR (only through `gates/check-merge.mjs`, and only under `autonomy: send`).
- **Headless Claude Code sessions**: `claude -p --permission-mode dontAsk --settings <role allowlist> --strict-mcp-config --plugin-dir <cstack>`, started through the host supervisor (`systemd-run --user`, launchd, Task Scheduler or a detached process). This happens only in these cases:
  - `/cstack:program` (and `/cstack:full-send` on a guideline) launches the e2e author this way by default, because the guard can only grant its suite-writing role to a session started with it;
  - `/cstack:orchestrate` and `/cstack:resume-run` launch one worker per unit when a program has more than 5 units or `parallel` above 1;
  - `/cstack:daemon` launches one worker per `cstack:ready` issue, and the optional `skills/daemon/references/cstack-daemon@.service` unit runs the daemon itself this way, but only if you install it.

  **No permission bypass.** None of these sessions uses `--dangerously-skip-permissions`. Each runs in `dontAsk` mode with a settings file that `gates/run-settings.mjs --permissions <role>` generates. That file has an explicit `permissions.allow` list for the role, a `permissions.deny` list, and bypass mode disabled. Anything not on the allow list is refused at once, with no prompt, so a session never waits on one. A worker that is refused a call it needed stops with status `denied` and lists every refused call in `.cstack/runs/<run>/workers/<unit>.denied.txt`. A person can widen the list with `permissions_allow` in `.cstack/config.json`.

  | Role | Allowed (besides reading the repo, its worktrees, the plugin and `/tmp`) |
  |---|---|
  | worker | Edits in this repo's worktrees and run store. `git`, `gh`, `node`, `jq`, the configured `setup_command`/`test_command`/`e2e_command` (with `install`, `ci`, `run` and `test` for a JS package manager, plus `npx playwright`), the plugin's own scripts, `mkdir`/`cp`/`mv`/`touch`/`chmod +x`/`rm -f`, read-only `systemctl --user`/`journalctl --user`, and the Agent, Skill and Monitor tools. |
  | coordinator | Everything a worker may do, plus starting the e2e author (`systemd-run --user ... --unit=cstack-e2e-*` or `gates/supervise.mjs start`) and stopping `cstack-*` sessions. Other roles may not start or stop sessions. |
  | e2e-author | Edits only inside `paths_hidden` of its worktree and the run store. Otherwise as a worker. |
  | grader | For a separate headless verification session. Read-only: the gates, the configured commands, and `gh pr`/`issue`/`run` views. Writes only to the run store. cstack's own verifier is a subagent, so it inherits the allowlist of the session that spawns it. |

  Every role denies `sudo`, `su`, `ssh`, `scp`, `rsync`, `curl`, `wget`, `nc`, WebFetch and WebSearch, as well as `gh pr merge`, `gh repo delete`/`edit`, `gh secret`, `gh auth`, `gh release`, `gh api` DELETE calls, force and delete pushes, `npm publish`, `crontab` and `claude`. It also denies reading `~/.ssh`, `~/.aws`, `~/.gnupg`, gh's credentials and Claude's credentials, editing `~/.claude`, `~/.config` and shell profiles, and editing `.cstack/config.json`. All roles except coordinator also deny `systemd-run`. The full lists are in `gates/lib/permissions.mjs`. Bash rules match command text, so they are a guard against mistakes, not a sandbox. cstack's hooks are a second layer and still apply in every session (hidden suite, config lock, no direct merges, no sleep loops, no self-approved deploys).

  The sessions run with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset, so they use your Claude subscription login, and with `--strict-mcp-config`, so your MCP servers are not loaded. `/cstack:unit` and the review skills never start one; they use ordinary subagents in your session.
- **`ssh`**: only `gates/deploy.mjs`, only when `.cstack/config.json` sets `deploy.transport` to `ssh`, and only after a person approves the deploy (unless the config sets `deploy.auto`). Deploys are off when `deploy` is absent. It runs your repo's committed `deploy.sh` and health command, either locally or on the host your `deploy.json` names.
- **Your repo's own commands**: the `test_command`, `setup_command` and `e2e_command` from the config, and your `deploy.sh`. cstack runs them as written; what they reach is up to them.
- **`claude plugin eval --no-publish`**: only `/cstack:eval-skill`, which you start yourself. The guard blocks any `claude plugin eval` without `--no-publish`, so eval reports are never uploaded.
- **`systemctl --user`, `launchctl` or `schtasks`** (through `gates/supervise.mjs`): to start, check and stop the detached sessions above. Each session is recorded in `~/.local/state/cstack/sessions/`.

cstack's own scripts make no other network calls: no HTTP requests, no downloads, no package installs.

**Where data goes**

- **GitHub**: what you would see on the repo anyway (branches, PRs, issues, comments, labels), through your `gh` login.
- **Anthropic**: the prompts, code and tool output of every Claude Code session and subagent cstack runs, through your own Claude Code login, as in any Claude Code session.

**Files it writes**

- `.cstack/config.json` in your repo (you review and commit it).
- `.cstack/runs/<run>/` in your repo, gitignored: the unit table, plans, briefs, the decision log (`decisions.tsv`), verification records, worker logs and the inbox.
- Worktrees under `~/.local/state/cstack/worktrees/<owner>-<name>/`, and PR-watcher state under `~/.local/state/cstack/pr-wait/`. cstack does not delete worktrees; remove them with `git worktree remove` when you are done.
- `.gitignore` entries for the run store, added by `/cstack:setup-cstack`.

## Support

- Questions and bugs: [GitHub Issues](https://github.com/oddballmeasure/cstack/issues).
- Security problems: report them privately, as [SECURITY.md](SECURITY.md) describes. Do not open a public issue.

## Privacy

cstack collects no data and runs no servers. See [PRIVACY.md](PRIVACY.md).

## Credits

cstack combines three bodies of work:

- **pstack** by Lauren Tan ([cursor/plugins](https://github.com/cursor/plugins/tree/main/pstack), MIT): the mode skill and principles, playbooks for design, review and verification, the decision log, the orchestration store.
- **tstack** by Theo Browne ([t3dotgg/tstack](https://github.com/t3dotgg/tstack), MIT): full-send and full-stop, proof discipline, the review loop and council, the PR watcher, takeover and modernize.
- **Cardinal**: the issue lifecycle, the gates that check every model claim, hidden graders, the scout and post-merge CI.

Every adapted file names its source. See [NOTICE.md](NOTICE.md).

## Development

- `node tests/lint/lint.mjs`, `npm test`, and `npm run coverage:gates` (the gates must stay at 100% line and branch coverage).
- L3 scenarios against a sandbox repo: [tests/scenarios/README.md](tests/scenarios/README.md).
- L4 fixture programs: [tests/fixtures/README.md](tests/fixtures/README.md).
- Decisions: [docs/adr/](docs/adr/). Authoring rules: [docs/conventions.md](docs/conventions.md).

MIT licensed.
