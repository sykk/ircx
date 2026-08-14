#!/usr/bin/env bash
# The whole of run 24, from an empty directory to a table and a ledger.
#
#     run.sh <tree> <output directory> <runs> <ergo port> <first tap port>
#
# Run 23's order, because the order is load-bearing in the same way: ergo
# listening before the seeder connects, the seeder resident for the length of
# the walk or the channel is destroyed with its history, and 800 lines in the
# channel before the first launch.
#
# What this run adds is at the end. `measure.sh` is run 23's and answers the
# same question its table answered — how many landings moved the parked pane —
# and it is asked first for the reason the report leads on: the app being
# measured has an instrument compiled into it, so a rate that has moved means
# the instrument is the experiment. `explain.sh` then reads the window's own
# records for every landing that moved.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
ERGO=${4:?ergo port}
TAPS=${5:?first tap port}
HERE="$TREE/docs/end-to-end-24"
RUN23="$TREE/docs/end-to-end-23"

mkdir -p "$OUT"
bash "$RUN23/ergo.sh" "$OUT" "$ERGO"

python3 "$RUN23/seed.py" "127.0.0.1:$ERGO" '#restore' 800 > "$OUT/seed.log" 2>&1 &
echo $! > "$OUT/seed.pid"
for _ in $(seq 60); do
  grep -q "^seeded " "$OUT/seed.log" && break
  sleep 1
done
grep -q "^seeded " "$OUT/seed.log" || {
  echo "the seeder never finished; see $OUT/seed.log" >&2
  exit 1
}
cat "$OUT/seed.log"

bash "$HERE/parked.sh" "$TREE" "$OUT/parked" "$RUNS" "$TAPS" "$ERGO"

kill "$(cat "$OUT/seed.pid")" 2>/dev/null || true
rm -f "$OUT/seed.pid"
bash "$RUN23/stop.sh" "$OUT"

bash "$RUN23/measure.sh" "$TREE" "$OUT/parked" "$RUNS" | tee "$OUT/shifts.txt"
bash "$HERE/explain.sh" "$TREE" "$OUT/parked" "$OUT/shifts.txt" | tee "$OUT/ledger.txt"
