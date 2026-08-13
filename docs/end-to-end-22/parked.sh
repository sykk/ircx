#!/usr/bin/env bash
# The pane that did not ask, parked off the live edge while the other one pages.
#
#     parked.sh <tree> <output directory> <runs> <first tap port> <ergo port>
#
# `walk.sh` leaves the second pane at the live edge, where a prepended page has
# nothing above the viewport to push and staying put is the follow path rather
# than the anchor. This parks it first: a few notches up the archive, so there is
# history above it and a row it can be measured against.
#
# Then the *other* pane pages back. Both panes read one `timelines[key]`, so
# `prependHistory` files 200 messages above a reader who did not ask for them and
# is not the one scrolling. Every walk in the paging arc drove one pane, so
# nothing has watched this.
#
# Three frames: parked, and after each of two bursts in the left pane. The right
# pane's top row is the measurement — the same `line NNNN` in all three is the
# anchor holding for a reader who asked for nothing.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
PORT=${4:?first tap port}
ERGO=${5:?ergo port}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
ASKS="$TREE/docs/end-to-end-22/asks.py"
TAP="$TREE/docs/end-to-end-22/tap.py"
mkdir -p "$OUT"

for run in $(seq 1 "$RUNS"); do
  DIR="$OUT/run$run"
  mkdir -p "$DIR"
  TAP_PORT=$((PORT + run))

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
    echo "run $run: no profile kept — see $DIR/first.log"
    kill "$TAP_PID" 2>/dev/null || true
    continue
  fi

  # 300 notches up the right pane is inside the archive the restore read, so it
  # parks without asking the server for anything: the asks in the log are the
  # left pane's alone, which is what makes the right pane's stillness readable.
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
    || echo "    run $run second launch exited $?"

  kill "$TAP_PID" 2>/dev/null || true
  wait "$TAP_PID" 2>/dev/null || true
  rm -rf "$PROFILE"

  python3 "$ASKS" "$DIR/wire.log"
done
