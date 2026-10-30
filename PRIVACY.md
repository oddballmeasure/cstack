# Privacy

cstack is a Claude Code plugin made of skills, subagents, hooks and small Node scripts. It has no servers, collects no data, and has no telemetry or analytics. Its author receives nothing from your use of it.

## What stays on your machine

- `.cstack/config.json` in your repo, which you review and commit.
- `.cstack/runs/` in your repo, gitignored: run plans, briefs, the decision log, verification records, worker logs and the inbox.
- Git worktrees under `~/.local/state/cstack/worktrees/` and PR-watcher state under `~/.local/state/cstack/pr-wait/`.

You can delete any of these at any time.

## What leaves your machine, through your own accounts

- **GitHub or GitLab**, whichever the repo's `forge` config names, through your logged-in `gh` or `glab` and `git` (plain git sends only what you push to your own remote): the branches, commits, pull requests, issues, comments and labels cstack creates on the repo you point it at. GitHub's privacy terms apply.
- **Anthropic**, through your own Claude Code login: the prompts, code and tool output of the Claude Code sessions and subagents cstack runs, as with any Claude Code session. Anthropic's privacy terms apply.
- **Your deploy host**, only if you configure `deploy` with `ssh` transport: your committed `deploy.sh` and health command run there over `ssh`.

cstack's own scripts make no other network requests. `claude plugin eval` always runs with `--no-publish`, so eval reports are not uploaded.

## Contact

Questions: [GitHub Issues](https://github.com/oddballmeasure/cstack/issues). Security reports: see [SECURITY.md](SECURITY.md).
