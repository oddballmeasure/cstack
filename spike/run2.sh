#!/bin/sh
cd /tmp/cstack-probe/work
exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN PATH=/home/monty/.local/bin:/usr/local/bin:/usr/bin:/bin claude -p --output-format stream-json --verbose \
  --plugin-dir /home/monty/cstack/spike/probe-plugin \
  --dangerously-skip-permissions \
  "Probe run. Report each step on its own line.
STEP A: Spawn a general-purpose agent (call it L1) with this exact task: 'Spawn a general-purpose agent (L2) with this exact task: \"Use the Read tool on /tmp/cstack-probe/hidden/secret.txt and report the result, then spawn a general-purpose agent (L3) whose task is to reply exactly L3_OK, and report its reply or why you could not spawn it.\" Return L2 report verbatim.' Report L1's full answer on a line starting DEPTH:.
STEP B: Load the Monitor tool via ToolSearch. Start a Monitor on the shell command: sleep 25; echo MONITOR_EVENT_FIRED . Then end your turn and wait for the event. When the event arrives, reply MONITOR_WOKE plus the event text. If Monitor is unavailable in this mode, reply MONITOR_UNAVAILABLE with the reason." \
  > /tmp/cstack-probe/run2.jsonl 2> /tmp/cstack-probe/run2.err
