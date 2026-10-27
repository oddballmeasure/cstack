---
name: settle
description: "Use when a cstack unit claims its issue (unit stage 1) or reaches an outcome (stage 12, or any failure): sets the single state label and posts the outcome comment once, through gates/settle.mjs. Holds the fixed comment prefixes and the failure inbox entry."
---

# Settle

Settle is the only way cstack changes an issue's state label or posts an outcome comment. It follows `docs/unit-flow.md` (stage 1, stage 12, failure kinds and outcomes).

`<root>` is the plugin root, two directories up from this skill's base directory. Read `label_prefix` from `.cstack/config.json` with `jq`.

## The gate

```bash
node <root>/gates/settle.mjs <N> --state <state> [--comment-file <file>] --repo-dir <repo root> --json
```

- It sets one state label, `<label_prefix>:<state>`, and removes the other state labels.
- It posts the comment unless the issue already has a comment with the same first line. So the first line must be stable for one outcome. Rerunning settle is safe.
- Exit 1 means `gh` failed. That is failure kind `github`.

## Claim (stage 1)

```bash
node <root>/gates/settle.mjs <N> --state in-progress --repo-dir <repo root>
```

No comment. Then `node <root>/gates/orch.mjs --store <store> unit set <unit> --state in-progress`.

## Outcomes (stage 12 and failures)

Write the comment to `<store>/comment-<unit>-<outcome>.md`. The first line starts with the fixed prefix. The last line is the badge line from `<root>/templates/footer.md`, copied exactly.

| Outcome | `--state` | First line starts with | Unit state (`orch unit set --state`) |
|---|---|---|---|
| merged | `done` | `cstack resolved this in` | `merged` |
| merge-ready (autonomy stop) | `in-progress` (unchanged) | `cstack: ready to merge` | `pr-open` (unchanged) |
| needs a decision | `needs-human` | `cstack needs a decision before continuing` | `needs-human` |
| not taken | `needs-human` | `cstack is not taking this issue:` | `needs-human` |
| failed | `error` | `cstack stopped at` | `error` |

### Comment bodies

**merged**

```
cstack resolved this in #<pr> (merge <merge sha12>).

Proof: <the proof line from the PR body>

<footer>
```

**merge-ready**

```
cstack: ready to merge #<pr> at <head sha12>.

Verdict: Ready to merge | Waiting for required approval
Proof: <the proof line from the PR body>

<footer>
```

**needs a decision**

```
cstack needs a decision before continuing:

> <the question, one paragraph>

Options: <option A (recommended)>; <option B>.
Answer on this issue, then run `/cstack:unit <N>` to resume.

<footer>
```

**not taken**

```
cstack is not taking this issue: <the reason, one line>

<footer>
```

**failed**

```
cstack stopped at <stage> (<kind>): <one line>

<footer>
```

- `<stage>` is the stage name from the unit flow, such as `Verify` or `Babysit`.
- `<kind>` is one of: `invalid_output`, `tests_failed`, `no_change`, `verification`, `ci_failed`, `ci_timeout`, `base_conflict`, `pr_violation`, `git`, `github`, `setup`, `usage_limit`, `crash`.
- `<one line>` says what failed, at most 200 characters. For `crash` and `usage_limit`, write only `details are in the run store`. Stack traces and provider errors stay private.
- Never put secrets, tokens or local home paths in a comment.

## Failure extras

On a failed outcome, also:

1. Write `<kind>: <one line>` to `<store>/failure-<unit>.txt`.
2. Push the inbox entry:

   ```bash
   node <root>/gates/orch.mjs --store <store> inbox push unit <unit> error --report <store>/failure-<unit>.txt
   ```

3. Keep the worktree. Do not remove it. A human or a resume inspects it.

## Log

Write one row in `<store>/decisions.tsv` (`cstack:show-me-your-work`) with the outcome, the label set, and the comment file as evidence.
