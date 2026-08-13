#!/usr/bin/env bash
# Opens the client, turns the Highlights switch on, and asks the second client
# for one highlight.
#
#     explore.sh <tree> <output directory>
#
# The first walk of the run, and its job is the coordinates: `window.mjs` has no
# selectors, so where the Notifications section sits in the settings dialog and
# where its first switch sits on the page are things a screenshot has to answer
# before any of them can be clicked.
#
# It keeps its profile. The switch is written to `localStorage`, so a profile
# that has been through this once can be relaunched with the switch already on,
# and the walks that measure something need not click through the dialog again.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
HERE=$(cd "$(dirname "$0")" && pwd)
source "$OUT/bus.env"
mkdir -p "$OUT/shots"

{
  echo "wait 6000"
  echo "ss $OUT/shots/e1-joined.png"
  # Mod+, is the binding; the helper takes a keysym by name, so the comma is
  # reachable where `(` would not be.
  echo "key ctrl+comma"
  echo "wait 1200"
  echo "ss $OUT/shots/e2-settings.png"
  echo "quit"
} | node "$TREE/.claude/skills/run-ircx/window.mjs" --release \
      --server 127.0.0.1:6688 --join '#harness' --keep \
      > "$OUT/explore.log" 2>&1 || echo "walk exited $?"

grep -E "^ok ready|profile" "$OUT/explore.log" | tail -2
