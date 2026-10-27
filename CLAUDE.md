# cstack

Plan: (private planning doc). ADRs in `docs/adr/`.

- One phase at a time. Do not start a phase until the previous exit check passes.
- Skills are flat: `skills/<name>/SKILL.md`, plus `references/` and `scripts/`.
- Run `claude plugin validate .` before every commit.
- `spike/` holds Phase 0 probes. Do not ship it in the plugin.
