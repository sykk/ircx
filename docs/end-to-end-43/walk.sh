#!/usr/bin/env bash
# #601's arrangement, measured in the records rather than off the frames.
#
#     TREE=<checkout> walk.sh <name> <hold port> <ergo port> [park notches]
#
# Needs an `ergo` — `docs/end-to-end-23/ergo.sh <dir> <port>` — and the debug
# binary built once: `cargo build --manifest-path src-tauri/Cargo.toml
# --no-default-features`.
#
# Run 42's `walk.sh` with the reading changed and one frame added. What run 40
# read off the frames — the line number at the top of the parked pane, before
# the page and thirty seconds after it — is a distance between two pictures of
# rows that are no longer the same rows. The records now name the reader's own
# message and say where its line is drawn, so the displacement is a subtraction
# on one message: `y` on the last commit before the landing against `y` once the
# pane has settled.
#
# The frames are kept, and `settled.png` is the thirty seconds run 40 read: a
# pane moved by 700px shows it, and a record that says so alone is one
# instrument unchecked.
#
# **Two page-backs is the walk being in the arrangement.** The join's own and
# the one the left pane asks for; a third is the parked pane having overshot to
# within `LOAD_OLDER_PX` of the top of its content, which makes it the asker and
# leaves the walk with no parked pane in it.
set -euo pipefail
TREE=${TREE:?the checkout to walk}
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=${1:?name}
PORT=${2:?hold port}
ERGO=${3:?ergo port}
PARK=${4:-305}
HELD=20
DIR="$HERE/$NAME"
CHANNEL="#run43$NAME"
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

python3 "$TREE/docs/end-to-end-30/latepage.py" "$PORT" "127.0.0.1:$ERGO" "$DIR/wire.log" \
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
  # Thirty seconds with nothing happening, which is where run 40 found the
  # displacement was not a state the pane was passing through.
  echo "wait 30000"
  echo "ss $DIR/settled.png"
  echo "quit"
} | IRCX_PROBE="$DIR/probe.log" VITE_PROBE=1 VITE_SWATCH=1 \
    node "$TREE/.claude/skills/run-ircx/window.mjs" --server "127.0.0.1:$PORT" \
    --join "$CHANNEL" > "$DIR/walk.log" 2>&1 \
  || echo "    the walk exited $?"

kill "$HOLD_PID" 2>/dev/null || true
wait "$HOLD_PID" 2>/dev/null || true

echo "$(grep -c ' >> .*CHATHISTORY BEFORE' "$DIR/wire.log" || true) page-backs asked (2 is the arrangement)"
echo "-- where the panes were parked --"
python3 "$HERE/band.py" --parked "$DIR/probe.log"
echo "-- the parked pane, before the page --"
python3 "$TREE/docs/end-to-end-42/sequence.py" "$DIR/parked.png" right
echo "-- the parked pane, thirty seconds after it --"
python3 "$TREE/docs/end-to-end-42/sequence.py" "$DIR/settled.png" right
echo "-- the reader, across the landing --"
python3 "$HERE/held.py" "$DIR/probe.log"
