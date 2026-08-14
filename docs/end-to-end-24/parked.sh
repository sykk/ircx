#!/usr/bin/env bash
# Run 23's walk, with the window saying what it did.
#
#     parked.sh <tree> <output directory> <runs> <first tap port> <ergo port>
#
# The arrangement, the channel, the notch counts and the three frames are run
# 23's, unchanged and deliberately so: run 23 measured 2 moves in 72 landings on
# exactly this walk, and a rate is only comparable to one taken the same way.
# What is new is inside the app — `IRCX_PROBE` names a file the window appends a
# record to on every commit of either timeline, so a landing can be read from
# the inside rather than photographed from the outside.
#
# The scripts that are not the instrument are run 23's own, by path. Copying
# them would put a second `seed.py` in the tree whose only job is to be
# identical to the first, and the comparison is worth more than the tidiness of
# a self-contained directory.
#
# Two logs a run, because there are two launches and only the second is walked:
# `first-probe.log` is the profile being seeded and `probe.log` is the walk.
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
    } | IRCX_PROBE="$DIR/first-probe.log" node "$HARNESS" --release \
          --server "127.0.0.1:$TAP_PORT" --join '#restore' --keep 2>&1 \
      | tee "$DIR/first.log" \
      | sed -n 's/^ok profile kept at //p'
  )

  if [ -z "$PROFILE" ]; then
    echo "run $run: no profile kept — see $DIR/first.log"
    kill "$TAP_PID" 2>/dev/null || true
    continue
  fi

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
  } | IRCX_PROBE="$DIR/probe.log" node "$HARNESS" --release --profile "$PROFILE" \
      > "$DIR/second.log" 2>&1 \
    || echo "    run $run second launch exited $?"

  kill "$TAP_PID" 2>/dev/null || true
  wait "$TAP_PID" 2>/dev/null || true
  rm -rf "$PROFILE"

  python3 "$ASKS" "$DIR/wire.log"
done
