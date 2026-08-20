#!/usr/bin/env bash
# The whole of run 39.
#
#     run.sh <tree> <output directory> <runs> <ergo port> <first hold port> <park notches>
#
# Runs 22, 23 and 31 all measured a split whose two panes were both reading
# history: the right one parked in the archive, the left one paging back. What
# `docs/manual-verification.md` has recorded as unwalked since run 12 is the
# other arrangement — one pane at the live edge and one scrolled back — and this
# is that walk. The pane at the tail is left alone by not touching it: a restored
# pane opens there, so the arrangement costs a command rather than needing one.
#
# Ten arms, and two of them are controls. What a walk of this kind is worth
# depends entirely on whether a reading it takes is one the arrangement caused,
# and the way to know is to take the same reading with the arrangement removed:
# `atlive` is the walk with nothing parked, `single` is the walk with nothing
# split, and both were what said the sidebar's unread mark is neither.
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
HERE="$TREE/docs/end-to-end-39"
RUN23="$TREE/docs/end-to-end-23"
BINARY="$TREE/target/release/ircx"
ARMS=(live atlive single pageback both split send sendone jump sendfail)

[ -x "$BINARY" ] || { echo "no binary at $BINARY" >&2; exit 1; }

mkdir -p "$OUT"
bash "$RUN23/ergo.sh" "$OUT" "$ERGO"

# Run 23's seed and run 23's reason for it: rows that can change once drawn, so
# a page landing can alter one already on the screen. 400 lines leaves 200 behind
# the join's page of 200, so the page the left pane asks for is one it is owed.
python3 "$RUN23/seed.py" "127.0.0.1:$ERGO" '#live39' 400 > "$OUT/seed.log" 2>&1 &
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

# The `sendfail` arm's channel, which has to be moderated and therefore cannot be
# the one the other nine read: `refuse.py` holds it, fills it and moderates it in
# that order, and stays connected because a channel lasts as long as somebody is
# in it.
python3 "$HERE/refuse.py" "127.0.0.1:$ERGO" '#refuse39' 400 "$RUN23/seed.py" \
  > "$OUT/refuse.log" 2>&1 &
echo $! > "$OUT/refuse.pid"
for _ in $(seq 120); do
  grep -q "^moderated: " "$OUT/refuse.log" && break
  sleep 1
done
grep -q "^moderated: " "$OUT/refuse.log" || {
  echo "#refuse39 was never moderated; see $OUT/refuse.log" >&2
  exit 1
}
cat "$OUT/refuse.log"

port=$HOLDS
for run in $(seq 1 "$RUNS"); do
  for arm in "${ARMS[@]}"; do
    echo "run $run $arm"
    # A port per walk and none reused: one left in TIME_WAIT is a proxy that
    # never binds, and the walk behind it connects to nothing.
    port=$((port + 1))
    bash "$HERE/one.sh" "$TREE" "$OUT/$arm/run$run" "$arm" "$ERGO" "$port" "$PARK" \
      || echo "  run $run $arm was not read"
  done
done

for who in seed refuse; do
  kill "$(cat "$OUT/$who.pid")" 2>/dev/null || true
  rm -f "$OUT/$who.pid"
done
bash "$RUN23/stop.sh" "$OUT"
