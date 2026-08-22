#!/usr/bin/env bash
# Search, and the jump out of it into the middle of the archive.
#
#     TREE=<checkout> walk.sh <name> <ergo port> [bulk] [hit] [late]
#
# Needs an `ergo` — `docs/end-to-end-23/ergo.sh <dir> <port>` — and the debug
# binary built once: `cargo build --manifest-path src-tauri/Cargo.toml
# --no-default-features`.
#
# `SearchOverlay.jump` replaces the conversation's whole message list with a
# window `load_history_around` reads out of SQLite — 101 messages before the hit
# and 99 after it — and then asks the pane to scroll to the hit. Everything this
# walk photographs is downstream of that one call:
#
#   * where the pane leaves the reader,
#   * whether leaving the conversation and coming back to it puts the live
#     conversation there again,
#   * what the channel's next line does to a window that ends hundreds of
#     messages behind it,
#   * and where `Jump to latest` goes when the last row is not the latest
#     message.
#
# The lines are said *while ircx is in the channel*, which is the whole reason
# `talker.py` exists: search reads the client's own archive, and the archive
# holds what the client received rather than what the server could be asked for.
#
# `--keep` leaves the profile behind so the archive can be read afterwards —
# what the pane drew is a screenshot, what the client held is SQLite, and this
# run is about the difference.
set -euo pipefail
TREE=${TREE:?the checkout to walk}
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=${1:?name}
ERGO=${2:?ergo port}
BULK=${3:-500}
HIT=${4:-120}
LATE=${5:-6}
DIR="$HERE/$NAME"
CHANNEL="#run47$NAME"
ELSEWHERE="#quiet47$NAME"
mkdir -p "$DIR"
rm -f "$DIR"/*.png

# One nick for the bulk, which is one socket: ergo keeps a connection's own
# order, and this walk reads a step in the line numbers as a hole in the
# conversation. See `talker.py` for what three sockets did to the first walk.
python3 "$HERE/talker.py" "127.0.0.1:$ERGO" "$CHANNEL" 1 "$BULK" \
  --nicks historian --after "$DIR/seed-go.png" > "$DIR/bulk.log" 2>&1 &
BULK_PID=$!
python3 "$HERE/talker.py" "127.0.0.1:$ERGO" "$CHANNEL" "$((BULK + 1))" "$LATE" \
  --nicks latecomer --after "$DIR/talk-go.png" > "$DIR/late.log" 2>&1 &
LATE_PID=$!
trap 'kill "$BULK_PID" "$LATE_PID" 2>/dev/null || true' EXIT
for _ in $(seq 60); do
  grep -q "^joined" "$DIR/bulk.log" && grep -q "^joined" "$DIR/late.log" && break
  sleep 0.5
done
grep -q "^joined" "$DIR/bulk.log" || { echo "the bulk talker never joined" >&2; exit 1; }
grep -q "^joined" "$DIR/late.log" || { echo "the late talker never joined" >&2; exit 1; }

{
  # The client connects, joins and settles at the live edge of an empty channel.
  echo "wait 12000"
  # The conversation the walk is about, named rather than clicked: which row the
  # sidebar draws first is not this run's to assume.
  echo "key ctrl+k"
  echo "wait 800"
  echo "type run47$NAME"
  echo "wait 1000"
  echo "key Return"
  echo "wait 1500"
  # The mark. Every line after it is one ircx hears and writes down.
  echo "ss $DIR/seed-go.png"
  echo "wait 25000"
  echo "ss $DIR/at-live.png"
  # Search this conversation for the one line carrying this number.
  echo "key ctrl+f"
  echo "wait 1200"
  printf 'type %04d\n' "$HIT"
  echo "wait 2000"
  echo "ss $DIR/hits.png"
  echo "key Return"
  echo "wait 3000"
  echo "ss $DIR/jumped.png"
  # Away to another conversation and back, which is the cheapest thing a reader
  # who wants the present again would try.
  echo "key ctrl+k"
  echo "wait 800"
  echo "type quiet47$NAME"
  echo "wait 1000"
  echo "key Return"
  echo "wait 1500"
  echo "key ctrl+k"
  echo "wait 800"
  echo "type run47$NAME"
  echo "wait 1000"
  echo "key Return"
  echo "wait 2000"
  echo "ss $DIR/returned.png"
  # The channel says a few more things, to a reader who is hundreds of messages
  # behind it.
  echo "ss $DIR/talk-go.png"
  echo "wait 5000"
  echo "ss $DIR/after-talk.png"
  # `Jump to latest`, by its own hotkey rather than by a coordinate off a frame.
  echo "key ctrl+shift+l"
  echo "wait 2500"
  echo "ss $DIR/latest.png"
  echo "quit"
} | IRCX_PROBE="$DIR/probe.log" VITE_PROBE=1 VITE_SWATCH=1 \
    node "$TREE/.claude/skills/run-ircx/window.mjs" --server "127.0.0.1:$ERGO" \
    --join "$CHANNEL" --join "$ELSEWHERE" --keep ${WINDOW:-} > "$DIR/walk.log" 2>&1 \
  || echo "    the walk exited $?"

echo "-- what the talkers said --"
grep "^said " "$DIR/bulk.log" "$DIR/late.log" || true
echo "-- the profile --"
grep -i "profile kept" "$DIR/walk.log" || true
for frame in at-live jumped returned after-talk latest; do
  echo "-- $frame --"
  python3 "$TREE/docs/end-to-end-42/sequence.py" "$DIR/$frame.png" left 2>&1 || true
done
