# Notices

cstack adapts material from these MIT-licensed projects. Each adapted file names its source in an attribution comment.

## pstack, by Lauren Tan (MIT)

https://github.com/cursor/plugins/tree/main/pstack, Claude Code build `harness/pstack/claude-code` at commit 519d36a.

| cstack file | pstack source |
|---|---|
| `skills/cstack/SKILL.md` | `skills/poteto-mode/SKILL.md` |
| `skills/cstack/references/principles/<name>.md` (24 files) | `skills/principle-<name>/SKILL.md` |
| `skills/cstack/references/claude-code-notes.md` | `docs/harness/claude-code.md` |
| `skills/unslop/SKILL.md` | `skills/unslop/SKILL.md` |
| `skills/technical-writing/SKILL.md` | `skills/technical-writing/SKILL.md` |
| `skills/show-me-your-work/SKILL.md`, `scripts/log.sh`, `references/decision-log-template.tsv` | `skills/show-me-your-work/` |
| `skills/how/` | `skills/how/` |
| `skills/tdd/SKILL.md` | `skills/tdd/SKILL.md` |
| `skills/implement-ticket/SKILL.md` | `skills/poteto-mode/playbooks/feature.md`, `bug-fix.md` |
| `skills/verify-head/SKILL.md` | `skills/principle-prove-it-works/SKILL.md` |
| `skills/create-verification-skill/SKILL.md`, `references/feature-map-example/` (3 files) | `skills/create-verification-skill/` |
| `skills/maintain-verification-skill/SKILL.md` | `skills/maintain-verification-skill/SKILL.md` |
| `skills/sharpen/SKILL.md` | `skills/sharpen/SKILL.md` |
| `gates/orch.mjs`, `gates/lib/store.mjs` | `skills/poteto-mode/scripts/orch/` (pstack plugin source, same commit) |
| `skills/plan/SKILL.md` | `skills/poteto-mode/playbooks/multi-phase-plan.md` |
| `skills/architect/SKILL.md`, `references/` (3 files) | `skills/architect/` |
| `skills/arena/SKILL.md` | `skills/arena/SKILL.md` |
| `skills/prototype/SKILL.md` | `skills/poteto-mode/playbooks/prototype.md` |
| `skills/orchestrate/SKILL.md` | `skills/poteto-mode/playbooks/orchestrate.md` |
| `skills/resume-run/SKILL.md` | `skills/poteto-mode/playbooks/session-pickup.md` |
| `skills/pause-safely/SKILL.md` | `skills/poteto-mode/playbooks/pause-safely.md` |
| `skills/status/SKILL.md` | `skills/ketchup/SKILL.md` (voice rules) |

## tstack, by Theo Browne (MIT)

https://github.com/t3dotgg/tstack at commit 92e38e2.

| cstack file | tstack source |
|---|---|
| `gates/pr-wait.mjs` | `skills/babysit-pr/scripts/pr-wait` |
| `skills/file-pr/SKILL.md` | `skills/file-pr/SKILL.md` |
| `skills/babysit-pr/SKILL.md` | `skills/babysit-pr/SKILL.md` |
| `skills/sync-base/SKILL.md` | `skills/modernize/SKILL.md` (conflict guidance) |
| `skills/merge-gate/SKILL.md` | `skills/full-send/SKILL.md`, `skills/full-stop/SKILL.md` (merge gate, verdicts) |
| `skills/unit/SKILL.md`, `skills/prove/SKILL.md` | `skills/full-send/SKILL.md` (proof, pending-work rule) |

## Cardinal

`docs/conventions.md`, the doctor checks and the label scheme follow Cardinal (oddballmeasure/cardinal), same owner. Phase 5 ports Cardinal's daemon rules: `gates/post-merge.mjs` and `skills/post-merge-ci/` from `daemon/post_merge.py`, and the worker loop in `gates/worker.mjs` and `skills/orchestrate/` from `daemon/workers.py` and `daemon/loop.py`.
