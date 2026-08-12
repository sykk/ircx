#!/usr/bin/env bash
# Opens #scrollback and reads to the top of the page the join asked for, which
# is where run 15 twice saw the conversation's own opening rows drawn above the
# history.
#
#     head.sh <output directory> <walks> [server host:port]
#
# Run 15 saw it twice in ten walks and could not reduce it. #494 says why: an
# archive page was filed in front of the window without comparing a timestamp,
# and a pane opening on an empty timeline asks the archive with `before` null —
# which is answered with its newest page rather than with a page behind
# anything. The server's own `CHATHISTORY LATEST` lands while that read is in
# flight, and today's rows go in front of yesterday's.
#
# It is a race between two reads, so one clean walk proves nothing and this
# takes the same ten. What each walk photographs is the top of the scroller:
# `Yesterday` over `line 05xx` is the fix holding, and a `Today` separator with
# the join digest under it is the defect.
#
# The seeded history has to be in ergo already — run 15's 900 `line NNNN`
# messages, dated the day before — or a walk reads an empty channel and
# photographs nothing.
set -euo pipefail

OUT=${1:?output directory}
WALKS=${2:?how many}
SERVER=${3:-127.0.0.1:6677}
HARNESS=$(cd "$(dirname "$0")/../.." && pwd)/.claude/skills/run-ircx/window.mjs

mkdir -p "$OUT"

for walk in $(seq -w 1 "$WALKS"); do
  echo "=== walk $walk"
  {
    # The join-time CHATHISTORY LATEST has to have filled the pane before
    # anything is scrolled, or the walk reads a pane holding only the join.
    echo "wait 9000"
    echo "ss $OUT/w$walk-a-foot.png"

    # Up to the top of that page. A notch is not one number between panes, so
    # this over-scrolls rather than counting: the scroller clamps and the extra
    # costs nothing.
    echo "wheel 660 400 -1600"
    echo "ss $OUT/w$walk-b-top.png"

    # Again after a pause. Reaching the top asks for the page behind, so the
    # head recedes as that lands; the defect is above everything and shows in
    # both, and this says which rows are the pane's own and which arrived.
    echo "wait 2500"
    echo "ss $OUT/w$walk-c-settled.png"

    echo "quit"
  } | node "$HARNESS" --release --server "$SERVER" --join '#scrollback' \
    > "$OUT/w$walk.log" 2>&1 || echo "    walk $walk exited $?"
done
