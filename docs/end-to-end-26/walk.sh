#!/usr/bin/env bash
# The head of a pane that asked for nothing, while the pane beside it pages.
#
#     walk.sh <tree> <output directory> <hold port> <ergo port>
#
# Two panes on one channel, the same arrangement #508 was measured in, asking
# the other question about it: not where the pane that did not ask ends up, but
# what its head says while it is there. #516 is that it said the reader's
# history was loading.
#
# The right pane is walked to the top first and left there. Its own page-back
# goes out, is held by `holdpage.py`, and a minute later the client gives up
# waiting on the round trip — which leaves the pane parked at the top of its
# content with a head of its own ("The server has not sent this page yet"),
# owed a page it did not get, and asking for nothing further. That is the state
# the frames are taken in, and it is stable: no page lands, so nothing moves,
# and a pane that is not scrolled asks for nothing.
#
# The minute is `ROUND_TRIP_TIMEOUT` in `src-tauri/src/state.rs` and is what
# sets this walk's pace. The five seconds beside it are the enqueue's, not the
# server's.
#
# Then the left pane is walked to the top, where it asks, and the right pane's
# head through the minute that follows is the measurement. It reads "The server
# has not sent this page yet" on a build that says a page is loading only in the
# pane that asked for it, and "Loading older messages" on one that reads the
# line off the conversation.
#
# The binary is not chosen here — `window.mjs --release` drives
# target/release/ircx and builds nothing — so the caller puts the arm there.
set -euo pipefail

TREE=${1:?tree}
DIR=${2:?output directory}
HOLD=${3:?hold port}
ERGO=${4:?ergo port}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$DIR"

python3 "$TREE/docs/end-to-end-26/holdpage.py" "$HOLD" "127.0.0.1:$ERGO" "$DIR/wire.log" \
  > "$DIR/hold.log" 2>&1 &
HOLD_PID=$!
sleep 1

# 1200 notches is more than the height of what the join page draws, so both
# wheels end against the top of the content rather than at a counted offset:
# what matters is that the pane is at the top, not how it got there. A wheel
# that changes nothing raises no scroll event, so reaching the top is also
# where the asking stops. 400 was not enough — a pane of this split is narrow
# enough that a message wraps to three lines, and the 200 the join page brings
# are some 14,000px of them at 16px a notch.
{
  echo "wait 9000"
  echo "key ctrl+backslash"
  echo "wait 4000"
  echo "wheel 880 400 -1200"
  echo "ss $DIR/1-right-asking.png"
  echo "wait 62000"
  echo "ss $DIR/2-right-owed.png"
  echo "wheel 400 400 -1200"
  echo "wait 1200"
  echo "ss $DIR/3-left-asking.png"
  echo "wait 62000"
  echo "ss $DIR/4-both-owed.png"
  echo "quit"
} | node "$HARNESS" --release --server "127.0.0.1:$HOLD" --join '#head' \
  > "$DIR/walk.log" 2>&1 || echo "    the walk exited $?"

kill "$HOLD_PID" 2>/dev/null || true
wait "$HOLD_PID" 2>/dev/null || true

echo "$(grep -c ' >> .*CHATHISTORY BEFORE' "$DIR/wire.log" || true) page-backs asked, \
$(grep -c ' held ' "$DIR/wire.log" || true) lines held of \
$(wc -l < "$DIR/wire.log") in $DIR/wire.log"
