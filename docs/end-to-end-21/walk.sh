#!/usr/bin/env bash
# Turns the switches on and walks the four things no test can drive.
#
#     walk.sh <tree> <output directory> <port>
#
# The client is driven through a fifo rather than a piped-in script, because the
# walk is three things taking turns: the window, the second client saying
# something, and the X focus moving. Run 18's shape — a here-doc of window
# commands — cannot say "now blur the window, *then* speak".
#
# What each segment asks, in the order they are cheapest to set up:
#
#   focused-watching   a highlight in the conversation on screen, window
#                      focused. `watching()` should swallow it.
#   blurred            the same line with the focus taken away. This is the one
#                      that has never been seen: `onFocusChanged` is the only
#                      input, and no test can drive it.
#   refocused          and back, to show the first result was the rule rather
#                      than a daemon that had stopped listening.
#   burst              twenty at once, on the fakelag-free server, to see
#                      whether twenty arrive and whether they arrive as one
#                      batch.
#   query              a PRIVMSG to the walker rather than to the channel, for
#                      the other title: the sender's nick alone.
#
# Markers go into the notification log itself so that the segments are separated
# by position in one file rather than by two clocks that do not share a zero.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
PORT=${3:?port}
source "$OUT/bus.env"
mkdir -p "$OUT/shots"

LOG="$OUT/notifications.jsonl"
FIFO="$OUT/cmds"
rm -f "$FIFO"
mkfifo "$FIFO"

# A profile of its own rather than one a previous walk kept: both switches
# default to off, and the walk turns them on by clicking. On a profile that has
# already been through this, the same two clicks turn them off again.
node "$TREE/.claude/skills/run-ircx/window.mjs" --release \
  --server "127.0.0.1:$PORT" --join '#harness' --keep \
  < "$FIFO" > "$OUT/walk.log" 2>&1 &
WINDOW=$!
exec 3> "$FIFO"

cleanup() {
  exec 3>&- || true
  wait "$WINDOW" 2>/dev/null || true
}
trap cleanup EXIT

# `w` writes a window command and gives it time to happen: nothing here reads
# the `ok` back, so the sleep is what keeps the walk in step with the window.
w() { echo "$*" >&3; sleep 1; }
mark() { printf '{"call": "mark", "what": "%s"}\n' "$1" >> "$LOG"; }
say() { printf '%s\n' "$*" >> "$OUT/control"; }
# A focus call that fails is worth seeing rather than worth aborting on: the
# segments after it still measure something, and the log says which state they
# were measured in.
focus() { "$OUT/xfocus" "$DISPLAY_USED" "$1" || mark "xfocus-$1-failed"; sleep 1; }
where() { "$OUT/xfocus" "$DISPLAY_USED" which || true; }

# window.mjs prints the display it made; the focus helper needs the same one.
for _ in $(seq 60); do
  DISPLAY_USED=$(grep -o '^ok ready :[0-9]*' "$OUT/walk.log" 2>/dev/null | grep -o ':[0-9]*' || true)
  [ -n "${DISPLAY_USED:-}" ] && break
  sleep 0.5
done
[ -n "${DISPLAY_USED:-}" ] || { echo "window.mjs never said which display" >&2; exit 1; }
echo "driving $DISPLAY_USED"
mark "walk-start on $DISPLAY_USED against 127.0.0.1:$PORT"

w "wait 7000"
w "ss $OUT/shots/w0-joined.png"

# --- the switches ---------------------------------------------------------
w "key ctrl+comma"
w "wait 1200"
w "click 170 177"
w "wait 900"
w "click 348 398"       # Notify me about highlights
w "wait 900"
w "click 348 446"       # Notify me about direct messages
w "wait 900"
w "ss $OUT/shots/w1-switches-on.png"
w "key Escape"
w "wait 1200"
w "ss $OUT/shots/w2-back-to-channel.png"

where

# --- 1. focused, and looking straight at the channel -----------------------
mark "focused-watching"
say "walker: this one lands while you are looking at it"
sleep 5
w "ss $OUT/shots/w3-focused-watching.png"

# --- 2. the focus taken away -----------------------------------------------
mark "blurred"
focus away
where
say "walker: and this one lands while you are not"
sleep 5
w "ss $OUT/shots/w4-blurred.png"

# --- 3. and given back ------------------------------------------------------
mark "refocused"
focus back
where
say "walker: back again, and this should be quiet"
sleep 5

# --- 4. twenty at once ------------------------------------------------------
mark "burst"
focus away
for i in $(seq -w 1 20); do say "walker: burst $i"; done
sleep 10
w "ss $OUT/shots/w5-burst.png"

# --- 5. a query rather than a channel ---------------------------------------
mark "query"
say "/raw PRIVMSG walker :a line with nobody else in it"
sleep 5
w "ss $OUT/shots/w6-query.png"

mark "done"
w "quit"
sleep 3

echo "=== what the daemon was told"
cat "$LOG"
