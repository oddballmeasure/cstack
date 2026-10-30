---
name: intake
description: "Use when a cstack unit reaches intake (stage 4) for a GitHub issue. Decides whether cstack takes the issue (feature, bug, chore, question, reject, needs_human) and, if so, splits it into 1 to 4 tickets in dependency order, each requirement covered exactly once, with target files taken from the repo profile. Writes <store>/intake-<unit>.json that must pass gates/check-intake.mjs."
---

# Intake

Intake turns one issue into one intake decision. It follows Cardinal's orchestrator (oddballmeasure/cardinal, `skills/orchestrator/SKILL.md` and `roles/orchestrator.py`). The format is the header of `gates/check-intake.mjs`. The example is `templates/intake.json`. The routing is in `docs/unit-flow.md`, stage 4.

Intake is read-only for the repo. It writes only into the run store.

## Inputs

- `<N>`: the issue number.
- `<repo>`: the repo root, absolute. Use the main checkout, not a unit worktree.
- `<store>`: the run store, `<repo>/.cstack/runs/<slug>/`, absolute.
- `<root>`: the plugin root, two directories up from this skill's base directory.

## Procedure

1. Read the [cstack mode skill](../cstack/SKILL.md). Read config `paths_hidden` and `label_prefix` with `jq`.
2. Fetch the issue and save it:
   ```sh
   node <root>/gates/forge.mjs issue view <N> --json >"<store>/issue.json"
   ```
3. Find a human answer. It is every comment after the latest cstack question comment, minus cstack's own comments:
   ```sh
   jq '(.comments | map(.body | startswith("cstack needs a decision before continuing") or startswith("cstack is not taking this issue:")) | rindex(true)) as $i
     | if $i == null then [] else .comments[$i+1:] | map(select(.body | contains("Made with [cstack]") | not)) | map({author, body}) end' "<store>/issue.json"
   ```
   A non-empty result is the human answer. It resolves the question cstack asked. Plan with it. Do not ask the same question again. If the answer is still not enough, ask a narrower question.
4. Make sure the profile is current. Run `node <root>/gates/profile-diff.mjs <repo> --json`. If `approved` is false, run `cstack:profile-repo` first. Then read `<repo>/.cstack/profile.json`.
5. Classify the issue (see **Classify**). For `question`, `reject` and `needs_human`, go to step 8.
6. List the requirements (see **Requirements**).
7. Find the owners of each requirement before you choose any target file (see **Find owners**). Then write the tickets (see **Tickets**).
8. Write `<store>/intake-<unit>.json`. Check that `issue` equals `<N>`: `jq -e '.issue == <N>' <store>/intake-<unit>.json`.
9. Run the gate:
   ```sh
   node <root>/gates/check-intake.mjs <store>/intake-<unit>.json --repo <repo> --json
   ```
   On rejection, fix the decision using the gate's `findings`. Then run the gate once more. A second rejection is failure `invalid_output`. Do not try a third time.
10. Log the result with `cstack:show-me-your-work`: one row for the decision, and one row for each failed gate run.

For `question`, `reject` and `needs_human`, the caller settles `needs-human` through `cstack:settle`. Settle writes the comment from `question` or `summary`, so write those for a person to read.

## Classify

- `feature`, `bug`, `chore`: workable. The issue states an observable outcome you can plan.
- `question`: the issue asks for information, not a change.
- `reject`: out of scope for this repository, a duplicate, or harmful. `summary` is the reason.
- `needs_human`: workable only after a person decides something. Use it when any of these is true:
  - The outcome is ambiguous.
  - A bug has no reproduction.
  - The work is extra large (an `xl` size label, or more than 4 tickets of honest work).
  - The work touches schema or data migrations, deleting user data, authentication or permissions, credentials or secrets, billing, new third-party services, or CI or deployment configuration.

For `question` and `needs_human`, set `question` to the exact question for a person. Make it answerable in one reply. For `question`, ask what change, if any, the reporter wants. For these three kinds, `requirements` and `tickets` are empty arrays.

A human answer can turn a `needs_human` into a workable kind. It cannot remove a hard stop from rule 7 of the mode skill.

## Requirements

1. Read the whole issue, the comments and the human answer.
2. List every requested behaviour as one requirement. When the issue already labels requirements (R1, R2, ...), reuse those ids and that wording. Else number them R1, R2, ...
3. Write each one so a person can observe it: a command and its output, a request and its response, or a page and what it shows.
4. Keep to the issue's request. A useful extra is a follow-up, not a requirement.

## Find owners

Do this once per distinct behaviour. It replaces Cardinal's `find_repo_context` tool.

1. Search the profile. This lists up to 5 non-legacy files that match the query words, best first:
   ```sh
   jq -r --arg q "<behaviour words>" '($q | ascii_downcase | [scan("[a-z0-9]+")]) as $w | .files | to_entries
     | map(select(.value.status != "legacy"))
     | map((.key + " " + .value.summary + " " + (.value.capabilities | join(" ")) | ascii_downcase) as $t
       | {path: .key, score: ([$w[] | select(. as $x | $t | contains($x))] | length)})
     | map(select(.score > 0)) | sort_by(-.score) | .[:5][] | "\(.score) \(.path)"' <repo>/.cstack/profile.json
   ```
   Include legacy files only when the issue is about old or prototype code.
2. When the search gives no clear owner, or the behaviour crosses many files, run `cstack:how` with the behaviour as the question. Use its **Where Things Live** map.
3. Confirm each owner by reading the file. Prefer active code over legacy code and unused prototypes.
4. Record each behaviour, the query, the candidates and the confirmed owners in `<store>/intake-owners.md`. A decision without this file did not do this step.

## Tickets

- Write 1 to 4 tickets. One focused ticket is often right. Split only when independent or ordered work helps an implementer.
- Each requirement is covered by exactly one ticket.
- Set `depends_on` when a ticket builds on another. List the tickets in dependency order. The unit works them in list order.
- `target_files` are profiled paths. A file the ticket creates gets the `new:` prefix, for example `new:test/store-json.test.mjs`. Never target a `paths_hidden` path.
- Each ticket stands alone. The title names the task. Its requirements carry the observable acceptance.
- For a code change, plan a test at the application's boundary (HTTP, CLI, or browser) and list the test file as a target. A documentation-only ticket needs no test. Do not plan tests that only assert document strings.
- Do not edit files.

## Report

Give the classification, the ticket ids in order with their requirements, whether a human answer was used, the gate result, and the path of `<store>/intake-<unit>.json`. The next stage is 4 for a workable kind, else settle `needs-human`.
