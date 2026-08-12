#!/usr/bin/env bash
# Runs the two-launch walk a few times and counts the page-backs that repeat one.
#
#     dupes.sh <tree> <output directory> <runs> <first tap port>
#
# One run is an anecdote: the duplicate is a race and a build can win it. This
# is the same walk over again against one binary, so the two builds can be put
# beside each other with a count rather than with a reading of one log.
#
# A repeat is two `CHATHISTORY BEFORE` naming the same msgid. Nothing else in
# the log is being judged — the walk asks for four or five pages depending on
# where the scroll lands, and how many is not the question.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:-3}
PORT=${4:-6710}

mkdir -p "$OUT"

for run in $(seq 1 "$RUNS"); do
  TAP_PORT=$((PORT + run)) timeout 400 "$TREE/docs/end-to-end-16/wire.sh" \
    "$OUT/run$run" > "$OUT/run$run.log" 2>&1 || echo "run $run exited $?"

  asks=$(grep -oE "CHATHISTORY BEFORE \S+ msgid=\S+" "$OUT/run$run/wire.log" \
         | awk '$0 ~ /msgid/ {print $NF}' || true)
  total=$(printf '%s\n' "$asks" | grep -c . || true)
  distinct=$(printf '%s\n' "$asks" | sort -u | grep -c . || true)
  echo "run $run: $total page-backs, $distinct distinct, $((total - distinct)) repeated"
done
