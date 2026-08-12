#!/usr/bin/env bash
# Run 16's two-launch walk, counted, with the machine contended.
#
#     dupes-loaded.sh <tree> <output directory> <runs> <first tap port> [spinners]
#
# `dupes.sh` is run 16's and this adds one thing to it: the load that made #494
# appear. #496's duplicate is a race too — the `#487` guard compares the live
# head against an `askedBehind` that may name a row which is not the head — so
# the same contention that stretches the archive read should widen this window
# as well. Run 16 saw the duplicate once in four runs unloaded, and said four
# against four cannot tell one-in-four from none.
#
# The count is `ahead.py`'s `repeat` rather than `dupes.sh`'s own grep, because
# it is the same reader the other arm uses and it was checked against run 16's
# `control-duplicate.txt` before it was pointed at anything new.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
PORT=${4:?first tap port}
SPINNERS=${5:-32}

HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"

SPIN=()
for _ in $(seq 1 "$SPINNERS"); do
  bash -c 'while :; do :; done' &
  SPIN+=($!)
done
cleanup() {
  kill "${SPIN[@]}" 2>/dev/null || true
  wait "${SPIN[@]}" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== $RUNS two-launch runs under $SPINNERS spinners on $(nproc) cores"
for run in $(seq 1 "$RUNS"); do
  TAP_PORT=$((PORT + run)) timeout 600 "$TREE/docs/end-to-end-16/wire.sh" "$OUT/run$run" \
    > "$OUT/run$run.log" 2>&1 || echo "run $run exited $?"
  if [ -s "$OUT/run$run/wire.log" ]; then
    printf 'run %2d: ' "$run"
    python3 "$HERE/ahead.py" "$OUT/run$run/wire.log" | tail -4 | tr '\n' ' '
    echo
  else
    echo "run $run: no wire log"
  fi
done
