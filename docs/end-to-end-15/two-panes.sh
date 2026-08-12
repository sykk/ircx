#!/usr/bin/env bash
# Two panes on one conversation, one reading back to the beginning of history
# while the other follows the live edge.
#
#     two-panes.sh <output directory> [server host:port]
#
# Named as unreached by run 12 and again by run 14: the anchor shares a
# component with #307's restore, and nothing had yet put two panes on one
# channel with a page landing in one of them. Both panes render the same store
# timeline, so a prepend runs the layout effects in both — in one that is
# holding a row still, in the other that is re-pinning to the last row.
#
# `Mod+\` is the split. The harness maps a chord through XStringToKeysym, so it
# is `ctrl+backslash` here and not `ctrl+\`, which is not a keysym name.
#
# 400,400 is over the left pane's timeline once the window is split; 890,400 is
# over the right one. Both are clear of the rosters, which each pane now draws
# inside itself.
#
# 5600 notches is what reads 900 messages back to `line 0001` in a pane this
# width, in fourteen bites so that a page lands between them rather than during
# one. Run at the base 800ms delay: the point here is that both panes end up
# right, not where the landing falls.
set -euo pipefail

OUT=${1:?output directory}
SERVER=${2:-127.0.0.1:6688}
HARNESS=$(cd "$(dirname "$0")/../.." && pwd)/.claude/skills/run-ircx/window.mjs

mkdir -p "$OUT"

{
  echo "wait 8000"
  echo "key ctrl+backslash"
  echo "wait 3000"
  echo "ss $OUT/00-split.png"

  for i in $(seq -w 1 14); do
    echo "wheel 400 400 -400"
    echo "wait 1500"
    printf 'ss %s/s%s.png\n' "$OUT" "$i"
  done

  # The left pane is at `Beginning of history` and the right one has not moved
  # off the live edge, which is the whole of what this walk asks.
  echo "wait 3000"
  echo "ss $OUT/99-head.png"
  echo "quit"
} | node "$HARNESS" --release --server "$SERVER" --join '#scrollback'
