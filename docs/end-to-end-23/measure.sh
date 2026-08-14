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
#
# `differs` is not `moved`, which is why every landing that differs is handed to
# `paneshift.py` rather than counted as a shift. What it usually is instead is
# the group's spine, and the topic over a run, changing where the landing page
# regrouped the window — run 23 photographed it (`run2-spine-only.png`) and run
# 25 counted it, 22 of the 33 differing landings across both its arms and not
# one of them moving any text.
#
# This said the cause was the head that says a page is loading, drawn in a pane
# that had not asked because `loadingOlder` belonged to the conversation. Two
# things are wrong with that. #516 made the line the pane's own in August 2026,
# and the head could not have been it here anyway: the parked pane sits some 720
# lines below the top of its own content, so that row is far above the fold and
# has no pixels on screen to change.
#
# `docs/end-to-end-25/tally.py` is where the three states are counted, and it
# does not trust `paneshift.py` for the third — see its own note.
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
