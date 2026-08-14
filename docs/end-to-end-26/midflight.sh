#!/usr/bin/env bash
# The second reader, who scrolls to the top while the page is already out.
#
#     midflight.sh <tree> <output directory> <hold port> <ergo port>
#
# `walk.sh` waits out the round trip before touching the second pane, so the
# two panes there are never owed the same page at the same time. This is the
# other case, and #517 kept it deliberately: a pane that scrolls to the top
# mid-flight is refused its own request — one is already out for that page —
# and is waiting on the answer all the same, so it says so.
#
# The refusal is what makes the frame readable. Both heads say "Loading older
# messages" and the wire carries one `CHATHISTORY BEFORE`, so the second head
# is not the second request: it is the pane saying it is owed the first.
#
# Both arms are walked. This is not where they differ — a build that reads the
# line off the conversation says "loading" here too — and that is the point of
# taking it: what #517 changed is one of the two ways a pane can be owed a
# page, and nothing had watched the other.
set -euo pipefail

TREE=${1:?tree}
DIR=${2:?output directory}
HOLD=${3:?hold port}
ERGO=${4:?ergo port}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
mkdir -p "$DIR"

python3 "$TREE/docs/end-to-end-26/holdpage.py" "$HOLD" "127.0.0.1:$ERGO" "$DIR/wire.log" \
  > "$DIR/hold.log" 2>&1 &
HOLD_PID=$!
sleep 1

# The left pane's wheel is twenty seconds of the right pane's minute, so the
# frame is inside the flight with room either side of it.
{
  echo "wait 9000"
  echo "key ctrl+backslash"
  echo "wait 4000"
  echo "wheel 880 400 -1200"
  echo "wheel 400 400 -1200"
  echo "wait 1200"
  echo "ss $DIR/1-both-owed-one-page.png"
  echo "quit"
} | node "$HARNESS" --release --server "127.0.0.1:$HOLD" --join '#head' \
  > "$DIR/walk.log" 2>&1 || echo "    the walk exited $?"

kill "$HOLD_PID" 2>/dev/null || true
wait "$HOLD_PID" 2>/dev/null || true

echo "$(grep -c ' >> .*CHATHISTORY BEFORE' "$DIR/wire.log" || true) page-backs asked in $DIR/wire.log"
