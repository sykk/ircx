#!/usr/bin/env bash
# What the parked pane did across the three frames of each run.
#
#     measure.sh <tree> <parked output directory> <runs>
#
# Stillness first. `still.py` answers whether the pane's own columns are
# pixel-for-pixel what they were, and only a pane already known to have changed
# is handed to `paneshift.py` to have the size of it named. Run 22's measurement
# went the other way round and #510's control found what that costs: an offset
# of -202px, residual 0.00, over a pane that had not moved at all.
#
# Two landings a run, which is the unit #511 says to count in.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?parked output directory}
RUNS=${3:?how many}
STILL="$TREE/docs/end-to-end-23/still.py"
SHIFT="$TREE/docs/end-to-end-23/paneshift.py"

for run in $(seq 1 "$RUNS"); do
  DIR="$OUT/run$run"
  [ -f "$DIR/c-two-pages.png" ] || { echo "run$run incomplete"; continue; }
  for landing in "a-parked b-one-page" "b-one-page c-two-pages"; do
    set -- $landing
    verdict=$(python3 "$STILL" right "$DIR/$1.png" "$DIR/$2.png")
    if [ "$verdict" = "still" ]; then
      echo "run$run $1->$2  0px"
    else
      echo "run$run $1->$2  $verdict  $(python3 "$SHIFT" right "$DIR/$1.png" "$DIR/$2.png")"
    fi
  done
done
