#!/usr/bin/env bash
# The whole of run 26: the same walk on the build before #516 and on the build
# after it.
#
#     run.sh <tree> <output directory> <runs> <ergo port> <first hold port> \
#            <control binary> <fixed binary>
#
# The control is `main` with `src/components/timeline/Timeline.tsx` taken back
# to 9689a4f, the commit before the fix. Nothing else in the tree differs
# between the two arms — #517 changed that file and its test and nothing more —
# so the frames below differ by the fix or by nothing.
#
# Both arms are `npm run tauri build -- --no-bundle`, which is what anybody
# runs, and neither carries a probe. Run 25's caveat does not arise here for a
# second reason as well: what is measured is a sentence in a screenshot rather
# than a rate, so there is nothing for an instrument to be inside.
#
# The arms alternate run by run, run 25's arrangement, though this walk has far
# less to gain from it than a rate does.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
ERGO=${4:?ergo port}
HOLDS=${5:?first hold port}
CONTROL=${6:?control binary}
FIXED=${7:?fixed binary}
HERE="$TREE/docs/end-to-end-26"
RUN23="$TREE/docs/end-to-end-23"
BINARY="$TREE/target/release/ircx"

for arm in "$CONTROL" "$FIXED"; do
  [ -x "$arm" ] || { echo "no binary at $arm" >&2; exit 1; }
done

mkdir -p "$OUT"
bash "$RUN23/ergo.sh" "$OUT" "$ERGO"

# Run 23's seed, for its channel rather than for its property: what that seed
# is for is a page that regroups the window it lands above, and no page lands
# here. What is wanted is 400 lines so the join's page of 200 leaves 200 behind
# it, which is what makes the page-back this walk holds a page the reader is
# genuinely owed.
python3 "$RUN23/seed.py" "127.0.0.1:$ERGO" '#head' 400 > "$OUT/seed.log" 2>&1 &
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
    # A port per walk and none reused: one left in TIME_WAIT is a proxy that
    # never binds, and the walk behind it connects to nothing.
    echo "run $run $arm"
    bash "$HERE/walk.sh" "$TREE" "$OUT/$arm/run$run" \
      $((HOLDS + 2 * run + $([ "$arm" = fixed ] && echo 1 || echo 0))) "$ERGO"
  done
done

for arm in control fixed; do
  case $arm in
    control) cp -f "$CONTROL" "$BINARY" ;;
    fixed) cp -f "$FIXED" "$BINARY" ;;
  esac
  echo "midflight $arm"
  bash "$HERE/midflight.sh" "$TREE" "$OUT/$arm/midflight" \
    $((HOLDS + 2 * RUNS + 2 + $([ "$arm" = fixed ] && echo 1 || echo 0))) "$ERGO"
done

kill "$(cat "$OUT/seed.pid")" 2>/dev/null || true
rm -f "$OUT/seed.pid"
bash "$RUN23/stop.sh" "$OUT"

# The right pane between the frame before its neighbour asked and the frame
# during: the head, then the rows under it.
echo
echo "the pane that asked for nothing, while the pane beside it asks"
for arm in control fixed; do
  for run in $(seq 1 "$RUNS"); do
    DIR="$OUT/$arm/run$run"
    printf '%-8s run%-3s %s\n' "$arm" "$run" \
      "$(python3 "$HERE/head.py" right "$DIR/2-right-owed.png" "$DIR/3-left-asking.png")"
  done
done
