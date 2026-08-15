#!/usr/bin/env bash
# One walk of run 32: three page-backs, the first of them answered last.
#
#     wedge.sh <tree> <output directory> <hold port> <ergo port> <when> <target dir>
#
# The walk is #540's sequence driven rather than waited for. Every step of it is
# a wheel that reaches the top of the pane, because that is what makes a client
# ask; `twoasks.py` does the rest by holding the first answer until the third
# ask has gone out.
#
#   1. wheel to the top          the first ask, and it is held
#   2. seventy seconds           `ROUND_TRIP_TIMEOUT` is sixty, so the client
#                                gives up and draws "The server has not sent
#                                this page yet"
#   3. wheel to the top          the second ask — same message, second label —
#                                answered at once, and the reader reads it
#   4. wheel to the top          the third ask, behind the page that just
#                                landed, answered at once as well
#   5. the first answer lands    carrying the page step 3 already delivered.
#                                `<when>` says where against step 4 it falls,
#                                and that is the difference between this run's
#                                two timings rather than anything the walk does
#   6. wheel to the top          **the reading.** A fourth ask is a reader whose
#                                history did not end.
#
# The wheel is preceded by three notches down every time. A pane already at the
# top of its scroller raises no scroll event for a wheel up, and no scroll event
# is no `loadOlder` — so a burst that walks up from nothing is a burst that asks
# nothing, whatever it looks like. The three notches are the room the burst
# needs, and the burst is long enough to give them back.
#
# The binary is at <target dir>/release/ircx, which is `CARGO_TARGET_DIR` as
# `window.mjs` reads it. Run 32 has two builds to walk and swapping one file
# under `target/` between them is how a set ends up half measured on the other
# one; a directory per arm cannot.
#
# `IRCX_PROBE` is set whatever build this is. A build without the probe compiled
# in never calls the command, and one with it needs somewhere to write before it
# has anything to say — so naming the file here costs the plain builds nothing
# and saves the instrumented ones from being walked with the instrument off.
set -euo pipefail

TREE=${1:?tree}
DIR=${2:?output directory}
HOLD=${3:?hold port}
ERGO=${4:?ergo port}
WHEN=${5:?when to let the held answer go}
TARGET=${6:?target dir}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$DIR"

python3 "$TREE/docs/end-to-end-32/twoasks.py" "$HOLD" "127.0.0.1:$ERGO" "$DIR/wire.log" \
  "$WHEN" > "$DIR/hold.log" 2>&1 &
HOLD_PID=$!
sleep 1

# Frames every two seconds from the third ask onwards, and `read.py` chooses
# against the epoch the proxy stamps on its own release rather than against this
# script's arithmetic: a burst that takes ten seconds to reach the top of the
# pane moves the release ten seconds with it, and a frame named in advance would
# be the wrong one.
{
  echo "wait 9000"
  echo "wheel 600 400 -1200"
  echo "wait 2000"
  echo "ss $DIR/asked.png"
  echo "wait 70000"
  echo "ss $DIR/waiting.png"
  for step in replaced paged; do
    echo "wheel 600 400 3"
    echo "wait 500"
    echo "wheel 600 400 -1200"
    echo "wait 3000"
    echo "ss $DIR/$step.png"
  done
  for n in $(seq -w 1 12); do
    echo "ss $DIR/frame-$n.png"
    echo "wait 2000"
  done
  echo "wheel 600 400 3"
  echo "wait 500"
  echo "wheel 600 400 -1200"
  echo "wait 4000"
  echo "ss $DIR/asking-again.png"
  echo "quit"
} | CARGO_TARGET_DIR="$TARGET" IRCX_PROBE="$DIR/probe.log" node "$HARNESS" --release \
  --server "127.0.0.1:$HOLD" --join '#wedge' \
  > "$DIR/walk.log" 2>&1 || echo "    the walk exited $?"

kill "$HOLD_PID" 2>/dev/null || true
wait "$HOLD_PID" 2>/dev/null || true

python3 "$TREE/docs/end-to-end-32/read.py" "$DIR"
