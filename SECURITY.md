# Security policy

## Reporting a vulnerability

Report security problems privately through GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/oddballmeasure/cstack/security/advisories/new) (the **Security** tab, then **Report a vulnerability**).

Do not open a public issue for a security problem. Include what you ran, what happened, and the cstack version (`version` in `.claude-plugin/plugin.json`). You will get a reply on the advisory.

## Scope

In scope: anything in this repository, in particular a way around cstack's guard hook (`hooks/scripts/guard.mjs`: hidden-suite reads, config writes, direct merges, raised autonomy, self-approved deploys, published eval reports), a gate that approves what it should reject, or a cstack script that sends data somewhere the README does not list.

Out of scope: Claude Code itself, the GitHub CLI, and the commands your own repo defines (`test_command`, `deploy.sh`, and so on). Report those to their maintainers.

## Supported versions

Only the latest version on `main` gets fixes.
