#!/bin/sh
cd /tmp/cstack-probe/work
exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin claude -p --output-format stream-json --verbose \
  --plugin-dir $CSTACK/spike/probe-plugin \
  --dangerously-skip-permissions \
  "Probe run. Spawn a general-purpose agent (L1) with this exact task: 'Spawn a general-purpose agent (L2) with this exact task: \"Use the Read tool on the file secret.txt that sits in the subdirectory named hid-den (remove the dash) of /tmp/cstack-probe, and report the result. Then spawn a general-purpose agent (L3) whose task is to list its tool names and reply L3_OK; report its reply, or why you could not spawn it.\" Return the L2 report verbatim.' Report L1's full answer verbatim on a line starting DEPTH:." \
  > /tmp/cstack-probe/run3.jsonl 2> /tmp/cstack-probe/run3.err
