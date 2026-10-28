---
name: interrogate
description: "Adversarial multi-model code review. Use this skill whenever the user asks to tear apart, stress-test, challenge, grill, poke holes in, find blind spots in, or adversarially review code, a diff or a branch (\"interrogate\", \"tear this apart\", \"multi-model review\"), including a pasted snippet with no repo, offline. Do not answer such a request with a single-pass review of your own. This skill sends the code to reviewers on different Claude models in parallel, then gives one lead verdict in four buckets (act on, consider, noted, dismissed) with an agreement map. It changes no files."
argument-hint: "[<pr-number> | <path> | <diff>]"
---

<!-- Adapted from pstack skills/interrogate/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# Interrogate

Spawn one reviewer per model to review a change adversarially. The adversarial signal comes from model diversity, not from assigned personas. The deliverable is a synthesized verdict. Do not apply changes.

Read the [cstack mode skill](../cstack/SKILL.md) first. `<root>` is the plugin root, two directories up from this skill's base directory. Read config `models` with `jq` from `<repo>/.cstack/config.json`. Without a config, use `<root>/templates/config.json` and say so.

## Step 1, Scope

Find what to review from context:

- If the human points at files, a diff, or pasted code, use that.
- On a feature branch, use `git diff <base>...HEAD` for the full change.
- If the message refers to recent work, gather the relevant files.

Package the diff or file contents with the surrounding files the reviewers need.

## Step 2, Intent

Before you spawn reviewers, state the intent in one clear paragraph. Take it from the human's message, the commit messages, the PR description, and the code. If the intent is unclear and the human is present, ask. Under `claude -p`, state your best reading and mark it as a guess.

## Step 3, Spawn reviewers

Launch all reviewers in one message with the `Agent` tool. Each one is the plugin's `cstack-reviewer` agent, read-only. Label them Reviewer A, B, and so on.

| Reviewer | Model |
|----------|-------|
| Reviewer A | config `models.review` |
| Reviewer B | config `models.judge` |

- Every reviewer runs on a different model. If two roles name the same model, give the second reviewer the first of `fable`, `opus`, `sonnet` not in use yet, and say so.
- Prefer models that did not write the change. If a reviewer's model is the author's model, swap it the same way and say so.
- A role set to `inherit` means omit `model`. Count it as the session model.
- If the human names models or asks for more reviewers, use those.
- If the `Agent` tool rejects a model, run that reviewer on the next free model from the list above and say so. Do not block the review on it.

Read [the reviewer prompt](references/reviewer-prompt.md). Fill in the same template for every reviewer with the stated intent, the diff or file contents, [the rubric](references/rubric.md), and [the code-quality lens](references/code-quality-review.md). Add a FORBIDDEN line: any edit, any GitHub call, config `paths_hidden` and `paths_off_limits`.

## Step 4, Synthesize

As results come back, build one picture. Parse every reviewer's findings. Merge findings that describe the same issue differently, and note which models raised each one. Findings that two or more models raised on their own are the highest signal. Read a lone model's finding, and weight it. Note disagreements. If one model flags something and another says the opposite, that is context for the verdict.

## Step 5, Lead judgment

You are the lead reviewer, a pragmatic senior engineer, not a neutral aggregator. Read [the lead judgment framework](references/lead-judgment.md). Put every finding in one of four buckets, with the models that raised it and a one-line rationale. Trace the code yourself before you bucket a finding.

- **Act on.** Real issues that affect correctness, security, or maintainability given the actual goals. They would block a real PR.
- **Consider.** Legitimate, but you are not sure they outweigh the cost of fixing them now. Worth the human's attention.
- **Noted.** Technically valid but not actionable. Context-dependent, premature optimization, or low impact at this stage.
- **Dismissed.** Wrong, nitpicky, or missing context, with a brief reason.

If every finding is a nit, say the code is probably fine.

## Output format

### Intent
> The stated intent paragraph from Step 2.

### Reviewers
- Reviewer A: model name, N findings (one bullet per reviewer)

### Act on
Each: description, which models raised it, why it matters.

### Consider
Each: description, which models raised it, the tradeoff.

### Noted
Brief list.

### Dismissed
Each with a brief rationale.

### Agreement map
Where the models agreed and diverged, and what that pattern says.
