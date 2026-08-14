#!/usr/bin/env bash
# Both arms of run 28.
#
#     run.sh <tree> <output directory>
#
# The chain first, quiet and then under load, and then the empty batch with its
# own control. Within an arm nothing differs but the one thing named: same
# build, same channel, same bursts, and a fresh profile every walk.
#
# `depth.py` first, always. A chain measured on a channel that has drifted is
# run 17 again.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
HERE=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$OUT"
python3 "$HERE/depth.py" 127.0.0.1:6677 '#scrollback' | tee "$OUT/depth.txt"

bash "$HERE/deep.sh" "$TREE" "$OUT/quiet" 3 6690
bash "$HERE/deep.sh" "$TREE" "$OUT/load" 3 6691 --load
bash "$HERE/empty.sh" "$TREE" "$OUT/empty" 3 6692
bash "$HERE/empty.sh" "$TREE" "$OUT/empty-pass" 1 6693 --pass
