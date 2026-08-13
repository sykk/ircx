#!/usr/bin/env bash
# The whole of run 23, from an empty directory to a table.
#
#     run.sh <tree> <output directory> <runs> <ergo port> <first tap port>
#
# Run 22 started its server and its seeder by hand and wrote the order down in
# prose. This is that order, because the order is load-bearing: ergo has to be
# listening before the seeder connects, the seeders have to stay resident or the
# channel is destroyed and the history with it, and the walk has to find 800
# lines already in the channel or the panes have nothing to page back through.
#
# The seeder is left running for the length of the walk and killed at the end,
# which is what `stop.sh` and the pid file are for.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
ERGO=${4:?ergo port}
TAPS=${5:?first tap port}
HERE="$TREE/docs/end-to-end-23"

mkdir -p "$OUT"
bash "$HERE/ergo.sh" "$OUT" "$ERGO"

python3 "$HERE/seed.py" "127.0.0.1:$ERGO" '#restore' 800 > "$OUT/seed.log" 2>&1 &
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
bash "$HERE/stop.sh" "$OUT"

bash "$HERE/measure.sh" "$TREE" "$OUT/parked" "$RUNS" | tee "$OUT/shifts.txt"
