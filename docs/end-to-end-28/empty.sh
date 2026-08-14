#!/usr/bin/env bash
# Reads to the top of a channel whose first page-back is answered with nothing.
#
#     empty.sh <tree> <output directory> <walks> <proxy port> [--pass]
#
# The chain walk spends eleven pages and ends on a short one, which is `End` by
# `paged_arrived < limit` with rows in the batch. This ends on the same branch
# with none in it, which is a different line on the wire and the one nothing had
# read: an open batch, a close, and nothing between them.
#
# The proxy empties the *first* page-back only because that is all it takes —
# `End` stops the paging, so a second ask is a defect rather than the next step.
# So the count is the result again: one ask, and a pane that says where the
# history ends while the server still holds ten pages of it.
#
# `--pass` is the control, and here it is worth more than usual: the same walk
# against the same channel with nothing replaced asks ten more times and does
# not say "Beginning of history" until it means it.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
WALKS=${3:?how many}
PORT=${4:?proxy port}
PASSING=${5:-}

HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$OUT"

python3 "$HERE/emptypage.py" "$PORT" 127.0.0.1:6677 "$OUT/wire.log" $PASSING &
PROXY=$!
cleanup() {
  kill "$PROXY" 2>/dev/null || true
  wait "$PROXY" 2>/dev/null || true
}
trap cleanup EXIT
sleep 1

for walk in $(seq -w 1 "$WALKS"); do
  echo "=== walk $walk"
  {
    echo "wait 9000"
    echo "ss $OUT/w$walk-a-foot.png"
    echo "wheel 660 400 -1600"
    echo "wait 6000"
    echo "ss $OUT/w$walk-b-answered.png"
    # Down and back up, which is what raises a scroll event against a scroller
    # already clamped at the top — run 27's lesson, and the only way to ask
    # whether a pane told the history ended will ask again anyway.
    echo "wheel 660 400 12"
    echo "wait 1500"
    echo "wheel 660 400 -40"
    echo "wait 6000"
    echo "ss $OUT/w$walk-c-asked-again.png"
    echo "quit"
  } | node "$HARNESS" --release --server "127.0.0.1:$PORT" --join '#scrollback' \
    > "$OUT/w$walk.log" 2>&1 || echo "    walk $walk exited $?"

  grep -c '^ *[0-9.]* ask ' "$OUT/wire.log" | xargs echo "    asks on the wire so far:"
done

echo "=== the chain"
python3 "$HERE/chain.py" "$OUT/wire.log" | tee "$OUT/chain.txt"
echo "=== what the proxy emptied"
grep '~~ ' "$OUT/wire.log" || true
