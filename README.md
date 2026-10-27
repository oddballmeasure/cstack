# cstack

Agent-only coding harness for Claude Code. It combines Cardinal's issue lifecycle and gates, pstack's playbooks and verification, and tstack's proof and PR discipline.

Status: Phase 1 (foundations). See the plan: (private planning doc)

## Install (private)

Install at project or local scope, inside the repo cstack should work on. User scope would apply cstack's guard (no direct merges, no sleep loops) to every session on the machine.

```
claude plugin marketplace add oddballmeasure/cstack --scope local
claude plugin install cstack@cstack --scope local
```

Then run `/cstack:setup-cstack` in that repo.

Local development without install:

```
claude --plugin-dir /path/to/cstack
```
