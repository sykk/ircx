#!/usr/bin/env bash
# The pane that did not ask, on a channel whose rows can change height.
#
#     parked.sh <tree> <output directory> <runs> <first tap port> <ergo port>
#
# Run 22's `parked.sh`, driving run 23's seed. The arrangement is unchanged
# because it is the arrangement #508 was measured in: two panes on one
# conversation, the right one parked a few notches up the archive with nobody
# touching it, and the left one paging back twice.
#
# What changed is underneath. Run 22's channel could not express a row that
# changes height once it has been drawn, and #511 and #512 between them ruled
# out five mechanisms without ever reaching one — the harness kept answering
# that the app is right, on a channel where the most likely cause was seeded
# out. `seed.py` here groups, so a landing page can regroup the window it lands
# above and a row already on the screen can gain or lose the line that names its
# topic.
#
# Three frames a run: parked, and after each of two bursts in the left pane.
# The right pane's own columns are the measurement, and stillness is `still.py`
# before it is `paneshift.py` — an offset that always answers is not evidence
# that anything moved.
#
# #511 is why the run count wants to be large: two arms of 72 landings could
# not tell 4 from 2, so an arm saying anything needs 70 landings and this walk
# takes two a run.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
PORT=${4:?first tap port}
ERGO=${5:?ergo port}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
ASKS="$TREE/docs/end-to-end-23/asks.py"
TAP="$TREE/docs/end-to-end-23/tap.py"
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

  # 300 notches up the right pane is inside the messages the restore read, so it
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
