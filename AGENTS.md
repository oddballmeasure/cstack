# cstack

Design: `docs/how-it-works.md`. Decisions: `docs/adr/`.

- One phase at a time. Do not start a phase until the previous exit check passes.
- Skills are flat: `skills/<name>/SKILL.md`, plus `references/` and `scripts/`.
- Run `claude plugin validate .` before every commit.
- Never launch a Claude Code session with `--dangerously-skip-permissions`. Use the role allowlists from `gates/run-settings.mjs --permissions` (ADR-009).
- cstack is one plugin for Claude Code and Codex. Keep `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` in step: the L0 lint checks name, version, description and license. A Claude Code tool named in a skill needs a row in `skills/cstack/references/codex-notes.md` (lint).
- Never launch a Codex session with `--dangerously-bypass-hook-trust` or an API-key login (ADR-010, ADR-012).
- Detached sessions go through `gates/lib/supervisor.mjs` (ADR-011), never straight to `systemd-run` in new code.
- Gates reach the code host only through `gates/lib/forge.mjs` (ADR-013): issues, labels, change requests, checks and merges. Never call `gh` or `glab` from a gate directly. Skills call `gates/forge.mjs` instead (lint).
