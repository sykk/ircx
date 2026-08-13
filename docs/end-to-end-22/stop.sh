#!/usr/bin/env bash
# Stops what this run started, by the pids it wrote down.
#
#     stop.sh <output directory> [--bus]
#
# By pid rather than by name: `pkill -x ergo` would take the one another session
# is running, and `pkill -f notifyd.py` matches the shell running it.
set -euo pipefail
OUT=${1:?output directory}

for who in ergo client; do
  [ -f "$OUT/$who.pid" ] || continue
  kill "$(cat "$OUT/$who.pid")" 2>/dev/null || true
  rm -f "$OUT/$who.pid"
done

if [ "${2:-}" = "--bus" ] && [ -f "$OUT/bus.pids" ]; then
  # shellcheck disable=SC2046
  kill $(cat "$OUT/bus.pids") 2>/dev/null || true
  rm -f "$OUT/bus.pids"
fi
echo "stopped"
