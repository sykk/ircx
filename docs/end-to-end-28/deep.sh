#!/usr/bin/env bash
# Reads a channel from its live edge to the true start of its history.
#
#     deep.sh <tree> <output directory> <walks> <proxy port> [--load]
#
# Every paging walk since run 12 has been made on a channel whose history ran
# out in two asks. Run 17 said so and asked for one with a dozen behind it;
# `depth.py` is what says #scrollback now has eleven pages, at ergo's own
# `channel-length` ceiling. This is the walk that spends them.
#
# What that buys, which no shorter walk can: a *chain*. Ten page-backs, each
# arming the `#487` guard and each disarmed by the batch that answers it, and
# then an eleventh whose answer is short — the server's history running out,
# which the pane draws as "Beginning of history". Two failures live in a chain
# and not in a count: a link asked twice, and a link that stops early and leaves
# the reader short of history the server still holds. `chain.py` reads both off
# the wire.
#
# The proxy is run 27's under `--pass`, which replaces nothing and is here only
# to write the log. Using the instrument that found #522 to watch the fix work
# is the point: an instrument that cannot show the working case is not evidence
# about the broken one.
#
# `--load` is the ordering arm. The batch and the page-back's outcome cross to
# the webview on different channels, and run 27 saw the batch first every time
# on an idle machine. Load is the only lever that moves either — the profile is
# on tmpfs and the socket is local, so nothing else here is slow enough to
# reorder them. Both orders are asserted in the suite and converge; what this
# arm asks is whether a machine under contention finds a third one.
#
# The wheel goes up and only up, unlike run 27's bursts. That walk had to raise
# a scroll event against a scroller already clamped at the top, which needs a
# trip down first. Here every page that lands puts content above the reader, so
# the scroller is off its clamp again by the time the next burst starts.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
WALKS=${3:?how many}
PORT=${4:?proxy port}
LOAD=${5:-}

HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
# Room for eleven pages and three bursts of slack, so a walk that stalls is a
# stall rather than a walk that ran out of wheel.
BURSTS=14
mkdir -p "$OUT"

python3 "$HERE/../end-to-end-27/replaypage.py" "$PORT" 127.0.0.1:6677 "$OUT/wire.log" --pass &
PROXY=$!
SPINNERS=()
if [ "$LOAD" = "--load" ]; then
  # Thirty-two on sixteen cores, which is run 22's level: it changed the app's
  # behaviour where sixteen did not.
  for _ in $(seq 32); do
    bash -c 'while :; do :; done' &
    SPINNERS+=($!)
  done
  echo "=== 32 spinners up"
fi
cleanup() {
  kill "$PROXY" "${SPINNERS[@]}" 2>/dev/null || true
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
    for burst in $(seq "$BURSTS"); do
      echo "wheel 660 400 -1600"
      echo "wait 4000"
      if [ "$burst" = 5 ]; then echo "ss $OUT/w$walk-b-midway.png"; fi
    done
    echo "ss $OUT/w$walk-c-start.png"
    echo "quit"
  } | node "$HARNESS" --release --server "127.0.0.1:$PORT" --join '#scrollback' \
    > "$OUT/w$walk.log" 2>&1 || echo "    walk $walk exited $?"

  grep -c '^ *[0-9.]* ask ' "$OUT/wire.log" | xargs echo "    asks on the wire so far:"
done

echo "=== the chain"
python3 "$HERE/chain.py" "$OUT/wire.log" | tee "$OUT/chain.txt"
