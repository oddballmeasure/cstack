---
name: leaving-pr-comments
description: "Use whenever you write a GitHub comment on the human's behalf: a reply to a reviewer or bot, an inline review comment, a top-level PR comment, or the explanation posted before resolving or dismissing a thread. cstack:babysit-pr uses it for every reply. Sets the callout header, the direct style, the secret check and the cstack footer, and the rules for posting and resolving."
---

<!-- Adapted from tstack skills/leaving-pr-comments/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# Leaving PR comments

`<root>` is the plugin root, two directories up from this skill's base directory.

## Format

Every agent-authored comment left on the human's behalf has three parts, in this order:

```md
> [!NOTE]
> 🤖 **<model> responding on behalf of <user>**

The actual comment starts here.

<the footer line from <root>/templates/footer.md>
```

- `<model>` is the verified public name of the model that wrote the comment, for example `Claude Opus 5.5`. If the session does not expose a model name, use `Claude Code`. Do not guess.
- `<user>` is the human's name or GitHub login. Online, read the login with `node <root>/gates/forge.mjs user`. Otherwise use the name the human gave. Never invent one.
- Keep the attribution inside the note and the reply outside it. The context line starts with the robot emoji. Leave one blank line after the callout.
- The last line is the footer line from `<root>/templates/footer.md`, copied exactly, after one blank line.
- Add no horizontal rule, Setext underline, heading, signature, or second attribution.

## Where it applies

Apply it to top-level PR comments, inline review comments, replies to bots or reviewers, and written explanations used before resolving or dismissing feedback.

Do not apply it to PR descriptions, commit messages, issue bodies, or text the human asked to post verbatim without attribution. `cstack:settle` outcome comments keep their fixed first line, so they get the footer but no callout.

## Style

- Lead with the conclusion.
- Cite the relevant code, behaviour, check, or reproduction: `path:line`, a test name, a command and its output.
- Keep it concise. No filler, canned thanks, or status narration.
- Distinguish verified facts from judgment.
- Apply `cstack:unslop`.

## Before you post

1. Check the whole comment, quoted text and attachments included, for secrets and private details: tokens, keys, passwords, private hostnames, internal URLs, emails, customer data. Remove or redact them. A secret in a quoted log counts.
2. Preview the final Markdown so quoting and blank lines render as shown.
3. When you must not touch GitHub (offline, a draft, review only), stop here and give the final Markdown in the reply. Post nothing. If the comment holds a code fence, wrap the draft in a `~~~` fence so both render. Never insert invisible characters.

## Posting

- Post with `node <root>/gates/forge.mjs change comment <pr> --body-file <file>`, or on a review thread with `node <root>/gates/forge.mjs thread reply <pr> <thread id> --body-file <file>`. Write the body to a file first, so quoting survives.
- After posting, confirm the forge returned the comment or review URL.
- Resolve a review thread (`node <root>/gates/forge.mjs thread resolve <pr> <thread id>`) only after its reply posted successfully.
