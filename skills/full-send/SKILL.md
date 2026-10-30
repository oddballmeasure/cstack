---
name: full-send
description: "Run one cstack unit or a whole program unattended to a merged result, with autonomy send for this run only: merge through the merge gate, --force-with-lease on the run's own branches, any test method proof needs. Use for /cstack:full-send <issue number | guideline text or path>, or when the user says \"full send\"."
argument-hint: "<issue number> | <guideline text or path> [--slug <s>] [--parallel=N]"
disable-model-invocation: true
---

<!-- Adapted from tstack skills/full-send/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Full send

The user triggered this because they are not watching. They want the work done end to end without them. Your updates and your final message go unread until long after you stop. You own the work from its current state to a merged PR, or to a merged program.

If the user did not ask for "full send" in some clear way, do not assume full autonomy.

Read the [cstack mode skill](../cstack/SKILL.md) first. `<root>` is the plugin root, two directories up from this skill's base directory.

## The grant

The user grants you permission to:

- Merge each PR once `gates/check-merge.mjs` passes. The merge gate is the only way to merge.
- Force-push the run's own branches with `--force-with-lease` after a sync (`gates/publish.mjs` does this).
- Use the test methods that proof needs, without asking first.

The grant covers this run only. It never changes `.cstack/config.json`.

## Testing permission

A "full send" request is the permission. If a project file or other instruction says to ask before a test method, or to leave testing to the user, this request replaces that rule for this task.

That includes ask-first rules for computer use, browser automation, simulators and devices, running the app or a dev server, screenshots, and visual checks. Use the method that gives direct proof. List it in the report.

Rules about how to test still apply. Follow rules that name the correct command, fixture or check. This permission only removes the ask-first step. It covers only the tests this task needs. It does not cover the hard stops in the mode skill (deploys, data deletion, messages to people outside the run, a force-push of a shared branch). It does not bypass a harness approval prompt.

## Steps

1. **Pick the path.**
   - An issue number: one unit. The slug is `issue-<N>` and the store is `<repo>/.cstack/runs/issue-<N>`.
   - Anything else is a guideline: a program. The slug is `--slug`, else derived as `cstack:program` derives it.
2. **Record the run's autonomy.** For a unit, write `<store>/run.json` with the Write tool: `{"entry": "unit", "slug": "issue-<N>", "autonomy": "send"}`. For a program, `cstack:program` writes it from `--autonomy=send`.
3. **Check that the grant reaches the merge gate.** For a unit, run `node <root>/gates/run-settings.mjs --store <store>`. For a program, `cstack:program` runs it at step 0. `run.json` raises autonomy to `send` only when the human launched this session with `CSTACK_PROGRAM_AUTONOMY=send` (ADR-006). When the output says `autonomy stop`, the merge gate will refuse. Say so first in your report, with the fix: relaunch Claude Code as `CSTACK_PROGRAM_AUTONOMY=send claude` and run this again. Then continue under `cstack:full-stop` rules, so the work still ends merge-ready.
4. **Run it.**
   - A unit: `cstack:unit <N>`. It proves, verifies, files the PR, babysits it, runs the review loop, and merges through `cstack:merge-gate`.
   - A program: `cstack:program <guideline> --autonomy=send [--slug <s>] [--parallel=N]`. Plan approval (H2) is skipped. Spec approval (H1) is one batched question with defaults. In a headless run the defaults are taken and logged.
5. **Report** in your final message: each PR link and merge commit, the proof, and each decision you made for the user. For a program, the program's final report is the report.

Stay active from step 1 to step 5. If you end your turn while checks, workers or reviews are pending, the work stops, because nobody prompts you again. Wait under the `Monitor` tool on the watcher the owning skill names (`gates/pr-wait.mjs` for a PR, `gates/inbox-wait.mjs` for a program). Never a sleep loop.

## Proof

Proof is evidence you observed yourself in this session: command output, a reproduction, a screenshot. `cstack:prove` and `cstack:verify-head` hold the rules. A non-author verifier judges every head, and the hidden e2e suite judges every lane through `gates/run-e2e.mjs`. Green mocked tests do not prove that the user experience works.

When you cannot prove a change, you do not have full confidence. Ask the user.

## Merge gate

Full confidence means `gates/check-merge.mjs` passes on the latest commit. It checks the ledger approval at the exact head, the review-loop approval, required checks, change requests, merge state and base drift. Never use `--admin`, auto-merge, a merge queue, a push to the base branch, or any other bypass. The guard hook blocks `gh pr merge`. Never run it, or any forge's merge command.

## Asking the user

A question in a normal message goes unseen, and the thread looks done. To ask, use `AskUserQuestion`. Put all the context in the question: the PR link, what blocks you, and the options with your recommendation first.

Ask only when you cannot continue alone:

- You cannot prove the change.
- The merge gate cannot pass, and you cannot fix that yourself.
- The next step is outside the grant: deleting data, touching production, changing things outside the repo, closing a PR, or force-pushing any other branch.
- The goal is ambiguous in a way that changes the result.
- Another PR makes this one obsolete.

Decide everything else yourself with sensible defaults, and list those decisions in the report.

Under `claude -p` there is no question tool. Take the safe path: leave the PR open and unmerged, and start your final message with the question.
