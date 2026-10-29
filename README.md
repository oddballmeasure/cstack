# cstack

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

Any install scope works. cstack's hooks act only inside a cstack context: a repo whose root has `.cstack/config.json` (written by `/cstack:setup-cstack`), or a session that cstack itself launched. In every other project they exit at once and change nothing.

## Requirements

- Claude Code, Node 22 or later, `git` and `jq`.
- The GitHub CLI (`gh`), logged in with access to the repo. cstack works through issues, labels, pull requests and CI checks, so the target repo must be on GitHub.
- For detached work: Linux with a systemd user session (`systemd-run --user`). That covers the e2e author's own session, programs of more than 5 units or with `parallel` above 1, the daemon, and runs that survive the terminal closing. Without it, `/cstack:unit`, the review skills, small programs (run in your session) and the e2e author (as an in-session subagent, with limits; see `skills/e2e-plan/SKILL.md`) still work.

## Quickstart

1. In the target repo, run `/cstack:setup-cstack`. It writes `.cstack/config.json`, creates the labels, ignores the run store, and ends with `/cstack:doctor`.
2. Write a guideline: the problem, who it is for, goals and non-goals, and the end-to-end behaviour you expect (commands or requests with exact results, including failure paths).
3. Run it:
   ```
   /cstack:program docs/idea.md
   ```

The default autonomy is `send` (ADR-007): the merge gate merges each PR once CI, the verifier and the review loop pass. To merge everything yourself, set `"autonomy": "stop"` in `.cstack/config.json` or pass `--autonomy=stop`. Each PR then ends merge-ready, and you resume with `/cstack:program --resume <slug>`.

One issue instead of an idea: `/cstack:unit <issue>`. Not sure which skill to use: `/cstack:cstack-help`.

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

- **Permissions.** Detached workers run headless with `--dangerously-skip-permissions`, because nobody is there to approve prompts. cstack's hooks still enforce the hard rules: hidden paths, the config lock, no direct merges, no sleep loops, no self-approved deploys. Run it on repos where that trade-off is acceptable.
- **Usage.** A program runs many agents and subagents. Large runs can use up a Claude subscription's usage window. cstack waits for the reset and resumes, but plan for it.
- **Branch protection.** Where GitHub does not enforce required checks (for example, private repos on some plans), cstack's merge gate is the only thing enforcing them. Keep `required_checks` in the config current.
- **Not yet live-tested:** a real scout pass, a daemon tick and a deploy. Unit tests cover them. [docs/cardinal-parity.md](docs/cardinal-parity.md) marks the status of every capability.

## What cstack runs, sends and stores

cstack has no server and no telemetry. It sends nothing to its author. Everything below runs on your machine, under your own accounts.

**Commands it runs**

- **`git`**: branches, commits, worktrees, rebases, and pushes to your repo's `origin` (a force push only with `--force-with-lease`, on the run's own branches).
- **`gh`**, with your own `gh` login, calling the GitHub API for the repo you point it at: read and create issues, labels, comments, pull requests and reviews; read check runs and CI logs; merge a PR (only through `gates/check-merge.mjs`, and only under `autonomy: send`).
- **Headless Claude Code sessions**: `claude -p --dangerously-skip-permissions --strict-mcp-config --plugin-dir <cstack>`, started with `systemd-run --user`. This happens only in these cases:
  - `/cstack:program` (and `/cstack:full-send` on a guideline) launches the e2e author this way by default, because the guard can only grant its suite-writing role to a session started with it;
  - `/cstack:orchestrate` and `/cstack:resume-run` launch one worker per unit when a program has more than 5 units or `parallel` above 1;
  - `/cstack:daemon` launches one worker per `cstack:ready` issue, and the optional `skills/daemon/references/cstack-daemon@.service` unit runs the daemon itself this way, but only if you install it.

  These sessions skip permission prompts, because nobody is there to answer them. cstack's hooks still apply in them (hidden suite, config lock, no direct merges, no sleep loops, no self-approved deploys). They run with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset, so they use your Claude subscription login, and with `--strict-mcp-config`, so your MCP servers are not loaded. `/cstack:unit` and the review skills never start one; they use ordinary subagents in your session.
- **`ssh`**: only `gates/deploy.mjs`, only when `.cstack/config.json` sets `deploy.transport` to `ssh`, and only after a person approves the deploy (unless the config sets `deploy.auto`). Deploys are off when `deploy` is absent. It runs your repo's committed `deploy.sh` and health command, either locally or on the host your `deploy.json` names.
- **Your repo's own commands**: the `test_command`, `setup_command` and `e2e_command` from the config, and your `deploy.sh`. cstack runs them as written; what they reach is up to them.
- **`claude plugin eval --no-publish`**: only `/cstack:eval-skill`, which you start yourself. The guard blocks any `claude plugin eval` without `--no-publish`, so eval reports are never uploaded.
- **`systemctl --user` and `journalctl --user`**: to check and read the detached sessions above.

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
