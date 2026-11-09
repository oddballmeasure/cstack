---
name: takeover
description: "Use when the human asks to take over a PR, a branch, or another agent's unfinished thread, or asks for a \"takeover\". Finishes the original goal on a cstack branch that keeps the original commits and contributor credit, refreshes it with cstack:modernize, proves it with cstack:prove and cstack:verify-head, then files and babysits the PR. Merges only through cstack:merge-gate."
argument-hint: "<pr-number | branch | transcript or run path>"
---

<!-- Adapted from tstack skills/takeover/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Takeover

Take responsibility for finishing the original goal. Keep the original contributors' credit. Do not defend an implementation only because another agent already built it.

Read the [cstack mode skill](../cstack/SKILL.md) first. `<root>` is the plugin root, two directories up from this skill's base directory. Read `repo`, `base_branch`, `label_prefix` and `limits` from `.cstack/config.json` with `jq`. Without a config, use `<root>/templates/config.json` and say so.

If the work is a cstack run whose coordinator died or paused, this is the wrong skill. Use `cstack:resume-run`.

## 1. Inherit

Read the source in full:

- **A PR.** `node <root>/gates/forge.mjs change view <n> --json` (url, state, author, base, branch, head, headRepo, commits, body), its reviews (`node <root>/gates/forge.mjs reviews <n> --json`), its review threads (`node <root>/gates/forge.mjs threads <n> --json`), the checks on its head (`node <root>/gates/forge.mjs checks <head>`), and the full diff.
- **A branch.** `git log` and the diff against its merge base with the base branch.
- **An agent thread.** Its transcript under `~/.claude/projects/<slug>/`, or its run store under `.cstack/runs/<slug>/`. Read the human's later corrections too.

Resolve the handoff to real code at a real head SHA. Check `git worktree list` and `git status` in each related worktree for uncommitted work. That work belongs to its owner. Do not discard it. Treat the handoff as context, not proof. Every claim in it is a model claim until you observe it (rule 1).

If the linked issue carries `<label_prefix>:in-progress`, a run may still hold it. Check that run's store and worker before you start. Do not take over a live run's work without the human's say.

## 2. Branch and credit

Make a replacement branch unless the human asked for an in-place or stacked continuation. Do not overwrite unrelated work. Do not push to, retitle, comment on or close the original PR without authorization.

Fetch the original head. For a PR, take `branch`, `head` and `headRepo` from `forge.mjs change view <n> --json` in step 1. `headRepo` is the PR's source repo, `owner/name` on GitHub. When it equals config `repo` (`jq -r .repo <repo>/.cstack/config.json`), fetch the branch:

```bash
git -C <repo> fetch origin <branch of the PR>:refs/remotes/origin/takeover-<n>
```

When it differs or is null, the PR comes from a fork: fetch the forge's change ref instead, `pull/<n>/head` on GitHub, `merge-requests/<n>/head` on GitLab. Either way, confirm `git -C <repo> rev-parse origin/takeover-<n>` equals `head`.

A branch source has no PR record: run `git -C <repo> fetch origin <branch>`, take `head` from `git -C <repo> rev-parse origin/<branch>`, and isolate with `--base origin/<branch>` instead of the PR ref below.

Then isolate:

```bash
node <root>/gates/isolate.mjs <repo> <branch> <worktree> --base origin/takeover-<n>
```

Name the branch `cstack/<N>-<slug>` when an issue `N` exists (`docs/unit-flow.md`), else `cstack/takeover-<n>`. The branch starts at the original head, so it keeps the original commits, authors and `Co-authored-by` trailers. Add your fixes as separate commits on top.

Register the branch in a run store, so the ledger and the publish gate know it. Inside a unit, the unit's store and id already exist: run only `unit set <unit> --branch <branch>`. Outside a run, the store is `<repo>/.cstack/runs/takeover-<n>/` and the unit id is `takeover-<n>`:

```bash
node <root>/gates/orch.mjs --store <store> init
node <root>/gates/orch.mjs --store <store> unit add takeover-<n> --track takeover
node <root>/gates/orch.mjs --store <store> unit set takeover-<n> --branch <branch>
```

The original commits carry no cstack trailers. Every commit gate the coordinator runs on this branch passes `--inherited <sha>`, so the trailer rule checks only commits after the original head. The diff, path and test checks still cover the whole branch. The gate rejects a value that is not a full SHA strictly behind HEAD, and then exempts nothing.

Take `<sha>` only from the forge: `head` from `forge.mjs change view <n> --json` (for a branch source, `git -C <repo> rev-parse origin/<branch>` at fetch time). On every resume, take it from the forge again, and for a branch source confirm it still equals `origin/<branch>` on the remote; if it moved, settle `needs-human`. Never take it from a file in the store or the worktree, or from a worker's report: a worker can write both. A worker that runs `check-commit.mjs` itself decides nothing. Only the coordinator's run counts.

A rebase by `cstack:modernize` replaces the original commits. Before the next commit gate, the coordinator checks that the rebased branch starts with a copy of every original commit, in order, by patch id. It computes this itself, in bash:

```bash
orig=$(git -C <worktree> rev-list --reverse <forge base>..<forge head>)
new=$(git -C <worktree> rev-list --reverse origin/<base>..HEAD | head -n "$(echo "$orig" | wc -l)")
pid() { git -C <worktree> show "$1" | git patch-id --stable | cut -d' ' -f1; }
paste <(for c in $orig; do pid "$c"; done) <(for c in $new; do pid "$c"; done) | awk 'NF<2 || $1!=$2 {bad=1} END {exit bad || NR==0}' \
  && echo "$new" | tail -n1
```

`<forge base>` is the merge base of the forge head and the old base. It prints the rebased copy of the original head: pass it as `--inherited`. If any original commit has an empty patch id (a merge commit), or any pair differs (the rebase changed a patch, for example while resolving a conflict), stop and settle `needs-human` with `git range-diff`. Never match the head alone: a worker commit that repeats the head's diff would then exempt everything beneath it.

Credit the original contributors in the PR body and link the original PR. Use identities you verified from `git log --format='%an <%ae>'` or the forge's change record. Do not guess an email. If the repo squash-merges, check that the squash message keeps a `Co-authored-by:` line for each human contributor. A model attribution line does not replace contributor credit.

## 3. Modernize and finish

Run `cstack:modernize` on the new branch against its intended base. Here a REWORK disposition is in scope, because finishing the goal is the job. A CLOSE disposition ends the takeover. Report it with the evidence.

Rework only what the original goal needs. Do not add unrelated features. Simplify without dropping intended behaviour or surfaces. Before you file, check the source PR again. It may have moved while you worked.

## 4. Verify

- Reproduce the original failure, then show the same reproduction passing, with `cstack:prove`.
- Exercise the realistic user workflows, per the repo's guidance and permissions. Green mocked tests do not prove the user experience.
- Get a non-author verdict at the exact head with `cstack:verify-head`, with the store and unit id from step 2. You wrote the fixes, so you cannot approve them (rule 3). Its gate records the ledger row.
- Run `cstack:review-loop` on the diff.

State what stays unverified.

## 5. File, babysit, merge

When the requested finish includes a PR:

1. Publish the verified head: `node <root>/gates/publish.mjs <worktree> --store <store> --unit <unit>`. It refuses to push unless the ledger approves that head. A `ledger` finding: run step 4 again.
2. File it with `cstack:file-pr`. Give it the issue (or, with no issue, the original PR number), branch, worktree, verified SHA and the run store from step 2. The body adds a credit line after the fix paragraph: `Takes over #<n> by @<login>.`
3. Drive it to green with `cstack:babysit-pr`. Do not stop at creation.
4. Write every reply with `cstack:leaving-pr-comments`.
5. Merge only through `cstack:merge-gate`, under the run's effective autonomy.

Inside a unit, the unit flow owns the `<label_prefix>:*` state labels. Outside one, move the issue to `<label_prefix>:in-progress` while you work and settle it at the end. Keep one state label at a time.

Close the original PR only when the human authorizes it. When you do, post a comment that links the replacement, written with `cstack:leaving-pr-comments`.

## Report

What you inherited, what you changed, how you verified it (with evidence paths), how credit was kept, and every open decision.
