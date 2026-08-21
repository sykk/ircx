#!/usr/bin/env bash
# The whole of run 40.
#
#     run.sh <tree> <output directory> <runs> <ergo port> <first hold port> <park notches>
#
# `docs/manual-verification.md` has carried this since #539 shipped:
#
#   > **What no walk has watched is still the release app.** The model is where
#   > the 744px was read, and the model had to be corrected to read it.
#
# A pane parked among the rows an arriving page re-groups is the one arrangement
# run 31 could not make: its channel spoke in runs of four, so a pane was either
# at the top of its own content — where it asks for the page itself and there is
# no parked pane in the walk — or a hundred messages below anything the page
# could redraw. `seed.py` here speaks in runs of twenty, which is 400px of one
# row, and that is the whole of the band: past `LOAD_OLDER_PX` and inside the
# row the page merges into at once.
#
# Three arms, and the third is what makes the other two mean anything.
#
#   ship     the binary anybody builds, for the frames
#   probe    the same walk on a `VITE_PROBE=1` build, for the records
#   control  that build with #539's term backed out and the records left in
#
# The control is the arm this run is worth anything for. A walk that reads 0px
# on the build that ships and never saw the defect on any build has measured
# nothing, and this one is a hold whose exit condition is one boolean: the
# reader's own row being a height the virtualiser knows.
#
# The binaries are prepared by `builds.sh` and swapped into `target/release/ircx`
# per arm, because that is the path `window.mjs` runs.
#
# The arms alternate run by run, run 25's arrangement: a machine that gets busy
# halfway through a set otherwise gives one arm all the quiet.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
ERGO=${4:?ergo port}
HOLDS=${5:?first hold port}
PARK=${6:?park notches}
HERE="$TREE/docs/end-to-end-40"
RUN23="$TREE/docs/end-to-end-23"
CHANNEL='#merge40'
# Run 31's in-time hold: 40 seconds is past the longest wheel burst measured
# there and 20 short of `ROUND_TRIP_TIMEOUT`, so the client is still waiting when
# its page lands. What #538 is about happens on the commits the page lands in,
# and a client that has given up is a different walk (run 30's).
HELD=40
ARMS=(ship probe control)

# Made before the binaries are looked for: `$OUT/..` does not resolve until
# `$OUT` exists, and the check would then fail on a set whose binaries are
# sitting right there.
mkdir -p "$OUT"
for arm in "${ARMS[@]}"; do
  [ -x "$OUT/../ircx-$arm" ] || { echo "no $arm binary — run builds.sh first" >&2; exit 1; }
done

bash "$RUN23/ergo.sh" "$OUT" "$ERGO"

# 1009, and every digit of it is the arrangement.
#
# Two pages land before the one this run measures: the join's `LATEST 200`, and
# the one a freshly split pane asks for on its own. So the window the reader is
# parked in runs from line 0610, and what the walk's own page-back brings is the
# two hundred behind that.
#
# 0610 is where it has to be. A row is bounded by a speaker change, every sixty
# lines here, so the row the window opens with runs 0610 to 0659 — fifty lines,
# about 1250px, and the band is what is left of it under 400px. The page then
# brings 0600 to 0609: ten lines by the same speaker, carrying the declaration
# at 0600 the window could not see, and they merge into the row the reader is
# sitting in — which `buildRows` says as 50 messages before and 60 starting ten
# lines earlier after.
#
# Both halves are needed. A first row shorter than 400px has no band to park in,
# and a window opening at a run's first line has nothing to merge.
# **A channel per run, and the first set is why.** Every walk joins and quits and
# leaves both in the channel's history, so the page boundary the arrangement is
# built around walks two lines later each time: the window opened at 0613 in the
# first walk of the first set and at 0627 in the last, and by then the row the
# reader is parked in is a dozen lines shorter than the one the parking was
# calibrated against. The three arms of one run share a channel, which is what
# makes them comparable; each run seeds its own.
seed() {
  local channel=$1
  if [ -f "$OUT/seed.pid" ]; then
    # The nicks belong to the seeder rather than to the channel, so the one
    # holding them has to go before the next can register.
    kill "$(cat "$OUT/seed.pid")" 2>/dev/null || true
    sleep 2
  fi
  python3 "$HERE/seed.py" "127.0.0.1:$ERGO" "$channel" 1009 > "$OUT/seed.log" 2>&1 &
  echo $! > "$OUT/seed.pid"
  for _ in $(seq 90); do
    grep -q "^seeded " "$OUT/seed.log" && break
    sleep 1
  done
  grep -q "^seeded " "$OUT/seed.log" || {
    echo "the seeder never finished; see $OUT/seed.log" >&2
    exit 1
  }
  cat "$OUT/seed.log"
}

port=$HOLDS
for run in $(seq 1 "$RUNS"); do
  seed "$CHANNEL$run"
  for arm in "${ARMS[@]}"; do
    echo "run $run $arm"
    cp "$OUT/../ircx-$arm" "$TREE/target/release/ircx"
    # A port per walk and none reused: one left in TIME_WAIT is a proxy that
    # never binds, and the walk behind it connects to nothing.
    port=$((port + 1))
    bash "$HERE/parked.sh" "$TREE" "$OUT/$arm/run$run" "$port" "$ERGO" "$HELD" "$PARK" \
      "$CHANNEL$run" || echo "  run $run $arm was not read"
  done
done

kill "$(cat "$OUT/seed.pid")" 2>/dev/null || true
rm -f "$OUT/seed.pid"
bash "$RUN23/stop.sh" "$OUT"
