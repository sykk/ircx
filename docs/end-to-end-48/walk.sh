#!/usr/bin/env bash
# The unread seam across a search jump, and the rule #622 draws where the
# window stops.
#
#     TREE=<checkout> walk.sh <name> <ergo port> [bulk] [away] [hit] [late]
#
# Needs an `ergo` — `docs/end-to-end-23/ergo.sh <dir> <port>` — and the debug
# binary built once: `cargo build --manifest-path src-tauri/Cargo.toml
# --no-default-features`.
#
# Run 47 walked the jump and left the seam alone, in as many words. #623 is what
# reading the store afterwards found: `replaceHistory` wrote `{
# ...EMPTY_TIMELINE, messages }`, and two of the fields that reset — the message
# the unread rule is drawn against, and the marker the server sets — are not
# facts about the window being filed.
#
# So the arrangement has to *make* a seam before it can ask what a jump does to
# one, and that is the shape of this walk:
#
#   * the reader watches five hundred lines arrive, caught up, no rule;
#   * the reader goes elsewhere and a dozen more are said behind their back,
#     which is what opens a seam;
#   * the reader comes back to it — the frame that proves there was a rule;
#   * the reader searches, jumps into the middle of the archive, and the channel
#     says a few more things to a window that has stopped;
#   * `Jump to latest` reads the tail back, and the rule is either drawn against
#     the same message or it is gone.
#
# The last frame is the whole finding, and the frame before it carries #622's:
# a gap rule where the window stops, which has never been seen in the running
# client.
set -euo pipefail
TREE=${TREE:?the checkout to walk}
HERE="$(cd "$(dirname "$0")" && pwd)"
NAME=${1:?name}
ERGO=${2:?ergo port}
BULK=${3:-500}
AWAY=${4:-12}
HIT=${5:-120}
LATE=${6:-6}
DIR="$HERE/$NAME"
CHANNEL="#run48$NAME"
ELSEWHERE="#quiet48$NAME"
mkdir -p "$DIR"
rm -f "$DIR"/*.png

# One nick per burst, and the bursts never overlap: run 47 found ergo filing one
# connection's queue late enough to put `line 0120` between `0101` and `0102`,
# and a walk that reads the numbers as an order cannot afford that. Here the
# marks serialise them — each talker waits for a frame the one before it made.
python3 "$HERE/talker.py" "127.0.0.1:$ERGO" "$CHANNEL" 1 "$BULK" \
  --nicks historian --after "$DIR/seed-go.png" > "$DIR/bulk.log" 2>&1 &
BULK_PID=$!
python3 "$HERE/talker.py" "127.0.0.1:$ERGO" "$CHANNEL" "$((BULK + 1))" "$AWAY" \
  --nicks nightshift --after "$DIR/away-go.png" > "$DIR/away.log" 2>&1 &
AWAY_PID=$!
python3 "$HERE/talker.py" "127.0.0.1:$ERGO" "$CHANNEL" "$((BULK + AWAY + 1))" "$LATE" \
  --nicks latecomer --after "$DIR/talk-go.png" > "$DIR/late.log" 2>&1 &
LATE_PID=$!
trap 'kill "$BULK_PID" "$AWAY_PID" "$LATE_PID" 2>/dev/null || true' EXIT
for _ in $(seq 60); do
  grep -q "^joined" "$DIR/bulk.log" \
    && grep -q "^joined" "$DIR/away.log" \
    && grep -q "^joined" "$DIR/late.log" && break
  sleep 0.5
done
for log in bulk away late; do
  grep -q "^joined" "$DIR/$log.log" || { echo "the $log talker never joined" >&2; exit 1; }
done

{
  # The client connects, joins and settles at the live edge of an empty channel.
  echo "wait 12000"
  # Named rather than clicked: which row the sidebar draws first is not this
  # run's to assume.
  echo "key ctrl+k"
  echo "wait 800"
  echo "type run48$NAME"
  echo "wait 1000"
  echo "key Return"
  echo "wait 1500"
  # The mark. Every line after it is one ircx hears with the reader watching, so
  # none of them is unread and there is no rule anywhere in what follows.
  echo "ss $DIR/seed-go.png"
  echo "wait 25000"
  echo "ss $DIR/at-live.png"
  # Away, and the seam is made while the reader is not looking. `leftBehind`
  # takes the seam of the conversation being left, and this one has none to
  # take.
  echo "key ctrl+k"
  echo "wait 800"
  echo "type quiet48$NAME"
  echo "wait 1000"
  echo "key Return"
  echo "wait 1500"
  echo "ss $DIR/away-go.png"
  echo "wait 9000"
  echo "ss $DIR/elsewhere.png"
  # Back to it. Where the pane lands coming back is its own frame, and the one
  # after it is the control the last frame of all is read against: without a
  # rule there, there is nothing for a jump to take.
  echo "key ctrl+k"
  echo "wait 800"
  echo "type run48$NAME"
  echo "wait 1000"
  echo "key Return"
  echo "wait 2500"
  echo "ss $DIR/returned.png"
  echo "key ctrl+shift+l"
  echo "wait 2500"
  echo "ss $DIR/seam.png"
  # Search this conversation for the one line carrying this number.
  echo "key ctrl+f"
  echo "wait 1200"
  printf 'type %04d\n' "$HIT"
  echo "wait 2000"
  echo "ss $DIR/hits.png"
  echo "key Return"
  echo "wait 3000"
  echo "ss $DIR/jumped.png"
  # Down to the end of what the jump filed, which is where a reader carrying on
  # reading ends up and the only place #622's rule can be seen. Overshot rather
  # than counted: a notch is not a constant between panes, and the scroller
  # clamps.
  echo "wheel 647 400 200"
  echo "wait 1500"
  echo "ss $DIR/parked.png"
  # The channel says a few more things to a window that stopped hundreds of
  # messages ago, which is where #622 draws its rule.
  echo "ss $DIR/talk-go.png"
  echo "wait 6000"
  echo "ss $DIR/after-talk.png"
  # `Jump to latest`, by its own hotkey rather than by a coordinate off a frame:
  # run 47 found no pill to click, and #622 is what put one there.
  echo "key ctrl+shift+l"
  echo "wait 3500"
  echo "ss $DIR/latest.png"
  echo "quit"
} | IRCX_PROBE="$DIR/probe.log" VITE_PROBE=1 VITE_SWATCH=1 \
    node "$TREE/.claude/skills/run-ircx/window.mjs" --server "127.0.0.1:$ERGO" \
    --join "$CHANNEL" --join "$ELSEWHERE" --keep ${WINDOW:-} > "$DIR/walk.log" 2>&1 \
  || echo "    the walk exited $?"

echo "-- what the talkers said --"
grep -h "^said " "$DIR/bulk.log" "$DIR/away.log" "$DIR/late.log" || true
echo "-- the profile --"
grep -i "profile kept" "$DIR/walk.log" || true
for frame in at-live returned seam jumped parked after-talk latest; do
  echo "-- $frame --"
  python3 "$TREE/docs/end-to-end-42/sequence.py" "$DIR/$frame.png" left 2>&1 || true
done
