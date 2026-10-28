---
name: council
description: "Use when a change or a design needs three independent opinions with scores: the final review of a cstack program, a contested design, or a human asking for a \"council\" or \"three reviewers\". Three read-only reviewers on three different Claude models each score the work out of 10 per round. You synthesize findings and disagreements, fight scope, and put a Council review table in the PR body."
argument-hint: "[<pr-number> | <path> | <question>]"
---

<!-- Adapted from tstack skills/council/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Council

Bring in three delegates for review or feedback. Each one runs on a different Claude model in fresh context. Model diversity is the signal. Their agreement is strong evidence. Their disagreement is a finding.

Read the [cstack mode skill](../cstack/SKILL.md) first. `<root>` is the plugin root, two directories up from this skill's base directory.

## Members

- Default members: `fable`, `opus`, `sonnet`. If the human names members, use those.
- The three must be three different models. If a named member is unavailable or the `Agent` tool rejects its model, report it. Do not substitute silently. Run with the members you have only if the human agrees, or under `claude -p`, where you say so first in the reply.
- Each member is the plugin's `cstack-reviewer` agent with `model` set to that member. Claude Code lists the agent with the plugin prefix. For a design question with no diff, use `subagent_type: "Explore"` and say "do not edit files" in the brief.

## 1. Frame

State the request in 1 or 2 sentences: what the council reviews, the intent, and what is out of scope. Gather the context the members need as file paths, the diff command, or the pasted text. Do not paste bulk that a member can read itself.

## 2. Convene

Spawn all three members in one message with the `Agent` tool. Each gets the same brief:

```
GOAL: Review or advise only. Do not edit, commit, push, comment on PRs, or start subagents.
CONTEXT: Read <root>/skills/cstack/SKILL.md first. <request, intent, out of scope, paths or diff>.
ACCEPTANCE: Find real problems first: bugs, broken callers, mismatch with the intent, design risks.
  Hold to the smallest change. Name extras as extras.
FORBIDDEN: <paths_hidden>, <paths_off_limits>, any write, any GitHub call.
REPORT: SCORE: <n>/10 for the work as it stands (code review only).
  Then findings as F1 [blocker|should|nit] <file>:<line or section> <claim>. Fix: <suggestion>.
  Then a one-line recommendation.
```

Wait for the three notifications. Do not poll.

## 3. Synthesize

You are the lead, not a vote counter.

- Merge findings that describe the same issue. Note which members raised each one.
- A finding two or more members raised on their own is high signal. Read a lone finding, and weight it.
- Check every finding against the code yourself before you act on it.
- Where members disagree, say so and say which side the code supports.
- Recommend next steps.

## 4. Rounds and scores

For a code review, every member scores out of 10. One full pass of all three is one round. A fresh review after fixes starts a new round with fresh agents.

If you agree with the recommendations, make the changes (inside a unit, through `cstack:repair` with source `review`), then convene a new round. Continue until all three members are satisfied, or until `limits.review_rounds` rounds are spent. Budget end is not approval.

## 5. Fight scope

Repeated reviews grow a change one cheap fix at a time. It is your job to keep scope at what the request needs.

- Act on real bugs in the intended case.
- Decline extras with a one-line reason: new options, guards for cases that do not happen, refactors nearby, extra tests the intent does not need.
- List each declined extra as a follow-up. In a cstack run, file it as a `<label_prefix>:proposed` issue.

## 6. Record

If the work ends in a PR, put the results in the PR description, directly above the `Created with <model> in cstack.` line:

```markdown
## Council review

Rounds: 2

| Delegate | Round 1 | Round 2 |
| --- | --- | --- |
| Claude Fable | 7/10 | 9/10 |
| Claude Opus | 8/10 | 10/10 |
| Claude Sonnet | 7/10 | 9/10 |
```

- One column per round, one row per member, named by its model.
- If a member gave no score, write `no score`. Never invent one.
- If the PR is open, edit the description with `gh pr edit <n> --body-file <file>`. Do not post a comment for this.
- With no PR, or when you must not touch GitHub, put the same section in the reply only, as rendered Markdown at the top of the reply. Do not wrap it in a code fence.

## Reply

The table, then the useful findings with who raised them, the disagreements, what you changed and declined with reasons, the follow-ups, and the next step.
