#!/usr/bin/env bash
# The whole of run 32.
#
#     run.sh <tree> <output directory> <runs> <ergo port> <first hold port> <builds> <when>...
#
# **The arms are two builds, which runs 30 and 31 did not need and this one
# cannot do without.** Those walked a path nothing had been down, so the same
# binary under a different delay was the control. This walks a fix, and a walk
# that passes on the build before it measured the walk rather than the fix. So:
# `<builds>/fixed/release/ircx` is #541 and `<builds>/prefix/release/ircx` is
# its parent, each built the way anybody builds it — `npm run tauri build
# -- --no-bundle`, no probe. What is read is a request on the wire, so there is
# nothing here for an instrument to be inside.
#
# **And two timings, which the first set of this run is the reason for.** Held
# `<settle>` seconds past the third ask, the stale page lands on a conversation
# that has finished paging and both builds discard it — so a set of that alone
# says the two are alike without having put the question to either. `behind`
# writes it on the heels of the third ask's answer instead, which is the only
# state a guard is up in. Neither is more real than the other: the first is the
# shape a slow link makes and the second is the shape the store's own test is
# written in.
#
# One conversation, one pane. #540 is not about a split and a second pane would
# be a second reader asking for the same pages.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
ERGO=${4:?ergo port}
HOLDS=${5:?first hold port}
BUILDS=${6:?builds directory}
shift 6
TIMINGS=("${@:?at least one timing}")
HERE="$TREE/docs/end-to-end-32"
RUN23="$TREE/docs/end-to-end-23"

for arm in fixed prefix; do
  [ -x "$BUILDS/$arm/release/ircx" ] || { echo "no $arm binary in $BUILDS" >&2; exit 1; }
done

mkdir -p "$OUT"
bash "$RUN23/ergo.sh" "$OUT" "$ERGO"

# Run 23's seed, for its channel rather than for its property — a page landing
# regroups rows here, which is a distance run 31 measured and this run does not
# read at all. 1600 lines is the count, and it is not the four pages the walk
# names: a wheel burst that reaches the top of the pane can page more than once
# before it ends, so the walk asks for as many as the wheel gives it and the
# seed has to outlast that. A walk that runs out of history draws "Beginning of
# history" honestly in both arms and measures nothing. 1600 is also inside
# ergo's own `channel-length` of 2048, past which the seed's oldest lines are
# not there to be paged to.
python3 "$RUN23/seed.py" "127.0.0.1:$ERGO" '#wedge' 1600 > "$OUT/seed.log" 2>&1 &
echo $! > "$OUT/seed.pid"
for _ in $(seq 120); do
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
port=$HOLDS
for run in $(seq 1 "$RUNS"); do
  for build in fixed prefix; do
    for when in "${TIMINGS[@]}"; do
      echo "run $run $build, $when"
      # A port per walk and none reused: one left in TIME_WAIT is a proxy that
      # never binds, and the walk behind it connects to nothing.
      port=$((port + 1))
      bash "$HERE/wedge.sh" "$TREE" "$OUT/$build-$when/run$run" \
        "$port" "$ERGO" "$when" "$BUILDS/$build" \
        || echo "  run $run $build, $when was not read"
    done
  done
done

kill "$(cat "$OUT/seed.pid")" 2>/dev/null || true
rm -f "$OUT/seed.pid"
bash "$RUN23/stop.sh" "$OUT"
