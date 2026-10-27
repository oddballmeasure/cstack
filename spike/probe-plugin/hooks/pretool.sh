#!/bin/sh
# Phase 0 probe: log every PreToolUse event, block reads under the hidden dir.
input=$(cat)
mkdir -p /tmp/cstack-probe
printf '%s\n' "$input" >> /tmp/cstack-probe/hook.log
case "$input" in
  *"/tmp/cstack-probe/hidden"*)
    echo "cstack hidden-paths: access to /tmp/cstack-probe/hidden is blocked" >&2
    exit 2
    ;;
esac
exit 0
