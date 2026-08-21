#!/usr/bin/env bash
# Where a burst of notches leaves the right pane, on the debug build.
#
#     TREE=<checkout> park.sh <name> <ergo port> <notches>
#
# Run 40's `park.sh` against the binary run 42 walks with. The calibration
# cannot be inherited from run 40 even though the arrangement is the same: a
# notch is not a fixed number of pixels — 69px in one pane of run 31, 14px in
# another, 84px on run 40's release build — and the band this run needs is a few
# hundred pixels wide.
#
# No proxy, so the page a freshly split pane asks for lands at once and the
# calibration costs seconds rather than a minute.
#
# What is being calibrated, in the terms the records now answer in: the reader's
# line has to be past `LOAD_OLDER_PX`, which is 400 in `Timeline.tsx`, so the
# pane is not the one that asks; and inside the row the window opens with, so
# the page merging into that row reaches it. `rowtop` says which row it is —
# the window's first is at or near zero — and `within` says how far into it.
set -euo pipefail
TREE=${TREE:?the checkout to walk}
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=${1:?name}
ERGO=${2:?ergo port}
PARK=${3:?notches}
DIR="$HERE/$NAME"
CHANNEL="#park$NAME"
mkdir -p "$DIR"

if [ -f "$HERE/seed.pid" ]; then
  kill "$(cat "$HERE/seed.pid")" 2>/dev/null || true
  sleep 2
fi
python3 "$TREE/docs/end-to-end-40/seed.py" "127.0.0.1:$ERGO" "$CHANNEL" 1009 > "$DIR/seed.log" 2>&1 &
echo $! > "$HERE/seed.pid"
for _ in $(seq 120); do
  grep -q "^seeded " "$DIR/seed.log" && break
  sleep 1
done
grep -q "^seeded " "$DIR/seed.log" || { echo "the seeder never finished" >&2; exit 1; }

{
  echo "wait 9000"
  echo "key ctrl+backslash"
  echo "wait 8000"
  echo "ss $DIR/at-live.png"
  echo "wheel 880 400 -$PARK"
  echo "wait 2500"
  echo "ss $DIR/parked.png"
  echo "quit"
} | IRCX_PROBE="$DIR/probe.log" VITE_PROBE=1 VITE_SWATCH=1 \
    node "$TREE/.claude/skills/run-ircx/window.mjs" --server "127.0.0.1:$ERGO" \
    --join "$CHANNEL" > "$DIR/walk.log" 2>&1 \
  || echo "    the walk exited $?"

echo "$PARK notches:"
python3 "$HERE/band.py" "$DIR/probe.log"
echo "-- the parked pane --"
python3 "$TREE/docs/end-to-end-42/sequence.py" "$DIR/parked.png" right
