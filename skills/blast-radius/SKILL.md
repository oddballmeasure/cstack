---
name: blast-radius
description: "Use this skill whenever the user asks what a change could break, its blast radius, whether a rename or small diff is really safe, or says they do not trust a small change, including a pasted diff with no repo or shell. Do not answer such a question from the diff alone. This skill looks where grep stops (wire formats, other languages reading the same data, timing, library internals), names the one fact the change is safe because of, proves it by running real code or marks it unproven, and separates confirmed risks from cleared ones with the cheapest check to run before merge."
argument-hint: "[<pr-number> | <path> | <diff>]"
---

<!-- Adapted from pstack skills/blast-radius/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# Blast radius

Find what a change breaks somewhere else, before it ships. `<root>` is the plugin root, two directories up from this skill's base directory.

Companion to `cstack:how`. `cstack:how` says what the code does. Blast radius says what the change breaks somewhere else.

Listing the callers is not the job. Grep finds those in a second. The job is the breakage grep does not show.

Read the [cstack mode skill](../cstack/SKILL.md) first.

## Do not trust your own writeup

A blast-radius writeup that sounds right is worthless. It reads as convincing whether or not it is true. So do not hand back only the writeup. Find the one or two facts the whole thing depends on, and prove them by running code.

### How sure are you

For each fact the change's safety depends on, take it as far down this list as is cheap. Say where it stopped.

1. You said so. Worthless on its own.
2. You pointed at the line. A real `file:line`, or the library's own source.
3. You showed the bad case cannot happen. You walked the failure step by step and it does not reach.
4. You ran it. A script or test that calls the real code and fails loudly if you are wrong.
5. You reproduced it in the running app.

Level 4 is usually one small script that imports the same library the app ships and calls the exact function you worry about. When you cannot run code (no shell, no checkout, a pasted snippet), stop at level 2 or 3, say so, and give the script for level 4.

## Steps

1. **Read the change.** The diff, the symbols it adds, changes and deletes, and what it now does differently, including the part the diff does not spell out. Read the PR and commits for the reason: `node <root>/gates/forge.mjs change view <n>`, `git log`, `git log -L` on the changed lines.
2. **Find the one fact it is safe because of.** Most changes that look risky are safe because of a single fact, like "this call only drops cache entries that are already dead and does nothing else". Find that fact. If it holds, most risky cases clear at once. Spend your time here, not on a long list of maybes.
3. **Look where grep stops.** Read the source of the library you call. Check its pinned version and any local patch. Work out when things run: microtasks, teardown, retries, process exit. Follow what a symbol search misses: the JSON an API returns, a DB column, a wire format, another language reading the same bytes, a feature flag, code three hops downstream.
4. **Be honest about each risk.** Give it a real chance of happening and a real cost if it does. Keep the risks you confirmed. List the ones you checked and cleared separately. Cite a real `file:line`. A search that finds nothing is still an answer. Never invent a caller or an API.
5. **Prove the one fact.** Write a script or test that runs the real code, run it, and paste what happened. If you cannot run it, mark the fact unproven and give the script.
6. **For a big or wide change, run it as a `cstack:arena`.** Ask more than one model the same question and merge the answers. Different models catch different real bugs.

## What to hand back

- **What it does.** What changed, including the part that is not obvious.
- **The one fact it is safe because of.** State it, say which level you got it to, and show the proof. If you could not prove it, write `unproven`.
- **Risks.** Each names how it breaks, the `file:line`, how likely and how bad, and how to check. Paste the proof for the ones that matter.
- **Cleared.** What you checked and why it is fine.
- **Before you merge.** The cheapest test or reproduction that catches the real bug, including the script you wrote.

Write it through `cstack:unslop`. Cite real code. Strip anything private before it goes anywhere public.
