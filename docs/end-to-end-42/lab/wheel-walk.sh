#!/usr/bin/env bash
# Run 40's walk, in the lab.
#
#     wheel-walk.sh <url> <output directory> [park notches] [hold ms]
#
# `parked.sh` drives the assembled app: split the pane, park the right one
# inside the block an arriving page merges into, take the left one to the top so
# it asks, and hold the page long enough that it lands on a pane at rest. This
# is that walk with the Rust side and the proxy replaced by the seed, so the
# reading is the same and a run costs half a minute.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
URL=${1:?url}
OUT=${2:?output directory}
PARK=${3:-6}
HOLD=${4:-2500}
ZOOM=1.0
mkdir -p "$OUT"

{
  echo "wait 2200"
  echo "js lab.open('#merge')"
  echo "wait 2000"
  echo "key ctrl+backslash"
  echo "wait 2500"
  echo "js lab.hold = $HOLD"
  # The right pane, parked inside the block at the top of its own window: past
  # LOAD_OLDER_PX, so it is not the asker, and inside the row, so the merge
  # reaches it.
  echo "wheel 880 400 -$PARK"
  echo "wait 1500"
  echo "js lab.paint()"
  echo "ss $OUT/parked.png"
  echo "js JSON.stringify([lab.scrollTop(0), lab.scrollTop(1)])"
  # The left pane to the top, which is the ask.
  echo "wheel 400 400 -400"
  echo "wait $((HOLD + 3000))"
  echo "js lab.paint()"
  echo "wait 600"
  echo "js JSON.stringify([lab.scrollTop(0), lab.scrollTop(1)])"
  echo "ss $OUT/after.png"
  echo "js lab.column(0)"
  echo "js lab.column(1)"
  # Twice, seconds apart: a pane that is left wrong stays wrong, and a frame
  # caught mid-commit does not.
  echo "wait 4000"
  echo "ss $OUT/settled.png"
  echo "js lab.column(0)"
  echo "js lab.column(1)"
  echo "quit"
} | python3 "$HERE/lab.py" "$URL" --size 1200x800 --zoom "$ZOOM" > "$OUT/log" 2>&1

python3 - "$OUT/log" "$OUT" <<'PY'
import json, sys
log, out = sys.argv[1:3]
lines = [l for l in open(log).read().splitlines() if l.startswith('ok "') and "[[" in l]
for name, line in zip(["left", "right", "left-settled", "right-settled"], lines[-4:]):
    open(f"{out}/{name}.json", "w").write(json.loads(json.loads(line[3:])))
PY
grep -E '^ok "\\"\[[0-9]' "$OUT/log" | tail -2
for pane in left right left-settled right-settled; do
  shot="$OUT/after.png"
  case $pane in *settled) shot="$OUT/settled.png";; esac
  printf '%-14s ' "$pane"
  python3 "$HERE/screen.py" "$shot" "$OUT/$pane.json" "$ZOOM" | tail -1
done
