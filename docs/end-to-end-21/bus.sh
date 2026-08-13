#!/usr/bin/env bash
# Starts a private session bus with `notifyd.py` owning the notification name on
# it, and prints the address to use.
#
#     bus.sh <output directory>
#
# A private bus rather than the operator's own, for two reasons. Their desktop
# has a real daemon that would draw the notifications on their screen and tell
# this walk nothing, and a name already owned is a name `notifyd.py` refuses.
#
# Writes <output>/bus.env for the walk to source, and leaves the pids in
# <output>/bus.pids for it to kill.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?output directory}
mkdir -p "$OUT"

dbus-daemon --session --print-address --fork --print-pid > "$OUT/bus.raw"
ADDRESS=$(sed -n 1p "$OUT/bus.raw")
BUSPID=$(sed -n 2p "$OUT/bus.raw")

export DBUS_SESSION_BUS_ADDRESS="$ADDRESS"
python3 "$HERE/notifyd.py" "$OUT/notifications.jsonl" > "$OUT/notifyd.log" 2>&1 &
DAEMON=$!

# The name has to be owned before the app is launched, so wait for the daemon to
# say it is rather than sleeping a guess.
for _ in $(seq 40); do
  if grep -q '"call": "ready"' "$OUT/notifications.jsonl" 2>/dev/null; then break; fi
  sleep 0.25
done
grep -q '"call": "ready"' "$OUT/notifications.jsonl" || { echo "notifyd never took the name" >&2; exit 1; }

echo "export DBUS_SESSION_BUS_ADDRESS='$ADDRESS'" > "$OUT/bus.env"
echo "$BUSPID $DAEMON" > "$OUT/bus.pids"
echo "bus $ADDRESS"
echo "notifyd pid $DAEMON, bus pid $BUSPID"
