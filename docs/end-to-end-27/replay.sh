#!/usr/bin/env bash
# Reads to the top of a channel whose page-back is answered with what the reader
# already has, and then tries to read further.
#
#     replay.sh <tree> <output directory> <walks> <proxy port> [--pass]
#
# The state under test is one #522 and the build before it disagree about. The
# client reaches the end of its archive, asks the server for the page behind its
# oldest message, and the answer arrives — carrying the two hundred messages it
# was sent when it joined. Nothing in it is new, so nothing moves, and from
# there the two builds part:
#
#   before  `askedBehind` still names the pane's oldest message, because the
#           only thing that took it off was that message moving. The #487 guard
#           refuses every later scroll. One ask, for the rest of the run.
#   after   the batch is what takes the guard off, so the next scroll to the top
#           asks again.
#
# So the count is the whole result — `asks=` on the log's last line.
#
# What this walk does *not* have to wait for is run 18's sixty seconds. That
# walk's page never came, so its result was a deadline expiring; this one's
# comes back inside the round trip. The wedge is immediate, and so is the retry.
#
# The rest is run 18's `wedge.sh`, and for its reasons:
#
#   * A wheel at `scrollTop` 0 raises no `scroll` event, and `onScroll` is what
#     asks. The scroller is already clamped at the top, so a burst goes *down*
#     first and then back up. A walk that only wheels up again measures nothing
#     on either build.
#   * Nothing lands between the bursts, on either build, so coordinates that
#     worked before one still work after it.
#
# Two bursts rather than run 18's one, because the retry here costs no deadline:
# a build that asks again can be watched doing it twice, and a build that has
# stopped asking is that much more clearly stopped.
#
# `--pass` replaces nothing, and is how the walk is read against a server whose
# page carries history: the same bursts, the pages arriving, and the ask count a
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

python3 "$HERE/replaypage.py" "$PORT" 127.0.0.1:6677 "$OUT/wire.log" $PASSING &
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
    echo "wait 6000"
    echo "ss $OUT/w$walk-b-answered.png"

    # Down and back up, which is what raises a scroll event at the top.
    echo "wheel 660 400 12"
    echo "wait 1500"
    echo "wheel 660 400 -40"
    echo "wait 6000"
    echo "ss $OUT/w$walk-c-asked-again.png"

    # And again, because a retry that happens once could be a coincidence of
    # where the scroller landed.
    echo "wheel 660 400 12"
    echo "wait 1500"
    echo "wheel 660 400 -40"
    echo "wait 6000"
    echo "ss $OUT/w$walk-d-asked-again.png"

    echo "quit"
  } | node "$HARNESS" --release --server "127.0.0.1:$PORT" --join '#scrollback' \
    > "$OUT/w$walk.log" 2>&1 || echo "    walk $walk exited $?"

  grep -c '^ *[0-9.]* ask ' "$OUT/wire.log" | xargs echo "    asks on the wire so far:"
done

echo "=== asks, and what the proxy did with the answers"
grep -E '^ *[0-9.]+ (ask|end|~~ ) ' "$OUT/wire.log" | tee "$OUT/asks.txt"
