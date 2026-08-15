#!/usr/bin/env bash
# The whole of run 30.
#
#     run.sh <tree> <output directory> <runs> <ergo port> <first hold port>
#
# Two arms, and they are not two builds. What is being walked is a path nothing
# has been down rather than a fix, so the control is the same binary on the same
# walk with the page held for twenty seconds instead of seventy-five: the client
# is still waiting for it when it lands, which is the ordinary case every other
# run has measured. What separates the arms is whether the client had given up,
# and nothing else — same channel, same wheel, same stillness before the
# landing.
#
# Without it a drift measured after the late page is a drift measured after a
# page, and the two are not the same claim.
#
# The binary is whatever is at target/release/ircx, built the way anybody builds
# it — `npm run tauri build -- --no-bundle`, no probe. Run 26's argument for why
# that is enough applies here unchanged: what is measured is a line in a
# screenshot rather than a rate, so there is nothing for an instrument to be
# inside.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
ERGO=${4:?ergo port}
HOLDS=${5:?first hold port}
HERE="$TREE/docs/end-to-end-30"
RUN23="$TREE/docs/end-to-end-23"
BINARY="$TREE/target/release/ircx"
# 75 is longer than `ROUND_TRIP_TIMEOUT`, by enough that the pane has been
# settled in the state of having given up for a good while before the page
# arrives. 20 is inside it by a margin as wide, and is the control.
LATE=75
INTIME=20

[ -x "$BINARY" ] || { echo "no binary at $BINARY" >&2; exit 1; }

mkdir -p "$OUT"
bash "$RUN23/ergo.sh" "$OUT" "$ERGO"

# Run 23's seed, for its channel rather than for its property. 400 lines is what
# leaves 200 behind the join's page of 200, so the page this walk holds is one
# the reader is genuinely owed — and the numbering is what lets a frame name the
# line at the top of the pane.
python3 "$RUN23/seed.py" "127.0.0.1:$ERGO" '#late' 400 > "$OUT/seed.log" 2>&1 &
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

# The arms alternate run by run, run 25's arrangement: a machine that gets busy
# halfway through a set otherwise gives one arm all the quiet.
for run in $(seq 1 "$RUNS"); do
  for arm in late intime; do
    case $arm in
      late) HELD=$LATE ;;
      intime) HELD=$INTIME ;;
    esac
    # A port per walk and none reused: one left in TIME_WAIT is a proxy that
    # never binds, and the walk behind it connects to nothing.
    echo "run $run $arm"
    bash "$HERE/straddle.sh" "$TREE" "$OUT/$arm/run$run" \
      $((HOLDS + 2 * run + $([ "$arm" = intime ] && echo 1 || echo 0))) "$ERGO" "$HELD"
  done
done

kill "$(cat "$OUT/seed.pid")" 2>/dev/null || true
rm -f "$OUT/seed.pid"
bash "$RUN23/stop.sh" "$OUT"
