---
name: file-pr
description: "Use when a cstack unit has a published, verified branch and needs its pull request (unit stage 9). Opens one real PR for the branch, or reuses the open one, with a body that starts `Closes #N`, names the proof, and ends with the cstack footer."
---

<!-- Adapted from tstack skills/file-pr/SKILL.md @ 92e38e2 (MIT, Theo Browne). -->

# File PR

This is stage 9 of the unit flow (`docs/unit-flow.md`). `cstack:unit` calls it after `gates/publish.mjs` passed. The gate for this stage: an open PR exists for the branch, its head is the verified SHA, and its body starts `Closes #N`.

`<root>` is the plugin root, two directories up from this skill's base directory. Take `repo`, `base_branch` and `label_prefix` from `.cstack/config.json` with `jq`.

## Inputs

- Issue number `N`, unit id, branch, worktree path, run store path.
- The verified head SHA (the ledger row that `orch ledger check` accepts).
- The proof: what the verifier and the gates observed. See **Proof line**.

## 1. Reuse an open PR

Look for an open PR from this branch into the base before you write anything:

```bash
node <root>/gates/forge.mjs change find --head <branch> --base <base_branch> --state open --json
```

Each PR record has `id`, `url`, `head` (the head SHA), `draft` and `body`.

- One PR found. Reuse it. Do not open a second one. If its body does not start `Closes #N`, rewrite the body (step 3) and update it with `node <root>/gates/forge.mjs change edit <n> --body-file <file>`.
- The reused PR is a draft (`draft` is true). Mark it ready with `node <root>/gates/forge.mjs change ready <n>`. cstack never leaves a PR in draft, because review bots skip drafts. On a forge without drafts, `draft` is always false.
- A PR from the same branch into another base is not this unit's PR. Do not reuse it and do not touch it.

## 2. Check the diff

Read `git -C <worktree> diff origin/<base_branch>...HEAD --stat` and the full diff. Confirm the contents match the issue. A file that has nothing to do with the issue is a finding. Stop and report it to `cstack:unit`. Do not fix code here.

## 3. Write the title and body

**Title.** PR titles usually become merge commit messages. Follow the repo's conventions. Read recent merged titles with `node <root>/gates/forge.mjs changes merged --limit 10`. Say why the change matters, not how it works.

- Bad: `perf(server): negotiate permessage-deflate on the websocket`
- Good: `perf(server): cut websocket frame size by 70%+ with gzipping`

**Body.** Write it to `<store>/pr-body-<unit>.md`. Use this order:

```
Closes #<N>

<The problem, in the issue's own words. Quote or closely paraphrase the issue. One short paragraph.>

<The fix, in two or three sentences. What changes for the user.>

Proof: <the evidence, see below>

Created with <model> in cstack.

<the footer line from <root>/templates/footer.md>
```

- The first line is exactly `Closes #<N>`. Nothing comes before it.
- Lead with the problem, not an inventory of changed functions.
  - Bad: "Removed implicit workspace carry-over from every new-thread entry point. Deleted buildContextualThreadOptions and the seed-context machinery."
  - Good: "My new-worktree default was ignored when starting new threads on existing worktrees. Now your preferences always apply."
- Apply `cstack:technical-writing` and `cstack:unslop` to the body.

**Proof line.** One line. Name the evidence, do not describe it. Use what the gates observed in this session: the approved verdict and its SHA, the `check-commit` test run, a reproduction or screenshot. For example: `Proof: verifier approved a1b2c3d4e5f6 (R1, R2 delivered); test_command green at that tree; reproduced the empty-list crash before the fix and not after.` Never claim proof you did not observe.

**Attribution line.** `Created with <model> in cstack.` Use the model name the harness reports for this session. Add each subagent model that wrote part of the change, from config `models.code`, for example `Created with Claude Opus 5.5 and opus (implementer) in cstack.` When the model identity is unknown, write `Created in cstack.` Do not guess a model.

**Footer.** The last line of the body is the badge line from `<root>/templates/footer.md`, copied exactly.

**Secrets.** Before you submit, read the title and body for tokens, keys, private hostnames, emails and internal links. Remove them.

## 4. Open the PR

Open a real PR. `change create` never opens a draft.

```bash
node <root>/gates/forge.mjs change create --head <branch> --base <base_branch> --title "<title>" --body-file <store>/pr-body-<unit>.md --json
```

It prints `{ok, id, url, via}`. On GitHub it uses GraphQL first. When GraphQL is rate limited, it makes one REST attempt itself, which has its own limit, and `via` says `rest`. Do not retry `change create` in a loop.

## 5. Gate

Confirm the result. `change find` reads through REST on GitHub, so the check works when GraphQL is exhausted:

```bash
node <root>/gates/forge.mjs change find --head <branch> --base <base_branch> --state open --json
```

Pass only when exactly one PR comes back, `draft` is false, `head` equals the verified SHA, and `body` starts with `Closes #<N>`. Then record it:

```bash
node <root>/gates/orch.mjs --store <store> unit set <unit> --pr <number> --state pr-open
```

On any other result, the stage fails with kind `github`. Return to `cstack:unit` with the forge.mjs output.

## Rules

- Do not post a follow-up PR comment. The body carries everything.
- Do not request reviewers, add labels or enable auto-merge here.
- Babysitting is the next stage, `cstack:babysit-pr`. Only the unit coordinator runs it.
