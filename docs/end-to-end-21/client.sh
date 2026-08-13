#!/usr/bin/env bash
# Puts the second client in the channel and waits until it is really there.
#
#     client.sh <output directory> <port> <nick> <channel>
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?output directory}
PORT=${2:?port}
NICK=${3:-phrack}
CHANNEL=${4:-#harness}

rm -f "$OUT/control" "$OUT/client.log"
python3 "$HERE/highlighter.py" "127.0.0.1:$PORT" "$NICK" "$CHANNEL" \
  "$OUT/control" "$OUT/client.log" > "$OUT/client.out" 2>&1 &
echo $! > "$OUT/client.pid"

for _ in $(seq 40); do
  if grep -q "joined, taking orders" "$OUT/client.log" 2>/dev/null; then
    echo "$NICK is in $CHANNEL, pid $(cat "$OUT/client.pid")"
    exit 0
  fi
  sleep 0.25
done
echo "second client never joined; see $OUT/client.log" >&2
exit 1
