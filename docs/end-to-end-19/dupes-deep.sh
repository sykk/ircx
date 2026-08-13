#!/usr/bin/env bash
# Run 16's two-launch walk on a channel with history behind it again.
#
#     dupes-deep.sh <tree> <output directory> <runs> <first tap port> [spinners]
#
# #496's duplicate is the `#487` guard failing to fire: two `CHATHISTORY BEFORE`
# naming one msgid, 37 ms apart, because `askedBehind` named a row that was not
# the window's head. Run 16 saw it once in four control runs. Run 17 ran fourteen
# and saw none — and said why its zero was worth less than it looked:
#
#     A duplicate needs two asks to be a duplicate, and the control makes
#     exactly two per run — where run 16's control run that did show the
#     duplicate made five. Fourteen runs here buy about 25 asks; run 16's four
#     bought about 20.
#
# The channel had drifted. `#scrollback` held run 15's 900 seeded lines, and a
# hundred-odd sessions of join and quit noise pushed them out of ergo's 2048-event
# buffer, so a walk reached the end of what the server had after two pages and
# stopped asking. Re-seeded to 2400 lines, the buffer is seeded history again and
# ten pages sit behind the landing page.
#
# So this run changes exactly one thing from run 17's arm: **the exposure**. Each
# run makes ten-odd asks rather than two, and twelve runs buy more of them than
# every previous arm put together.
#
# Unloaded by default, which is deliberate. Run 16 saw the duplicate on an idle
# machine and run 17 saw none under thirty-two spinners; the one condition a
# duplicate has ever appeared in is this one, and adding load would change two
# variables at once. Pass a spinner count to walk the other arm.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
PORT=${4:?first tap port}
SPINNERS=${5:-0}

HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
TAP="$TREE/docs/end-to-end-16/tap.py"
AHEAD="$TREE/docs/end-to-end-17/ahead.py"
mkdir -p "$OUT"

SPIN=()
for _ in $(seq 1 "$SPINNERS"); do
  bash -c 'while :; do :; done' &
  SPIN+=($!)
done
cleanup() {
  [ ${#SPIN[@]} -eq 0 ] || kill "${SPIN[@]}" 2>/dev/null || true
  [ ${#SPIN[@]} -eq 0 ] || wait "${SPIN[@]}" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== $RUNS two-launch runs, $SPINNERS spinners on $(nproc) cores"

for run in $(seq 1 "$RUNS"); do
  DIR="$OUT/run$run"
  mkdir -p "$DIR"
  TAP_PORT=$((PORT + run))

  python3 "$TAP" "$TAP_PORT" 127.0.0.1:6677 "$DIR/wire.log" &
  TAP_PID=$!
  sleep 1

  # The first launch builds the archive and keeps the profile. The second opens
  # on it: the pane has no message to ask the archive from, so it asks with
  # `before` null, `load_history` answers with the newest page it holds, and the
  # server's own history lands while that read is in flight. That is the shape
  # both #494 and #496 need, and only a second launch has it.
  PROFILE=$(
    {
      echo "wait 9000"
      echo "quit"
    } | node "$HARNESS" --release --server "127.0.0.1:$TAP_PORT" \
          --join '#scrollback' --keep 2>&1 \
      | tee "$DIR/first.log" \
      | sed -n 's/^ok profile kept at //p'
  )

  if [ -z "$PROFILE" ]; then
    echo "run $run: no profile kept — see $DIR/first.log"
    kill "$TAP_PID" 2>/dev/null || true
    continue
  fi

  # Twelve bursts where run 16 used two. Each one over-scrolls to the top, which
  # is what asks for the page behind; the page lands, the anchor holds the reader
  # where they were, and the next burst has somewhere to go. Ten pages are
  # available, so the walk runs out of history before it runs out of bursts.
  {
    echo "wait 10000"
    echo "ss $DIR/second-a.png"
    for _ in $(seq 1 12); do
      echo "wheel 660 400 -1600"
      echo "wait 3500"
    done
    echo "ss $DIR/second-b.png"
    echo "quit"
  } | node "$HARNESS" --release --profile "$PROFILE" > "$DIR/second.log" 2>&1 \
    || echo "    run $run second launch exited $?"

  kill "$TAP_PID" 2>/dev/null || true
  wait "$TAP_PID" 2>/dev/null || true
  # A profile is an archive of two thousand messages on a tmpfs, and this run
  # makes two dozen of them.
  rm -rf "$PROFILE"

  if [ -s "$DIR/wire.log" ]; then
    printf 'run %2d: ' "$run"
    python3 "$AHEAD" "$DIR/wire.log" | tail -5 | tr '\n' ' '
    echo
  else
    echo "run $run: no wire log"
  fi
done

echo "=== every run together"
cat "$OUT"/run*/wire.log > "$OUT/all.log"
python3 "$AHEAD" "$OUT/all.log" | tee "$OUT/ahead.txt" | tail -8
