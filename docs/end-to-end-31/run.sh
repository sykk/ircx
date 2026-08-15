#!/usr/bin/env bash
# The whole of run 31.
#
#     run.sh <tree> <output directory> <runs> <ergo port> <first hold port> <park notches>
#
# Run 30 measured the pane that asked for a late page and closed on what it had
# not touched: #508's shape is two panes, and what the pane beside the asking one
# does when a page lands late has never been walked. This is run 30's walk with
# run 23's split under it, reading both panes off the same frames.
#
# The arms are run 30's and are not two builds: the same binary on the same walk
# with the page held for twenty seconds instead of seventy-five, so the control
# is a client still waiting when its page lands. What separates them is whether
# the client had given up, and nothing else.
#
# The binary is whatever is at target/release/ircx, built the way anybody builds
# it — `npm run tauri build -- --no-bundle`, no probe. What is measured is a
# distance between two screenshots, so there is nothing here for an instrument
# to be inside.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
ERGO=${4:?ergo port}
HOLDS=${5:?first hold port}
PARK=${6:?park notches}
HERE="$TREE/docs/end-to-end-31"
RUN23="$TREE/docs/end-to-end-23"
BINARY="$TREE/target/release/ircx"
# 75 is longer than `ROUND_TRIP_TIMEOUT`, by enough that the pane has been
# settled in the state of having given up for a good while before the page
# arrives. 40 is inside it, and is the control.
#
# **Run 30's control was 20 and it does not survive a split.** Frames cannot be
# taken during a wheel burst — `window.mjs` sends the whole burst in one command
# — so the first of them lands a second and a half after the burst ends, while
# the ask went out the moment the pane reached the top of its content. A pane
# half the window wide wraps its lines, which is more notches to that top and a
# longer burst behind the ask: at 20 seconds the release beat the first frame in
# one probe walk out of two, and `pick.py` refused the walk rather than reading
# it. 40 is past the longest burst measured here and 20 short of the timeout.
LATE=75
INTIME=40

[ -x "$BINARY" ] || { echo "no binary at $BINARY" >&2; exit 1; }

mkdir -p "$OUT"
bash "$RUN23/ergo.sh" "$OUT" "$ERGO"

# Run 23's seed, for its channel rather than for its property: 400 lines leaves
# 200 behind the join's page of 200, so the page the left pane asks for is one
# the reader is genuinely owed. That its rows can change height once drawn is
# the property, and here it works against the reading rather than for it — a row
# that redraws is a strip `paneshift.py` cannot measure against, which is why it
# reports how many were dropped.
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

# Two parkings were walked, and the notch counts are this seed's rather than a
# constant: 850 puts the right pane on line 0217, inside the block whose group
# the arriving page re-opens, and 300 puts it on line 0325, a hundred messages
# below anything the page can redraw. Where the pane stops was read off
# `parked.png` in a probe walk, because a notch is not a fixed number of pixels
# and a pane that overshoots into the top of its content asks a page-back of its
# own.
#
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
    bash "$HERE/parked.sh" "$TREE" "$OUT/$arm/run$run" \
      $((HOLDS + 2 * run + $([ "$arm" = intime ] && echo 1 || echo 0))) "$ERGO" "$HELD" "$PARK"
  done
done

kill "$(cat "$OUT/seed.pid")" 2>/dev/null || true
rm -f "$OUT/seed.pid"
bash "$RUN23/stop.sh" "$OUT"
