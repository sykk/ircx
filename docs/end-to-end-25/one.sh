#!/usr/bin/env bash
# One run of run 23's parked walk, against whichever binary is at target/release.
#
#     one.sh <tree> <output directory> <tap port> <ergo port>
#
# Run 23's `parked.sh` loops over runs itself, and run 25 needs the loop outside
# so the two arms can alternate inside it — a control and a fix taken half an
# hour apart on a shared machine differ by the machine as well as by the build,
# and run 24's arms ran back to back. So this is that loop's body, once.
#
# Everything in it is run 23's and must stay so: the same channel, the same
# arrangement, the same notch counts, the same three frames. A rate is only
# comparable to one taken the same way, and the rates this run is read against
# are run 23's 2 in 72 and run 24's 6 in 100.
#
# The binary is not chosen here. `window.mjs --release` drives `target/release/
# ircx` and builds nothing, so the caller puts the arm's build there first.
set -euo pipefail

TREE=${1:?tree}
DIR=${2:?output directory}
TAP_PORT=${3:?tap port}
ERGO=${4:?ergo port}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
ASKS="$TREE/docs/end-to-end-23/asks.py"
TAP="$TREE/docs/end-to-end-23/tap.py"
mkdir -p "$DIR"

python3 "$TAP" "$TAP_PORT" "127.0.0.1:$ERGO" "$DIR/wire.log" &
TAP_PID=$!
sleep 1

PROFILE=$(
  {
    echo "wait 9000"
    echo "key ctrl+backslash"
    echo "wait 2500"
    echo "quit"
  } | node "$HARNESS" --release --server "127.0.0.1:$TAP_PORT" \
        --join '#restore' --keep 2>&1 \
    | tee "$DIR/first.log" \
    | sed -n 's/^ok profile kept at //p'
)

if [ -z "$PROFILE" ]; then
  echo "no profile kept — see $DIR/first.log"
  kill "$TAP_PID" 2>/dev/null || true
  exit 0
fi

# 300 notches up the right pane is inside the messages the restore read, so it
# parks without asking the server for anything: the asks in the log are the left
# pane's alone, which is what makes the right pane's stillness readable.
{
  echo "wait 12000"
  echo "wheel 880 400 -300"
  echo "wait 2500"
  echo "ss $DIR/a-parked.png"
  echo "wheel 400 400 -1600"
  echo "wait 3500"
  echo "ss $DIR/b-one-page.png"
  echo "wheel 400 400 -1600"
  echo "wait 3500"
  echo "ss $DIR/c-two-pages.png"
  echo "quit"
} | node "$HARNESS" --release --profile "$PROFILE" > "$DIR/second.log" 2>&1 \
  || echo "    second launch exited $?"

kill "$TAP_PID" 2>/dev/null || true
wait "$TAP_PID" 2>/dev/null || true
rm -rf "$PROFILE"

python3 "$ASKS" "$DIR/wire.log"
