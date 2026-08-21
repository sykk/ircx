#!/usr/bin/env bash
# Run 40's arrangement, on the debug build, read off the stripes.
#
#     TREE=<checkout> walk.sh <name> <hold port> [park notches]
#
# Needs an `ergo` on 6690 — `docs/end-to-end-23/ergo.sh <dir> 6690` — and the
# debug binary built once: `cargo build --manifest-path src-tauri/Cargo.toml
# --no-default-features`.
#
# `parked.sh` with three things changed, all of them to make a candidate cost
# two minutes instead of six:
#
#   * a burst of 600 notches rather than 1600. A notch is 84px in this pane and
#     the window is 400 messages, so 600 reaches the top with room to spare —
#     250 did not, and the walk that used it read 0697..0706 and no landing;
#   * a hold of 20 seconds rather than 40, which is what a burst that short
#     leaves room for;
#   * the debug binary, which fetches the frontend from Vite — so a change to
#     `scrollAnchor.ts` or `Timeline.tsx` costs no build at all.
#
# The reading is `sequence.py` on the last frame rather than an eye on a PNG:
# `VITE_SWATCH=1` paints a stripe per message in a colour that names it, and the
# seed sends its lines in order, so a pane painted right reads as a run of
# consecutive numbers and #602 reads as a step.
set -euo pipefail
TREE=${TREE:?the checkout to walk}
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=${1:?name}
PORT=${2:?hold port}
PARK=${3:-305}
HELD=20
DIR="$HERE/$NAME"
CHANNEL="#run42$NAME"
mkdir -p "$DIR"

# A channel per walk: every walk joins and quits and leaves both in the
# channel's history, which walks the page boundary the arrangement is built
# around two lines further on each time.
if [ -f "$HERE/seed.pid" ]; then
  kill "$(cat "$HERE/seed.pid")" 2>/dev/null || true
  sleep 2
fi
python3 "$TREE/docs/end-to-end-40/seed.py" 127.0.0.1:6690 "$CHANNEL" 1009 > "$DIR/seed.log" 2>&1 &
echo $! > "$HERE/seed.pid"
for _ in $(seq 120); do
  grep -q "^seeded " "$DIR/seed.log" && break
  sleep 1
done
grep -q "^seeded " "$DIR/seed.log" || { echo "the seeder never finished" >&2; exit 1; }

python3 "$TREE/docs/end-to-end-30/latepage.py" "$PORT" "127.0.0.1:6690" "$DIR/wire.log" \
  "$HELD" > "$DIR/hold.log" 2>&1 &
HOLD_PID=$!
sleep 1

{
  echo "wait 9000"
  echo "key ctrl+backslash"
  echo "wait $(( (HELD + 12) * 1000 ))"
  echo "ss $DIR/at-live.png"
  echo "wheel 880 400 -$PARK"
  echo "wait 2500"
  echo "ss $DIR/parked.png"
  echo "wheel 400 400 -600"
  echo "wait 1500"
  echo "ss $DIR/frame-000.png"
  for n in $(seq -w 1 12); do
    echo "ss $DIR/frame-$n.png"
    echo "wait 2000"
  done
  # One notch, after the pane has been left alone for twenty seconds. What the
  # engine does with a scroll it was not going to make is the question: a pane
  # whose DOM is whole and whose picture is stale comes right, and one drawing
  # what it holds cannot change.
  echo "wheel 400 400 -1"
  echo "wait 1500"
  echo "ss $DIR/nudged.png"
  echo "quit"
} | IRCX_PROBE="$DIR/probe.log" VITE_PROBE=1 VITE_SWATCH=1 \
    node "$TREE/.claude/skills/run-ircx/window.mjs" --server "127.0.0.1:$PORT" \
    --join "$CHANNEL" > "$DIR/walk.log" 2>&1 \
  || echo "    the walk exited $?"

kill "$HOLD_PID" 2>/dev/null || true
wait "$HOLD_PID" 2>/dev/null || true

echo "$(grep -c ' >> .*CHATHISTORY BEFORE' "$DIR/wire.log" || true) page-backs asked"
echo "-- the pane that asked, last frame --"
python3 "$HERE/sequence.py" "$DIR/frame-12.png" left
echo "-- the parked pane, last frame --"
python3 "$HERE/sequence.py" "$DIR/frame-12.png" right
echo "-- the pane that asked, after one notch --"
python3 "$HERE/sequence.py" "$DIR/nudged.png" left
