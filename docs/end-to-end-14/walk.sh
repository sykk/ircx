#!/usr/bin/env bash
# Reads #scrollback from the live edge to the beginning, in the assembled app,
# photographing the pane twice at every step with nothing sent between the two
# frames. A pair that differs is the app moving the timeline on its own.
#
#     walk.sh <output directory> [steps] [notches] [window.mjs options...]
#
# The seeders have to be up first — docs/end-to-end-12/seed_history.py, against
# an ergo on 127.0.0.1:6677 — or the channel reads empty and the walk measures
# a still pane that has nothing in it.
#
# SERVER is what the app dials, so the walk can be pointed through `delay.py`
# rather than at ergo itself. Straight at ergo, a page comes back inside the
# time a screenshot takes and lands in the same gap as the wheel that asked for
# it, which is a gap the walk cannot attribute anything to.
set -euo pipefail

OUT=${1:?output directory}
STEPS=${2:-80}
NOTCHES=${3:-8}
SERVER=${SERVER:-127.0.0.1:6677}
HARNESS=$(cd "$(dirname "$0")/../.." && pwd)/.claude/skills/run-ircx/window.mjs

mkdir -p "$OUT"

{
  # CHATHISTORY LATEST has to have filled the pane before anything is scrolled:
  # a wheel arriving into an empty timeline scrolls nothing and the walk starts
  # a page behind where it reads as starting.
  echo "wait 6000"
  echo "ss $OUT/00-live-edge.png"

  for ((i = 1; i <= STEPS; i++)); do
    # 660,400 is over the timeline in the 1200x800 window window.mjs opens —
    # right of the sidebar, left of the roster, clear of the composer.
    printf 'wheel 660 400 -%d\n' "$NOTCHES"
    printf 'ss %s/p%03d-t0.png\n' "$OUT" "$i"
    # Long enough for a page asked for by the scroll above to come back off a
    # loopback socket and be drawn. Nothing is sent inside this window.
    echo "wait 1400"
    printf 'ss %s/p%03d-t1.png\n' "$OUT" "$i"
  done

  echo "ss $OUT/99-end.png"
  echo "quit"
} | node "$HARNESS" --server "$SERVER" --join '#scrollback' "${@:4}"
