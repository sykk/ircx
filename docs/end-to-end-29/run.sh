#!/usr/bin/env bash
# All three arms of run 29.
#
#     run.sh <output directory> [--load]
#
# Run 17's two builds and the one that ships, on the same walk against the same
# channel, one arm after another: two arms at once would each be measuring the
# other's load. The trees are checkouts of those commits carrying a byte-
# identical copy of today's harness, so what differs between arms is the app.
#
# `depth.py` first, always. A chain measured on a channel that has drifted is
# run 17 again — and the walk's own join and quit cost the far end two events,
# so the reading belongs to the run rather than to the file.
set -euo pipefail

OUT=${1:?output directory}
LOAD=${2:-}
HERE=$(cd "$(dirname "$0")" && pwd)
TREES=/home/syk/ircx/.claude/worktrees
# A loaded arm cannot share a port with the quiet one that already used it: the
# proxy from the earlier run is gone, but a walk pointed at a port somebody
# else's proxy is holding reads an empty log rather than saying so (run 15).
PORT=6691
[ "$LOAD" = "--load" ] && PORT=6694

mkdir -p "$OUT"
python3 "$HERE/../end-to-end-28/depth.py" 127.0.0.1:6677 '#scrollback' | tee "$OUT/depth.txt"

bash "$HERE/revisit.sh" "$TREES/run29-before" "$OUT/before" 3 "$PORT" $LOAD
bash "$HERE/revisit.sh" "$TREES/run29-after" "$OUT/after" 3 "$((PORT + 1))" $LOAD
bash "$HERE/revisit.sh" "$TREES/fix+timeline-paging-guard-wedge" "$OUT/head" 3 "$((PORT + 2))" $LOAD
