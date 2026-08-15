#!/usr/bin/env bash
# The two frames either side of the page landing, chosen after the fact.
#
#     straddle.sh <tree> <output directory> <hold port> <ergo port> <hold seconds>
#
# **A wait cannot be counted from a screenshot here, and the first set of this
# run is why.** The walk's clock starts at the frame taken after the wheel, and
# the ask does not go out until that wheel burst reaches the top of the pane —
# seconds later, and not the same number of seconds every time. Waits counted
# the first way put both frames after the landing in six walks out of six, which
# reads as a reader who never moved and is a photograph of one state twice.
#
# So this takes a frame every two seconds across a window wide enough to contain
# the release however the wheel went, and `pick.py` chooses the straddling pair
# afterwards against the epoch `latepage.py` stamps on the release itself. The
# pair either side of a known instant is the measurement; the rest of the burst
# is what makes finding it possible.
#
# The stillness of the pane before the landing is read off the same burst, from
# the two frames before the chosen one, and is what says a shift belongs to the
# page arriving rather than to a pane that was drifting anyway.
set -euo pipefail

TREE=${1:?tree}
DIR=${2:?output directory}
HOLD=${3:?hold port}
ERGO=${4:?ergo port}
SECONDS_HELD=${5:?hold seconds}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$DIR"

python3 "$TREE/docs/end-to-end-30/latepage.py" "$HOLD" "127.0.0.1:$ERGO" "$DIR/wire.log" \
  "$SECONDS_HELD" > "$DIR/hold.log" 2>&1 &
HOLD_PID=$!
sleep 1

# **The ask is inside the wheel burst, not after it.** A pane asks the moment it
# reaches the top of its content, and the burst goes on scrolling against a top
# it has already reached for however many notches are left — so the ask can
# precede the first frame by ten seconds. A window opened twelve seconds before
# the release would be caught the wrong side of it, and was: the first attempt
# at this arm ended with two frames before the landing and seventeen after.
#
# So the burst opens twenty-eight seconds before the release could be at its
# latest and runs fifty-two seconds, which covers the ask landing anywhere in
# the burst that made it.
{
  echo "wait 9000"
  echo "wheel 600 400 -1200"
  echo "wait 1500"
  echo "ss $DIR/frame-000.png"
  echo "wait $(( (SECONDS_HELD - 28) * 1000 ))"
  for n in $(seq -w 1 26); do
    echo "ss $DIR/frame-$n.png"
    echo "wait 2000"
  done
  echo "quit"
} | IRCX_PROBE="$DIR/probe.log" node "$HARNESS" --release \
  --server "127.0.0.1:$HOLD" --join '#late' \
  > "$DIR/walk.log" 2>&1 || echo "    the walk exited $?"

kill "$HOLD_PID" 2>/dev/null || true
wait "$HOLD_PID" 2>/dev/null || true

echo "  $(grep -c ' >> .*CHATHISTORY BEFORE' "$DIR/wire.log" || true) page-backs asked, \
$(grep -c ' hold ' "$DIR/wire.log" || true) lines held"
python3 "$TREE/docs/end-to-end-30/pick.py" "$DIR"
