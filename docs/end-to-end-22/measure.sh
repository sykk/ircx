#!/usr/bin/env bash
# What each pane did across the three frames of the parked walk.
#
#     measure.sh <tree> <parked output directory> <runs>
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?parked output directory}
RUNS=${3:?how many}
SHIFT="$TREE/docs/end-to-end-22/paneshift.py"

for run in $(seq 1 "$RUNS"); do
  DIR="$OUT/run$run"
  echo "run$run"
  for pane in right left; do
    python3 "$SHIFT" "$pane" "$DIR/a-parked.png" "$DIR/b-one-page.png"
    python3 "$SHIFT" "$pane" "$DIR/b-one-page.png" "$DIR/c-two-pages.png"
  done
done
