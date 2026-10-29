---
name: reflect
description: "Mine the current session for durable learnings and route each one to a concrete skill edit. Three read-only reviewers read the transcript in parallel (judgment, tooling, divergent), a synthesizer sorts their findings into Accepted, Rejected and Backlog, and nothing changes until the human approves. Use for /cstack:reflect, or when the human says reflect."
disable-model-invocation: true
---

<!-- Adapted from pstack skills/reflect/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# Reflect

Mine this conversation for durable learnings. Then route them into skill edits.

Read the [cstack mode skill](../cstack/SKILL.md) first. `<root>` is the plugin root, two directories up from this skill's base directory. Read config `models` and `label_prefix` with `jq` from `<repo>/.cstack/config.json`. Without a config, use `<root>/templates/config.json` and say so.

Skip reflect when the session is trivial, off-topic, or a skill already covered it and the session followed that skill correctly. A one-off is not a learning.

## 1. Find the active transcript

Transcripts are in `~/.claude/projects/<slug>/`. The slug is the session's primary working directory with each `/` and `.` changed to `-`. Look only in this one directory. Do not glob across `~/.claude/projects/*/`. That reads private sessions from unrelated projects.

```bash
dir=~/.claude/projects/<slug>
ls -t "$dir"/*.jsonl | head -5
grep -l -F "<first words of this session's opening prompt>" "$dir"/*.jsonl
```

The match is this session. Its subagent transcripts are in `$dir/<session>/subagents/`. If nothing matches, write a tight digest of the session instead and pass that.

## 2. Spawn three reviewers in parallel

Spawn all three in one message with the `Agent` tool, `subagent_type: "Explore"`. They are read-only. Explore keeps `Bash`, so they can run `gh` to look up the issues and PRs the transcript cites. Each brief says "do not edit files". Run `git status` afterward.

| Lens | Config role | Prompt template |
|---|---|---|
| Judgment | `judge` | [judgment-reviewer](references/judgment-reviewer.md) |
| Tooling | `review` | [tooling-reviewer](references/tooling-reviewer.md) |
| Divergent | `judge` | [divergent-reviewer](references/divergent-reviewer.md) |

Set `model` from the role. A role set to `inherit` means omit `model`. Tooling runs on `review`, not `gather`, for two reasons. It needs judgment to tell a durable fact from drift, and a second model family catches what the `judge` model misses.

Pass each template as written, below its attribution line. Fill in the placeholders: the mode skill's absolute path, and the transcript path or the digest. Each reviewer returns its findings in its reply.

## 3. Synthesize

Spawn one `Explore` agent with `model` from the `judge` role. Pass [the synthesizer template](references/synthesizer.md), with each reviewer's full reply inlined where marked. It spot-checks citations and returns Accepted, Rejected and Backlog lists.

You own its output (mode skill, Subagents). Read each Accepted row's target skill yourself before you present it.

## 4. Structural check

Apply [Encode Lessons in Structure](../cstack/references/principles/encode-lessons-in-structure.md). Move each Accepted row to Backlog when a lint, hook, gate script, frontmatter key or runtime check would enforce it better than prose. When the fix is structural, use only the structural fix.

## 5. Approve, then apply

Show the full Accepted, Rejected and Backlog output. Then ask with `AskUserQuestion` which Accepted rows to apply and which Backlog items to file. The human picks the subset and may redirect a routing. Skill edits change every future session, so do not auto-apply. Under `claude -p` there is no `AskUserQuestion`. List the rows, apply nothing, and put the question first in the final message.

Where an edit goes:

- Never edit a skill under `~/.claude/plugins/cache/`. The next plugin update overwrites it.
- A project skill (`.claude/skills/<skill>/`) or user skill (`~/.claude/skills/<skill>/`). Edit it in place.
- A cstack skill, in a session that has the cstack source checked out. Edit it on a branch, run `node <root>/tests/lint/lint.mjs` and `claude plugin validate <root>`, and stop before you commit or push.
- A cstack skill with no source checkout. File it as a Backlog issue on the cstack repo. Or, if the human wants it now, copy the skill folder to `.claude/skills/<skill>/` and edit the copy. Say that the copy loads as `<skill>`, not `cstack:<skill>`.

Follow each approved row's routing:

- Trivial edit (one bullet, a tightened sentence, a stale fact). Make it directly.
- Substantive edit (a new section, a new table, more than about 10 lines), `tune description: <path>`, or `new skill: <name>`. Use the `skill-creator` skill if the session has it, and run its draft and test loop. Without it, write the edit directly and run `claude plugin validate` on the plugin or skill directory.

File each approved Backlog item as an issue on the repo that owns the target, labelled `<label_prefix>:proposed`. End the body with the line in [the footer template](../../templates/footer.md). Never open a PR or push.

## 6. Report

A short list, no preamble:

- Edits applied: `<skill path>`, what changed, one line each.
- New skills: `<skill path>`, one line each.
- Backlog filed: `<issue url>` `<title>`, one line each.
- Not applied: each row the human declined.
- Dropped: one line per rejected finding with the synthesizer's reason.
