#!/usr/bin/env bash
# Reads to the top of a channel whose page-back the server never answers, and
# then tries to read further.
#
#     wedge.sh <tree> <output directory> <walks> <proxy port> [--pass]
#
# The state under test is one the fix and the build before it disagree about.
# The client reaches the end of its archive, asks the server for the page
# behind its oldest message, and nothing comes back. Sixty seconds later
# `page_back` answers `waiting`, and from there the two builds part:
#
#   before  `askedBehind` still names the pane's oldest message, so the #487
#           guard refuses every later scroll. One ask, for the rest of the run.
#   after   `waiting` is the round trip already spent, so the guard comes off
#           and the next scroll to the top asks again.
#
# So the count is the whole result — `asks=` on the log's last line — and it is
# not a race. Three walks a build is enough where run 17 needed forty, because
# nothing here is timing-dependent except a deadline this waits out.
#
# Two things the walk has to get right:
#
#   * A wheel at `scrollTop` 0 raises no `scroll` event, and `onScroll` is what
#     asks. The scroller is already clamped at the top when the deadline
#     passes, so the second burst goes *down* first and then back up. A walk
#     that only wheels up again measures nothing on either build.
#   * The page never lands, so nothing moves the content between the bursts.
#     Coordinates that worked before the wait still work after it.
#
# `--pass` swallows nothing, and is how the walk is read against a server that
# does answer: the same bursts, the page arriving, and the ask count that a
# working page-back produces.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
WALKS=${3:?how many}
PORT=${4:?proxy port}
PASSING=${5:-}

HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$OUT"

python3 "$HERE/holdpage.py" "$PORT" 127.0.0.1:6677 "$OUT/wire.log" $PASSING &
PROXY=$!
cleanup() {
  kill "$PROXY" 2>/dev/null || true
  wait "$PROXY" 2>/dev/null || true
}
trap cleanup EXIT
sleep 1

for walk in $(seq -w 1 "$WALKS"); do
  echo "=== walk $walk"
  {
    # The join's own CHATHISTORY LATEST has to have filled the pane before
    # anything is scrolled, or the walk reads a pane holding only the join.
    echo "wait 9000"
    echo "ss $OUT/w$walk-a-foot.png"

    # To the top, over-scrolling rather than counting notches: a notch is not
    # one number between panes and the scroller clamps.
    echo "wheel 660 400 -1600"
    echo "wait 3000"
    echo "ss $OUT/w$walk-b-top.png"

    # The round trip's own deadline is sixty seconds, and it starts when the
    # ask reaches the server rather than when this walk began. Five seconds of
    # slack for the reading and the scrolling in front of it.
    echo "wait 65000"
    echo "ss $OUT/w$walk-c-waited.png"

    # Down and back up, which is what raises a scroll event at the top.
    echo "wheel 660 400 12"
    echo "wait 1500"
    echo "wheel 660 400 -40"
    echo "wait 5000"
    echo "ss $OUT/w$walk-d-asked-again.png"

    echo "quit"
  } | node "$HARNESS" --release --server "127.0.0.1:$PORT" --join '#scrollback' \
    > "$OUT/w$walk.log" 2>&1 || echo "    walk $walk exited $?"

  grep -c '^ *[0-9.]* ask ' "$OUT/wire.log" | xargs echo "    asks on the wire so far:"
done

echo "=== asks, and what the proxy did with the answers"
grep -E '^ *[0-9.]+ (ask|end) ' "$OUT/wire.log" | tee "$OUT/asks.txt"
