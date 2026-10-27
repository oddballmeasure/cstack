---
name: status
description: "Use when the human asks how a cstack run is going, or when cstack:orchestrate closes a run. Gives one short report under 150 words: the frontier, units by state, the verification ledger, and each item waiting on the human with what to decide and a recommended choice. Also for /cstack:status <slug>."
argument-hint: "[<slug>]"
---

<!-- Voice rules adapted from pstack skills/ketchup/SKILL.md @ 519d36a (MIT, Lauren Tan). Report shape from Cardinal's `cardinal status` (oddballmeasure/cardinal, same owner). -->

# Status

One short report a busy human reads in under a minute. Read only. This skill changes nothing.

`<root>` is the plugin root, two directories up from this skill's base directory. Without a slug, list `<repo>/.cstack/runs/` and pick the store with the newest `decisions.tsv`. Say which one you picked. `<orch>` is `node <root>/gates/orch.mjs --store <store>`.

## Gather

Run these. Take numbers from their output, never from memory.

- `<orch> unit counts`, `<orch> unit list`
- `<orch> ledger summary`
- `<orch> frontier show`
- `<orch> gate list`
- `node <root>/gates/worker.mjs next --store <store>` (what launches next, what waits for a usage reset)
- `systemctl --user is-active` for each in-flight unit's worker, if the store has `workers/`
- `<store>/post-merge.tsv`, the last row per PR, if it exists
- issues labelled `<prefix>:needs-human` that the run touched: the unit issues and post-merge follow-ups

## Write

Five parts, in this order:

1. **Headline.** One sentence: merged against planned, and whether the run is moving, waiting on the human, or done.
2. **Frontier.** The open PRs from the frontier, lowest first, as `#<pr> <state>`.
3. **Units.** Counts by state, then one line for each unit that is not merged: id, state, PR.
4. **Ledger.** The verdict counts.
5. **Waiting on you.** Each item: what to decide, the options, and your recommended choice with one reason. Sources: open gates (they carry a default), `needs-human` units and follow-ups, merge-ready PRs under autonomy stop, and a `setup` (billing) entry. Put this part first when it is not empty.

## Voice

- Plain words. No jargon the human did not use first. Name a unit by its issue title, with the id after it.
- Under 150 words in total. Cut the frontier and ledger to one line each before you cut a waiting item.
- One fact per sentence. No hedging, no filler, no em dashes.
- Every waiting item ends with "Recommend: <choice>." Never hand the human a check you could run.
- If nothing waits on the human, say so in one line.
