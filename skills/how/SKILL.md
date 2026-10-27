---
name: how
description: "Use when someone asks how code works (\"how does X work\", a walkthrough before a change, \"where should this live\", \"which module owns this\", \"is this the right layer\"), or when a cstack skill such as intake needs to find the files that own a behaviour. Explains subsystem architecture, runtime flow and ownership with file pointers. Read-only."
---

<!-- Adapted from pstack skills/how/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# How

Explore the codebase to answer "how does X work?" questions. Write at the level of a senior engineer who joins the subsystem. Give enough for a working mental model. Do not write annotated source code.

This skill is read-only. No spawn edits files.

## Setup

1. Read the [cstack mode skill](../cstack/SKILL.md). Put its absolute path in every brief and tell the agent to read it first.
2. Read `.cstack/config.json` with `jq`. Take `models.gather` for explorers and `models.judge` for the explainer. A role set to `inherit` means omit `model`. With no config, use `templates/config.json` and say so.
3. Read `.cstack/profile.json` if it exists. Its summaries and capabilities point at likely owners. Treat them as leads. Confirm each one in the code.
4. Choose the explorer type. Use the plugin agent `cstack-explorer` (with the plugin prefix, see the Claude Code notes in the mode skill) when the `Agent` tool lists it. Else use `Explore`.
5. The explainer uses `Explore` with the `judge` model.
6. Every brief says "do not edit files" and lists config `paths_hidden` as off limits. Run `git status --porcelain` after the spawns return. Any change is a finding. Revert nothing yourself. Report it.

## 1. Assess complexity

If the scope is ambiguous, state your reading and explore. The user can redirect.

- **Simple.** A single module, a small utility, or a narrow question such as "how does function X work". Spawn no explorers. Spawn one explainer that explores and explains in one pass. Build its brief from [the explainer prompt](references/explainer-prompt.md) without the explorer findings section. Go to step 4.
- **Complex.** A subsystem across many files or services, a cross-cutting feature, or a full architectural overview. Go to step 2.

When in doubt, take the simple path.

## 2. Explore (complex only)

Split the question into 2 to 4 angles. Each angle is a distinct slice of the subsystem. Spawn all explorers in one message. Build each brief from [the explorer prompt](references/explorer-prompt.md) with its angle filled in.

## 3. Synthesize (complex only)

When all explorers have returned, spawn one explainer. Build its brief from [the explainer prompt](references/explainer-prompt.md) with every explorer's findings filled in.

## 4. Present

Present the explainer's output. Light edits for clarity or for context from the conversation are fine. Do not rewrite it. Its claims about the code are model claims. When a caller acts on a file path, the caller checks that the path exists.

When another cstack skill called this one, return the **Where Things Live** map first. That skill needs owners, not prose.

## Output format

The explanation uses the sections in [the explainer prompt](references/explainer-prompt.md). Drop any that do not apply. The sections are Overview, Key Concepts, How It Works, Where Things Live, and Gotchas.
