#!/usr/bin/env bash
# Run 17's own walk, on a channel with depth behind it.
#
#     twobursts.sh <tree> <output directory> <runs> <proxy port> [--load]
#
# `revisit.sh` reads to the start of the channel, which takes fourteen bursts
# and about a minute a run. Run 17's count came from run 16's walk, which is
# two bursts and over in seventeen seconds — so what it counted was how many
# pages a build takes in its first seconds, and a walk that lets both builds
# reach the top counts the channel rather than the build.
#
# Same two launches and same channel as `revisit.sh`; the only difference is
# that this one stops where run 17 stopped. It is what says whether six against
# two was the builds or the walk.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
PORT=${4:?proxy port}
LOAD=${5:-}

HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$OUT"

python3 "$HERE/../end-to-end-27/replaypage.py" "$PORT" 127.0.0.1:6677 "$OUT/wire.log" --pass &
PROXY=$!
SPINNERS=()
if [ "$LOAD" = "--load" ]; then
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

for run in $(seq -w 1 "$RUNS"); do
  echo "=== run $run"
  BEFORE=$(grep -c '^ *[0-9.]* ask ' "$OUT/wire.log" || true)
  PROFILE=$(
    {
      echo "wait 9000"
      echo "quit"
    } | node "$HARNESS" --release --server "127.0.0.1:$PORT" --join '#scrollback' --keep \
      2>&1 | tee "$OUT/r$run-first.log" | sed -n 's/^ok profile kept at //p'
  )
  [ -n "$PROFILE" ] || { echo "    no profile kept — see $OUT/r$run-first.log"; continue; }

  {
    echo "wait 10000"
    echo "wheel 660 400 -1600"
    echo "wait 3000"
    echo "wheel 660 400 -1600"
    echo "wait 4000"
    echo "ss $OUT/r$run-second.png"
    echo "quit"
  } | node "$HARNESS" --release --profile "$PROFILE" > "$OUT/r$run-second.log" 2>&1 \
    || echo "    second launch exited $?"
  rm -rf "$PROFILE"

  AFTER=$(grep -c '^ *[0-9.]* ask ' "$OUT/wire.log" || true)
  echo "    asks this run: $((AFTER - BEFORE))"
done

echo "=== what each ask named"
python3 "$HERE/reach.py" "$OUT/wire.log" | tee "$OUT/reach.txt"
