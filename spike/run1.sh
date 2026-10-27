#!/bin/sh
cd /tmp/cstack-probe/work
exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin claude -p --output-format stream-json --verbose \
  --plugin-dir $CSTACK/spike/probe-plugin --plugin-dir $CSTACK \
  --dangerously-skip-permissions \
  "Do these in order and report each on its own line. 1) Invoke the skill cstack:hello via the Skill tool and report its reply on a line starting MAIN_SKILL:. 2) Use the Read tool on /tmp/cstack-probe/hidden/secret.txt and report contents or the block message on a line starting MAIN_HIDDEN:. 3) Use the Agent tool with subagent_type cstack-probe:nester and the prompt 'Run your probe steps.' and paste its full report verbatim under a line SUBAGENT_REPORT:." \
  > /tmp/cstack-probe/run1.jsonl 2> /tmp/cstack-probe/run1.err
