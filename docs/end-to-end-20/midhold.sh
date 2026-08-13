#!/usr/bin/env bash
# Photographs the pane while the join's page is still being held.
#
#     midhold.sh <tree> <output directory> <port> <delay ms>
#
# Holding the page for eight seconds changed nothing about what the old build
# does, which says the priming archive read is not in flight while the page is
# outstanding. This asks what the pane is doing instead: a window that has
# already read the archive and been given nothing draws "Beginning of history",
# and one that has not yet asked draws nothing at all.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
PORT=${3:?port}
DELAY=${4:?delay ms}

HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$OUT"

python3 "$HERE/holdlatest.py" "$PORT" 127.0.0.1:6677 "$OUT/wire.log" "$DELAY" &
PROXY=$!
trap 'kill $PROXY 2>/dev/null || true' EXIT
sleep 1

{
  # Inside the hold: the channel is joined and its page has not arrived.
  echo "wait 4000"
  echo "ss $OUT/a-inside-the-hold.png"
  # After it: the page has landed and the pane has whatever it makes of it.
  echo "wait 8000"
  echo "ss $OUT/b-after-release.png"
  echo "wheel 660 400 -1600"
  echo "wait 4000"
  echo "ss $OUT/c-scrolled.png"
  echo "quit"
} | node "$HARNESS" --release --server "127.0.0.1:$PORT" --join '#scrollback' \
  > "$OUT/walk.log" 2>&1 || echo "walk exited $?"

grep -E "hold|free|CHATHISTORY" "$OUT/wire.log" | cut -c1-110
