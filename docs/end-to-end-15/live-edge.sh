#!/usr/bin/env bash
# Reads #scrollback to the top and comes back to the live edge, so that the
# page the scroll asked for lands on a pane that is following.
#
#     live-edge.sh <output directory> [server host:port]
#
# Run 14 measured a page landing on a reader who had scrolled back and stayed
# there. This is the other side of it: the pane at the live edge has no anchor
# to hold — `Timeline.tsx` re-pins it to the last row instead — and no walk had
# watched that happen.
#
# The point of the walk is the order of three things: the scroll asks, the
# reader returns to the live edge, and only then does the page land. Against a
# loopback ergo the answer comes back inside the time a screenshot takes, so
# the server's side has to be held for the length of the journey back — a
# thousand wheel notches up and twelve hundred down, most of a minute. That is
# `stepdelay.py`, which registers at 800ms and steps to 45s before the scroll.
#
# The seeders have to be up first — docs/end-to-end-12/seed_history.py against
# an ergo on 127.0.0.1:6677 — or the channel reads empty and the walk measures
# a still pane with nothing in it.
#
# A step of 45s is longer than the 5s `REPLY_TIMEOUT` in src-tauri/src/state.rs,
# so the walk also draws "walk stopped responding — reconnect it and try again"
# across the head of the timeline. That is #491 and not this walk failing: the
# page still arrives, and is still the thing being measured.
set -euo pipefail

OUT=${1:?output directory}
SERVER=${2:-127.0.0.1:6690}
HARNESS=$(cd "$(dirname "$0")/../.." && pwd)/.claude/skills/run-ircx/window.mjs

mkdir -p "$OUT"

{
  # CHATHISTORY LATEST has to have filled the pane before anything is scrolled.
  echo "wait 9000"
  echo "ss $OUT/00-live-edge.png"

  # Up to the top, which is what asks the server for the page. 1600 notches at
  # the ~11px this window's timeline moves per notch; measure it again rather
  # than trusting the figure, because it is not the same in a narrower pane.
  echo "wheel 660 400 -1600"
  echo "ss $OUT/01-at-top.png"

  # And back down. Over-scrolling is free: the scroller clamps, and STUCK_PX
  # gives 48px of slack either way for what still counts as following.
  echo "wheel 660 400 2000"
  echo "ss $OUT/02-back-at-edge.png"

  # The page is still held at this point. Frames until it lands and after it,
  # with nothing sent between any two of them: a pair that differs is the app
  # moving a pane nobody touched.
  for i in $(seq -w 1 12); do
    echo "wait 3000"
    printf 'ss %s/e%s.png\n' "$OUT" "$i"
  done

  echo "quit"
} | node "$HARNESS" --release --server "$SERVER" --join '#scrollback'
