#!/usr/bin/env bash
# #611 on the assembled app: a reader scrolling up in a channel that is still
# talking, and a line they have read past gaining a row of chips as they go.
#
#     TREE=<checkout> walk.sh <name> <ergo port>
#
# Needs an `ergo` — `docs/end-to-end-23/ergo.sh <dir> <port>` — and the debug
# binary built once: `cargo build --manifest-path src-tauri/Cargo.toml
# --no-default-features`.
#
# `WINDOW=--release` drives the app anybody runs instead, built by
# `VITE_PROBE=1 VITE_SWATCH=1 npm run tauri build -- --no-bundle`. Both flags
# have to be set at build time there: the release frontend is bundled into the
# binary, so a probe the build did not compile in is a probe the walk cannot
# turn on — and this walk's reactor fires on the probe.
#
# One pane, not two: nothing pages here and nothing lands, so the second pane
# run 40 needed to make one ask has nothing to do. The parking is 60 notches
# rather than 305 for the same reason — what this wants is room *above* the
# reader, and a pane parked where run 40 parks it has a screen of the window
# above it and the rest below.
#
# The gesture is a notch at a time with 120ms between, which is under the
# virtualiser's 150ms `isScrollingResetDelay`: it reads as one backward gesture
# for the whole four seconds rather than forty separate ones, which is the
# state #611 is about. A single `wheel -40` is over in 640ms and lands the
# reactions in a heap at the end of it.
set -euo pipefail
TREE=${TREE:?the checkout to walk}
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=${1:?name}
ERGO=${2:?ergo port}
PARK=${3:-60}
NOTCHES=${4:-40}
REACTIONS=${5:-12}
DIR="$HERE/$NAME"
CHANNEL="#run45$NAME"
mkdir -p "$DIR"

# In the channel before the seeder, so it hears every line and can name the
# message under any of them.
python3 "$HERE/reactor.py" "127.0.0.1:$ERGO" "$CHANNEL" "$DIR/probe.log" "$REACTIONS" \
  --behind 100 --every 250 --after "$DIR/go.png" > "$DIR/reactor.log" 2>&1 &
REACTOR_PID=$!
trap 'kill "$REACTOR_PID" 2>/dev/null || true' EXIT
for _ in $(seq 60); do
  grep -q "^joined" "$DIR/reactor.log" && break
  sleep 0.5
done
grep -q "^joined" "$DIR/reactor.log" || { echo "the reactor never joined" >&2; exit 1; }

# Backgrounded and waited on by what it prints, because the seeder stays in the
# channel after it has filled it — a walk against a channel nobody is in is a
# walk against a channel that is not talking.
python3 "$TREE/docs/end-to-end-40/seed.py" "127.0.0.1:$ERGO" "$CHANNEL" 1009 > "$DIR/seed.log" 2>&1 &
SEED_PID=$!
trap 'kill "$REACTOR_PID" "$SEED_PID" 2>/dev/null || true' EXIT
for _ in $(seq 240); do
  grep -q "^seeded " "$DIR/seed.log" && break
  sleep 1
done
grep -q "^seeded " "$DIR/seed.log" || { echo "the seeder never finished" >&2; exit 1; }
for _ in $(seq 60); do
  grep -q "^holding " "$DIR/reactor.log" && break
  sleep 1
done
grep -q "^holding " "$DIR/reactor.log" || { echo "the reactor learned no lines" >&2; exit 1; }
echo "-- $(grep '^holding ' "$DIR/reactor.log")"

{
  echo "wait 12000"
  echo "ss $DIR/at-live.png"
  echo "wheel 600 400 -$PARK"
  echo "wait 4000"
  echo "ss $DIR/parked.png"
  # What arms the reactor, and the only mark `window.mjs` can leave for another
  # process to see. Parking is a backward gesture too, and a reactor watching
  # from the start spends itself on it.
  echo "ss $DIR/go.png"
  # The gesture. One notch, then under the reset delay, forty times.
  for _ in $(seq "$NOTCHES"); do
    echo "wheel 600 400 -1"
    echo "wait 120"
  done
  echo "wait 4000"
  echo "ss $DIR/settled.png"
  echo "quit"
} | IRCX_PROBE="$DIR/probe.log" VITE_PROBE=1 VITE_SWATCH=1 \
    node "$TREE/.claude/skills/run-ircx/window.mjs" --server "127.0.0.1:$ERGO" \
    --join "$CHANNEL" ${WINDOW:-} > "$DIR/walk.log" 2>&1 \
  || echo "    the walk exited $?"

echo "-- what the reactor did --"
grep -c "^reacted " "$DIR/reactor.log" || true
grep "^reacted " "$DIR/reactor.log" || true
echo "-- the pane, parked --"
python3 "$TREE/docs/end-to-end-42/sequence.py" "$DIR/parked.png" left
echo "-- the pane, settled --"
python3 "$TREE/docs/end-to-end-42/sequence.py" "$DIR/settled.png" left
echo "-- what moved under the reader --"
python3 "$HERE/moved.py" "$DIR/probe.log"
