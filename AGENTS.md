# cstack

Design: `docs/how-it-works.md`. Decisions: `docs/adr/`.

- One phase at a time. Do not start a phase until the previous exit check passes.
- Skills are flat: `skills/<name>/SKILL.md`, plus `references/` and `scripts/`.
- Run `claude plugin validate .` before every commit.
- Never launch a Claude Code session with `--dangerously-skip-permissions`. Use the role allowlists from `gates/run-settings.mjs --permissions` (ADR-009).
