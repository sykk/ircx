#!/usr/bin/env bash
# The pane nobody touched, while the pane beside it is answered late.
#
#     parked.sh <tree> <output directory> <hold port> <ergo port> <hold seconds> <park notches>
#
# Run 23's arrangement — two panes on one conversation, the right one parked a
# few notches up the archive, the left one paging back — with run 30's proxy
# under it and run 30's straddling burst instead of run 23's three frames.
#
# **Where the right pane is parked is an argument because it decides what the
# landing can reach.** Run 23's 300 notches leave it a hundred messages below
# the page boundary, where the only thing that can move it is the scroller. Park
# it just under the top of what the restore read and the arriving page abuts its
# first row, where `groups.ts` can give that row a name it did not have — the
# property run 23's seed exists for, and the case a far-parked pane cannot
# express.
#
# The split is seeded by a first launch and walked by a second, which is run
# 23's shape and is not a convenience: `ctrl+backslash` and the parking wheel
# both have to happen before the page-back does, and a launch that has just
# restored a two-pane tree is also the state #508 was reported in.
#
# The proxy is up across both launches. It holds `CHATHISTORY BEFORE` and
# nothing else, so the first launch's join page and the second launch's restore
# — `TARGETS` and `AFTER`, which `asks.py` found a restored launch makes — cross
# it untouched, and the only thing late in this walk is the page the left pane
# asks for.
set -euo pipefail

TREE=${1:?tree}
DIR=${2:?output directory}
HOLD=${3:?hold port}
ERGO=${4:?ergo port}
SECONDS_HELD=${5:?hold seconds}
PARK=${6:?park notches}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
HERE="$TREE/docs/end-to-end-31"
mkdir -p "$DIR"

python3 "$TREE/docs/end-to-end-30/latepage.py" "$HOLD" "127.0.0.1:$ERGO" "$DIR/wire.log" \
  "$SECONDS_HELD" > "$DIR/hold.log" 2>&1 &
HOLD_PID=$!
sleep 1

PROFILE=$(
  {
    echo "wait 9000"
    echo "key ctrl+backslash"
    echo "wait 2500"
    echo "quit"
  } | node "$HARNESS" --release --server "127.0.0.1:$HOLD" \
        --join '#late' --keep 2>&1 \
    | tee "$DIR/first.log" \
    | sed -n 's/^ok profile kept at //p'
)

if [ -z "$PROFILE" ]; then
  echo "  no profile kept — see $DIR/first.log"
  kill "$HOLD_PID" 2>/dev/null || true
  exit 1
fi

# However far up the right pane is parked, it has to stop inside the messages
# the restore read: a pane that reaches the top of its own content asks for a
# page of its own, and the wire log then holds two asks that no reading can tell
# apart. `parked.png` names the line it stopped on and the count in the line
# below says whether it asked.
#
# The burst then opens twenty-eight seconds before the release could be at its
# earliest and runs fifty-two seconds. **The ask is inside the wheel burst, not
# after it** — a pane asks the moment it reaches the top of its content and the
# burst goes on scrolling against a top it has already reached — so the walk
# cannot know when it is asking and photographs a window instead. Run 30's first
# set counted the wait from the frame after the wheel and put both frames after
# the landing, six walks out of six.
{
  echo "wait 12000"
  echo "wheel 880 400 -$PARK"
  echo "wait 2500"
  echo "ss $DIR/parked.png"
  echo "wheel 400 400 -1600"
  echo "wait 1500"
  echo "ss $DIR/frame-000.png"
  echo "wait $(( (SECONDS_HELD - 28) * 1000 ))"
  for n in $(seq -w 1 26); do
    echo "ss $DIR/frame-$n.png"
    echo "wait 2000"
  done
  echo "quit"
} | node "$HARNESS" --release --profile "$PROFILE" > "$DIR/walk.log" 2>&1 \
  || echo "    the walk exited $?"

kill "$HOLD_PID" 2>/dev/null || true
wait "$HOLD_PID" 2>/dev/null || true
rm -rf "$PROFILE"

echo "  $(grep -c ' >> .*CHATHISTORY BEFORE' "$DIR/wire.log" || true) page-backs asked, \
$(grep -c ' hold ' "$DIR/wire.log" || true) lines held"
python3 "$HERE/pick.py" "$DIR"
