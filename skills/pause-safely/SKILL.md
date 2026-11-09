---
name: pause-safely
description: "Use only when the human explicitly asks a cstack session to pause or stop for now, or before a known compaction. Stops at a safe boundary, makes the work durable (a wip commit without a ticket trailer, the run store), writes a resume note that cstack:resume-run reads, and for a coordinator stops new launches. Never for 'keep going'."
argument-hint: "[--run <slug>]"
---

<!-- Adapted from pstack skills/poteto-mode/playbooks/pause-safely.md @ 519d36a (MIT, Lauren Tan). -->

# Pause safely

You own a clean stop. Leave a checkpoint that a cold-start agent can resume from. Run it only when the human asks, or before a known compaction. On "keep going", "going to bed, keep going" or "don't stop", do not pause.

`<root>` is the plugin root, two directories up from this skill's base directory. `<store>` is the run store, `<repo>/.cstack/runs/<slug>`. `<orch>` is `node <root>/gates/orch.mjs --store <store>`. `<unit name>` is `cstack-<repo name>-<slug>-<unit>`, where `<repo name>` is config `repo` after the slash.

## Procedure

1. **Stop at a safe boundary.** Finish the current atomic step or back out of it. Start nothing new. Stop any subagent you launched and any Monitor you armed (`TaskStop`).
2. **Take no irreversible action to pause.** No new PR, no push and no merge. Never push the wip commit: it stays local in the worktree, because `gates/publish.mjs` pushes only a head the ledger approved.
3. **Make the work durable.**
   - In a unit worktree with uncommitted edits: commit them as one `wip: <what>` commit on the unit's branch. Keep `Cstack-Unit: <unit>` and `Refs: #<N>` in the last paragraph. Leave out `Cstack-Ticket`, so `cstack:unit` does not count the ticket as done when it resumes. If the tree is broken, say so in one line of the body.
   - As a coordinator (`cstack:orchestrate`): add a stop line so no session launches new units: `<orch> standing add "STOP: paused by the human at <iso time>. Launch nothing until a human removes this line."` Running Level B workers are separate sessions. If the human asked to stop them too, stop each one with `node <root>/gates/supervise.mjs stop <unit name>`; its exit hook records the stop in the inbox. Otherwise leave them running.
   - For the daemon: create `<repo>/.cstack/daemon.stop` with the reason. Its next tick launches nothing.
4. **Write the resume note** to `<store>/resume-<unit or coordinator>.md`, outside your context. Capture the intent, what you were doing, progress and what is verified (gate output, ledger rows), the current state, the next steps, key files, and gotchas. Point at `<store>/decisions.tsv` instead of repeating it. Without a store, write `/tmp/cstack-<slug>-resume.md`.
5. **Log** the pause with `cstack:show-me-your-work`: what stopped, the commit SHA, the note path.

To resume, the human finds the `STOP` line's number with `<orch> standing show`, removes it with `<orch> standing remove <n>` (which renumbers the rest), and runs `/cstack:resume-run <slug>`. Do not edit `<store>/preferences.md` by hand: a gap in its numbering breaks every `orch` call. For the daemon, the human deletes `<repo>/.cstack/daemon.stop`.

## Reply

Where you are in the loop, what is on disk and what is still only in your head (paths, no diff dumps), the commits you made and whether the tree is clean, and the first action on resume. This is a pause, not a final report.
