#!/usr/bin/env bash
# Asks what the client asks the server for, on the second visit to a channel.
#
#     wire.sh <output directory> [upstream host:port]
#
# #496 costs a round trip and draws nothing, so this is read off the socket
# rather than off a screenshot. The shape it needs is a pane opening on a
# timeline that is empty while the archive behind it is not — which is the
# second launch on one profile, and why this runs twice.
#
# The first launch seeds the profile and archives what it sees. The second
# opens on the same archive: the pane has no message to ask the archive from,
# so it asks with `before` null, `load_history` answers with the newest page it
# holds — the first launch's own join, today — and the server's
# `CHATHISTORY LATEST` lands while that read is in flight.
#
# What the defect looks like in the log: a `> CHATHISTORY BEFORE` whose msgid
# resolves, in the `<` lines above it, to a `time=` from today. That asks the
# server again for the page it has just sent. With #496 fixed the ask names the
# oldest message the window holds, which is yesterday's.
set -euo pipefail

OUT=${1:?output directory}
UPSTREAM=${2:-127.0.0.1:6677}
HERE=$(cd "$(dirname "$0")" && pwd)
HARNESS=$(cd "$HERE/../.." && pwd)/.claude/skills/run-ircx/window.mjs
# Run 15 left a stepdelay.py on each of 6691-6695, hours after its walks ended,
# and a tap that cannot bind reads an empty log rather than saying so.
TAP_PORT=${TAP_PORT:-6704}

mkdir -p "$OUT"

python3 "$HERE/tap.py" "$TAP_PORT" "$UPSTREAM" "$OUT/wire.log" &
TAP=$!
trap 'kill $TAP 2>/dev/null || true' EXIT
sleep 1

echo "=== first launch: builds the archive"
PROFILE=$(
  {
    echo "wait 9000"
    echo "ss $OUT/first.png"
    echo "quit"
  } | node "$HARNESS" --release --server "127.0.0.1:$TAP_PORT" \
        --join '#scrollback' --keep 2>&1 \
    | tee "$OUT/first.log" \
    | sed -n 's/^ok profile kept at //p'
)
echo "    profile $PROFILE"
[ -n "$PROFILE" ] || { echo "no profile kept — see $OUT/first.log"; exit 1; }

# The two launches are told apart in one log by where the second session opens.
#
# The scroll is what makes the second launch say anything: the pane has to
# reach back past the archive before it asks the server, and the ask is the
# only place the window's own head appears on the wire. A first version waited
# twelve seconds, took its screenshot while the catch-up was still the newest
# thing on screen, and recorded no `BEFORE` at all.
echo "=== second launch: opens on that archive"
{
  echo "wait 10000"
  echo "ss $OUT/second-a.png"
  echo "wheel 660 400 -1600"
  echo "wait 3000"
  echo "ss $OUT/second-b.png"
  echo "wheel 660 400 -1600"
  echo "wait 4000"
  echo "ss $OUT/second-c.png"
  echo "quit"
} | node "$HARNESS" --release --profile "$PROFILE" 2>&1 | tee "$OUT/second.log"

echo "=== what the client asked for"
grep -n "CHATHISTORY" "$OUT/wire.log" || echo "    none"
