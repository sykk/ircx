#!/usr/bin/env bash
# Reads a channel back to its start on the second visit to it.
#
#     revisit.sh <tree> <output directory> <runs> <proxy port>
#
# Run 17 measured one difference between the build before #494/#496 and the one
# after, and could not explain it: on identical two-launch runs the fixed build
# asked the server for a page six times where the old build asked twice, and the
# old build's two was steady enough to look like a wall. The candidate it named
# was the `#487` guard skipping an ask it should have made, which would mean a
# reader who stops short of history the server still holds.
#
# A count cannot tell that from a walk that simply ran out of channel, and every
# walk then had a channel that ran out in two asks. `#scrollback` holds eleven
# pages (run 28, `depth.py`), so two asks now means eight pages left behind and
# the wall is visible as a wall.
#
# The two launches are run 16's shape and are what the archive read needs: the
# first fills the archive, the second opens a pane on it with an empty timeline,
# so the pane asks the archive with `before` null and the server's own
# `CHATHISTORY LATEST` lands while that read is in flight. That race is what
# #494 ordered and #496 asked from the head of; a fresh profile has no archive
# to race and reaches neither.
#
# The proxy is run 27's under `--pass`, which replaces nothing and is here to
# write the log `chain.py` and `reach.py` read.
#
# `--load` is thirty-two spinners on sixteen cores, which is the level run 17
# measured its two-launch counts under and run 22 found changed the app's
# behaviour where sixteen did not. The read this walk is about is a race — the
# archive answering while the server's own catch-up lands — so an arm that
# never contends may never reach the state the builds disagree about.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
PORT=${4:?proxy port}
LOAD=${5:-}

HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
# Eleven pages and three bursts of slack, so a run that stops early stopped
# rather than ran out of wheel.
BURSTS=14
mkdir -p "$OUT"

python3 "$HERE/../end-to-end-27/replaypage.py" "$PORT" 127.0.0.1:6677 "$OUT/wire.log" --pass &
PROXY=$!
SPINNERS=()
if [ "$LOAD" = "--load" ]; then
  for _ in $(seq 32); do
    bash -c 'while :; do :; done' &
    SPINNERS+=($!)
  done
  echo "=== 32 spinners up"
fi
cleanup() {
  kill "$PROXY" "${SPINNERS[@]}" 2>/dev/null || true
  wait "$PROXY" 2>/dev/null || true
}
trap cleanup EXIT
sleep 1

for run in $(seq -w 1 "$RUNS"); do
  echo "=== run $run, first launch: fills the archive"
  PROFILE=$(
    {
      echo "wait 9000"
      echo "ss $OUT/r$run-a-first.png"
      echo "quit"
    } | node "$HARNESS" --release --server "127.0.0.1:$PORT" --join '#scrollback' --keep \
      2>&1 | tee "$OUT/r$run-first.log" | sed -n 's/^ok profile kept at //p'
  )
  [ -n "$PROFILE" ] || { echo "    no profile kept — see $OUT/r$run-first.log"; continue; }

  echo "=== run $run, second launch: opens on it and reads back"
  {
    # The archive read and the server's catch-up both have to have landed
    # before anything is scrolled, or the walk scrolls a pane still filling.
    echo "wait 10000"
    echo "ss $OUT/r$run-b-foot.png"
    for burst in $(seq "$BURSTS"); do
      echo "wheel 660 400 -1600"
      echo "wait 4000"
      if [ "$burst" = 5 ]; then echo "ss $OUT/r$run-c-midway.png"; fi
    done
    echo "ss $OUT/r$run-d-top.png"
    echo "quit"
  } | node "$HARNESS" --release --profile "$PROFILE" > "$OUT/r$run-second.log" 2>&1 \
    || echo "    second launch exited $?"
  rm -rf "$PROFILE"

  grep -c '^ *[0-9.]* ask ' "$OUT/wire.log" | xargs echo "    asks on the wire so far:"
done

echo "=== the chain"
python3 "$HERE/../end-to-end-28/chain.py" "$OUT/wire.log" | tee "$OUT/chain.txt"
echo "=== what each ask named, and where the reader stopped"
python3 "$HERE/reach.py" "$OUT/wire.log" | tee "$OUT/reach.txt"
