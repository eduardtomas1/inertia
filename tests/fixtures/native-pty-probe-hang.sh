#!/bin/sh

if [ -z "${INERTIA_PTY_PID_FILE:-}" ]; then
  exit 2
fi
printf '%s' "$$" > "$INERTIA_PTY_PID_FILE"
read -r inertia_probe_wait
