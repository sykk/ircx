#!/usr/bin/env bash
# The whole of run 25: two builds of the shipping app, alternating, on one
# server and one seed.
#
#     run.sh <tree> <output directory> <runs> <ergo port> <first tap port> \
#            <control binary> <fixed binary>
#
# Run 24 measured #508 on a build with a probe compiled into it and said so:
# "the build measured here is not the build that ships". Both binaries here are
# `npm run tauri build -- --no-bundle` with no `VITE_PROBE`, which is what
# anybody runs. The control is the tree at fd85cb8, the commit run 24's control
# arm was taken on; the fix is main, which carries #515 and #516.
#
# The arms alternate rather than following one another. Run 24's ran back to
# back, so any drift in the machine over the hour between them — another
# session's build, the fan — is inside its p-value. Alternating puts that drift
# in both arms.
#
# The order of the server and the seeder is run 23's, and load-bearing for its
# reasons: ergo listening before the seeder connects, the seeder resident for
# the length of the walk or the channel is destroyed with its history, and 800
# lines in the channel before the first launch.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
ERGO=${4:?ergo port}
TAPS=${5:?first tap port}
CONTROL=${6:?control binary}
FIXED=${7:?fixed binary}
HERE="$TREE/docs/end-to-end-25"
RUN23="$TREE/docs/end-to-end-23"
BINARY="$TREE/target/release/ircx"

for arm in "$CONTROL" "$FIXED"; do
  [ -x "$arm" ] || { echo "no binary at $arm" >&2; exit 1; }
done

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

for run in $(seq 1 "$RUNS"); do
  for arm in control fixed; do
    case $arm in
      control) cp -f "$CONTROL" "$BINARY" ;;
      fixed) cp -f "$FIXED" "$BINARY" ;;
    esac
    # Two taps per run and none reused: a port in TIME_WAIT from the run before
    # is a tap that never binds, and the walk that follows it reads a wire log
    # of nothing.
    echo "run $run $arm"
    bash "$HERE/one.sh" "$TREE" "$OUT/$arm/run$run" \
      $((TAPS + 2 * run + $([ "$arm" = fixed ] && echo 1 || echo 0))) "$ERGO"
  done
done

kill "$(cat "$OUT/seed.pid")" 2>/dev/null || true
rm -f "$OUT/seed.pid"
bash "$RUN23/stop.sh" "$OUT"

for arm in control fixed; do
  bash "$RUN23/measure.sh" "$TREE" "$OUT/$arm" "$RUNS" | tee "$OUT/$arm-shifts.txt"
done
python3 "$HERE/tally.py" "$OUT/control-shifts.txt" "$OUT/fixed-shifts.txt" "$OUT" \
  | tee "$OUT/table.txt"
