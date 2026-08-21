#!/usr/bin/env bash
# The pane parked inside the block an arriving page merges into.
#
#     parked.sh <tree> <output directory> <hold port> <ergo port> <hold seconds> <park notches> <channel>
#
# Run 31's walk with the merge arranged, which took two things run 31 did not
# need and one it had that cannot be kept.
#
# **The seed speaks in runs of sixty.** A pane is only a message tall from the
# top of its content where a row is a message tall, so the band a reader can be
# parked in and still be a neighbour — past `LOAD_OLDER_PX` and inside the row an
# arriving page merges into — exists only where a block is hundreds of pixels of
# one row. Run 31's four-line runs put every parked pane either at the top of its
# content, where it asks for the page itself, or below anything the page could
# redraw, and `docs/manual-verification.md` has carried that as the reason this
# arrangement was unwalked.
#
# **The walk is one launch, and run 31's two cannot be.** There the profile is
# seeded by a first launch and restored by a second, which is #508's own shape.
# A restored window is `localArchive` and a page-back is `serverHistory`, and
# `rows.ts` closes the open run at that boundary and draws a divider there:
#
#     const history = message.source === "serverHistory";
#     if (history !== inHistory) { ... open = null; ... }
#
# So a page landing above a restored window can never merge into the reader's
# row — the source changes at exactly the line it would merge at. Walked twice
# before this was noticed: the reader held on both builds, the parked pane's row
# gained the arriving group's name and not one of its messages, and `tookIn` read
# 16px where a merge is hundreds. One launch keeps both sides `serverHistory`.
#
# What one launch costs is an ask nobody asked for. A pane a split has just made
# sits at the top of its content for the commit before the follow scroll moves
# it, and asks for a page there; the proxy holds it like any other. So the walk
# waits that hold out and lets the page land before it parks anything, which is
# also what puts the boundary this run is about inside the window rather than at
# its edge.
#
# The reading is the records rather than the frames. A landing page changes what
# the rows around the reader draw, so a strip taken from a screenshot is compared
# against rows that are no longer the same rows — the confound run 30 names and
# run 31's #535 walk was caught by. What a record carries is the reader's own
# line: `delta` is where their row starts and `within` is how far into it their
# line is drawn, and a row that takes a page into itself trades one against the
# other without moving anybody. The frames are kept all the same, because a pane
# that moved by 700px shows it and a record that says so alone is one instrument
# unchecked.
set -euo pipefail

TREE=${1:?tree}
DIR=${2:?output directory}
HOLD=${3:?hold port}
ERGO=${4:?ergo port}
SECONDS_HELD=${5:?hold seconds}
PARK=${6:?park notches}
CHANNEL=${7:?channel}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
HERE="$TREE/docs/end-to-end-40"
mkdir -p "$DIR"

python3 "$TREE/docs/end-to-end-30/latepage.py" "$HOLD" "127.0.0.1:$ERGO" "$DIR/wire.log" \
  "$SECONDS_HELD" > "$DIR/hold.log" 2>&1 &
HOLD_PID=$!
sleep 1

# The split's own ask is held for the same seconds as everything else, so the
# wait is that hold plus the drawing. `at-live.png` is what `pick.py` brackets
# the parking with: an ask stamped between it and `parked.png` came out of the
# right pane overshooting, and this walk then has no parked pane in it.
{
  echo "wait 9000"
  echo "key ctrl+backslash"
  echo "wait $(( (SECONDS_HELD + 12) * 1000 ))"
  echo "ss $DIR/at-live.png"
  echo "wheel 880 400 -$PARK"
  echo "wait 2500"
  echo "ss $DIR/parked.png"
  echo "wheel 400 400 -1600"
  echo "wait 1500"
  echo "ss $DIR/frame-000.png"
  for n in $(seq -w 1 $(( (SECONDS_HELD + 8) / 2 + 3 ))); do
    echo "ss $DIR/frame-$n.png"
    echo "wait 2000"
  done
  echo "quit"
} | IRCX_PROBE="$DIR/probe.log" node "$HARNESS" --release --server "127.0.0.1:$HOLD" \
    --join "$CHANNEL" > "$DIR/walk.log" 2>&1 \
  || echo "    the walk exited $?"

kill "$HOLD_PID" 2>/dev/null || true
wait "$HOLD_PID" 2>/dev/null || true

echo "  $(grep -c ' >> .*CHATHISTORY BEFORE' "$DIR/wire.log" || true) page-backs asked, \
$(grep -c ' hold ' "$DIR/wire.log" || true) lines held"
python3 "$HERE/pick.py" "$DIR"
