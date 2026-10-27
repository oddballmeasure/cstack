---
name: create-verification-skill
description: "Use when a repo has no scripted way to drive its app the way a user does (UI, CLI, service, library), or when cstack:e2e-plan needs a browser or service driver and no .claude/skills/verify-<app>/ exists. Generates a project-local verify-<app> skill (Launch, Doctor, Drive, Evidence, Cleanup) plus a feature map, for any language or platform, and proves it end to end once."
---

<!-- Adapted from pstack skills/create-verification-skill/SKILL.md @ 519d36a (MIT, Lauren Tan). -->

# Create a verification skill

Every serious project needs a scripted way to drive the real app and prove behaviour: launch it, use a feature the way a user would, and capture evidence. This skill generates that as a project-local skill in the target repo, `.claude/skills/verify-<app>/`, tailored to the repo. You write it for the next agent, not for a human. An agent that has never seen the app will read it cold, mid-task.

`cstack:e2e-plan` uses the generated skill as its driver for browser and service surfaces. The hidden e2e suite reuses its launch, doctor and drive recipes.

## 1. Interview the repo, not the user

Answer these from the codebase. Ask the user only what you cannot observe:

- **Surface.** What does a user actually touch? A web UI, a CLI or TUI, a desktop app, an API, a mobile app, a library? A repo can have several. Pick the primary one and note the rest.
- **Run.** How does the app start locally? Prefer the repo's own documented dev command (package scripts, Makefile, README quickstart). Note ports, env vars, seed data and auth.
- **Drive.** How can an agent interact with it from a script? Existing harnesses first: Playwright or Cypress specs, expect scripts, PTY helpers, endpoints you can curl, a debug port. Only then pick a generic recipe: browser automation for web and Electron, a tmux or PTY harness for a CLI or TUI, plain HTTP for services.
- **Observe.** What evidence can you capture? Screenshots, terminal transcripts, response bodies, logs, exit codes, database state.
- **Isolate.** Can two instances run side by side (ports, data dirs, profiles)? If not, say so in the generated skill. Refusing to drive a shared instance twice beats corrupting the user's session.

If the checkout does not build or start as-is, fix that first, or report it precisely, before you generate. A skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static dir the API never serves, a sample config), the generated skill may create it, clearly marked as verification scaffolding, and remove it in cleanup.

## 2. Generate the skill

Write `.claude/skills/verify-<app>/SKILL.md` with YAML frontmatter. Set `name: verify-<app>` and a `description` that names the app, the surface, and when to reach for it. Without frontmatter the skill never registers. Write these sections, each grounded in what the interview found. Leave no placeholders.

- **Launch.** The exact command that starts the app for verification, and how to tell it is ready (a log line, a prompt). Launch must reach a usable state from an empty data dir, including any migrations and seed data. Ready means usable, not only that a process answers. A database health check can pass while its init scripts still run. Include teardown. A short-lived CLI or TUI has no server to keep alive: launch means build the binary (or install deps) once, then start each drive in its own isolated PTY or tmux session.
- **Doctor.** One read-only check that answers "is this instance worth driving?": process up, right version or build, port owned by us, auth valid. An agent runs it first whenever anything looks off.
- **Drive.** The harness recipe with real selectors and commands from this repo, not examples. Prefer stable handles (ARIA labels, data attributes, prompt strings, route paths) over coordinates and tab order.
- **Evidence.** What to capture for a proof and where it goes. State the proof standards:
  - Use the real user path, not internal setters or test-only endpoints.
  - Capture the action and the resulting state, not only the final screen.
  - Check side effects (files written, rows inserted, messages sent) as well as what is visible.
  - Use mocks only where a production boundary already isolates the external system.
  - When the safe path is a dry run or test mode, observe what it actually skips (files, network, git refs). Do not trust its name. Some dry runs still touch the network or open a browser.
- **Cleanup.** How to tear down the instances the run created. Never kill by process name. Kill what you started. Cleanup removes instances and scratch state, never the evidence. Proof artifacts survive the teardown, in a location the skill names.
- **Helpers.** Every script the skill ships is executable, and the skill body shows how to call it. A helper the reader has to reverse-engineer is not a helper.

## 3. Seed the feature map

Create `.claude/skills/verify-<app>/features/README.md` plus one file per user-facing feature you can find. Start with the top 3 to 5, from routes, commands, menus or docs. Follow the shape in [the feature map example](references/feature-map-example/README.md): a README index and one file per feature.

Each feature file answers, from the user's point of view: what the feature is, how to reach it, how to drive it with the harness, and what observable end state proves it works. Its four H2 headings are `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`.

If the seed data lacks a precondition that a journey needs, the journey reports a failure and the reason goes in that feature's `Gotchas`. Never weaken the journey to make it pass. The map is the repo's maintained verification source. A proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated skill before you hand it over

Run its own instructions end to end once: launch, doctor, drive ONE mapped feature, capture evidence, clean up. One feature is enough. The map exists so later runs can cover the rest. After cleanup, confirm the evidence still exists at the named location. A cleanup that deletes the proof fails this step.

Fix what fails. Run the generated cleanup after every failed iteration too, so broken attempts do not strand processes and ports. A generated skill that never ran is a draft, not a deliverable.

If you proved it in a stand-in for the real target (a container instead of a fresh VM, a local stack instead of a remote one), list every setup step the stand-in did that the target will not. Those steps stay unverified until a run on the real target covers them.

## 5. Offer the maintenance loop

Point the user at `cstack:maintain-verification-skill` to keep the map honest as the app changes. Suggest a cadence only if they ask.

## Report

- The skill path and the features mapped.
- The proof run: the feature driven, the evidence path, and the cleanup result.
- Setup steps that stay unverified on the real target, if any.
