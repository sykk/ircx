#!/usr/bin/env bash
# Opens a channel on a fresh profile with the join's page held back, and asks
# whether the pane can still reach its own history.
#
#     firstpage.sh <tree> <output directory> <walks> <port> <delay ms> [spinners]
#
# The signature needs no screenshot and no reading of a list. A pane that has
# decided its history ends here sends **no `CHATHISTORY BEFORE` at all**,
# however far it is scrolled, so the count of asks in a walk is 0 or it is not.
#
# The delay is swept rather than guessed, because the window is the archive read
# and nobody has measured how long that is. Three outcomes are possible and all
# three are results:
#
#   * the page lands before the priming read is dispatched — the snapshot holds
#     it, both builds ask, and the walk says nothing;
#   * it lands during the read — the old build computes `undefined` and gives
#     up, the fixed one reads the head after the await and asks;
#   * it lands after the read has returned — neither build has anything to ask
#     from, and if both then give up, that is a defect in the build that ships
#     rather than in the one before it.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
WALKS=${3:?how many}
PORT=${4:?port}
DELAY=${5:?delay ms}
SPINNERS=${6:-0}

HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$OUT"

SPIN=()
for _ in $(seq 1 "$SPINNERS"); do
  bash -c 'while :; do :; done' &
  SPIN+=($!)
done

python3 "$HERE/holdlatest.py" "$PORT" 127.0.0.1:6677 "$OUT/wire.log" "$DELAY" &
PROXY=$!
cleanup() {
  kill "$PROXY" 2>/dev/null || true
  [ ${#SPIN[@]} -eq 0 ] || kill "${SPIN[@]}" 2>/dev/null || true
  wait "$PROXY" 2>/dev/null || true
  [ ${#SPIN[@]} -eq 0 ] || wait "${SPIN[@]}" 2>/dev/null || true
}
trap cleanup EXIT
sleep 1

for walk in $(seq -w 1 "$WALKS"); do
  {
    # Long enough for the join's page to have arrived even when it is held.
    echo "wait 12000"
    # To the top, which is what asks for the page behind — if the pane still
    # believes there is one.
    echo "wheel 660 400 -1600"
    echo "wait 4000"
    echo "ss $OUT/w$walk-top.png"
    echo "quit"
  } | node "$HARNESS" --release --server "127.0.0.1:$PORT" --join '#scrollback' \
    > "$OUT/w$walk.log" 2>&1 || echo "    walk $walk exited $?"
done

asks=$(grep -c "CHATHISTORY BEFORE" "$OUT/wire.log" || true)
held=$(grep -c "^ *[0-9.]* hold " "$OUT/wire.log" || true)
echo "delay ${DELAY}ms, ${SPINNERS} spinners: $WALKS walks, $held pages held, $asks page-backs sent"
