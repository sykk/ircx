#!/usr/bin/env bash
# The window's own account of every landing the frames say moved.
#
#     explain.sh <tree> <parked output directory> <shifts.txt>
#
# `measure.sh` decides what moved, from the outside, and this asks the inside
# about those and only those. Both halves are printed for each: a landing where
# the photographs and the records disagree is the instrument being wrong, and
# the point of printing them together is that it cannot pass unnoticed.
#
# A landing that measured still is asked too, one per run, as the control that
# says the ledger reads 0 where the pixels do.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?parked output directory}
SHIFTS=${3:?shifts.txt}
READ="$TREE/docs/end-to-end-24/read.py"

while read -r run landing verdict rest; do
  DIR="$OUT/$run"
  before=${landing%%->*}
  after=${landing##*->}
  [ -f "$DIR/probe.log" ] || { echo "== $run $landing: no probe.log"; continue; }
  case "$verdict" in
    0px)
      # One still landing an app is enough to say the ledger agrees with the
      # pixels; printing every one of them buries the ones that moved.
      [ "$before" = "a-parked" ] || continue
      echo "== $run $landing — the frames say still"
      ;;
    *)
      echo "== $run $landing — the frames say $verdict $rest"
      ;;
  esac
  python3 "$READ" "$DIR/probe.log" "$DIR/$before.png" "$DIR/$after.png" || true
  echo
done < "$SHIFTS"
