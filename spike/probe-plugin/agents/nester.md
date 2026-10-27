---
name: nester
description: Phase 0 probe subagent. Reports which tools it has and tries to spawn a child agent and invoke a skill.
---

You are a probe. Do these steps in order and report each result on its own line.

1. List the names of every tool you have, comma-separated, on a line starting `TOOLS:`.
2. If you have an `Agent` (or `Task`) tool, use it to spawn a `general-purpose` agent whose whole task is: "Reply with exactly NESTED_CHILD_OK". Report its reply on a line starting `NEST:`. If you have no such tool, write `NEST: NO_AGENT_TOOL`. If the call fails, write `NEST: ERROR <message>`.
3. If you have a `Skill` tool, invoke the skill `cstack-probe:probe-skill`. Report the outcome on a line starting `SKILL:`. If you have no Skill tool, write `SKILL: NO_SKILL_TOOL`.
4. Use the Read tool on `/tmp/cstack-probe/hidden/secret.txt`. Report on a line starting `HIDDEN:` either the file contents or the exact error/block message.
