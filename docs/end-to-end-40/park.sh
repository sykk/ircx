#!/usr/bin/env bash
# Where a given number of notches leaves the right pane, with nothing else in
# the walk.
#
#     park.sh <tree> <output directory> <ergo port> <park notches> <channel>
#
# The band this run needs is a few hundred pixels wide and a notch is not a fixed
# number of pixels — 69px in one pane of run 31, 14px in another, 86px here — so
# the parking is calibrated before a set is run rather than guessed at.
#
# `parked.sh` without the proxy, which is the whole difference: the page a
# freshly split pane asks for lands at once instead of forty seconds later, so
# the pane is looking at the same four hundred messages it will be parked in
# during the walk, and the calibration costs seconds rather than a minute.
#
# The reading is the probe records, because `top` is the number the band is
# defined in: past `LOAD_OLDER_PX`, which is 400, and inside the row the window
# opens with. The picture is kept for the line number it names, which is what
# says the pane is where the arithmetic thinks it is.
set -euo pipefail

TREE=${1:?tree}
DIR=${2:?output directory}
ERGO=${3:?ergo port}
PARK=${4:?park notches}
CHANNEL=${5:?channel}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$DIR"

{
  echo "wait 9000"
  echo "key ctrl+backslash"
  echo "wait 8000"
  echo "ss $DIR/at-live.png"
  echo "wheel 880 400 -$PARK"
  echo "wait 2500"
  echo "ss $DIR/parked.png"
  echo "quit"
} | IRCX_PROBE="$DIR/probe.log" node "$HARNESS" --release --server "127.0.0.1:$ERGO" \
    --join "$CHANNEL" > "$DIR/walk.log" 2>&1 \
  || echo "    the walk exited $?"

python3 - "$DIR/probe.log" <<'PY'
import json
import sys

panes = {}
for raw in open(sys.argv[1]):
    record = json.loads(raw)
    if record.get("kind") == "commit":
        panes.setdefault(record["x"], []).append(record)

for x in sorted(panes):
    last = panes[x][-1]
    held = last.get("held") or {}
    where = "left" if x < 600 else "right"
    print(f"{where} pane at x {x}: top {last['top']}, sh {last['sh']}, msgs {last['msgs']}, "
          f"the row it is in starts {last['top'] + (held.get('delta') or 0)} "
          f"and the line under the fold is {held.get('within')} into it")
PY
