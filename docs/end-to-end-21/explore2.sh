#!/usr/bin/env bash
# Opens the Notifications page and turns the Highlights switch on.
#
#     explore2.sh <tree> <output directory> <profile>
#
# Relaunches the profile explore.sh kept, so the network and the channel are
# already there. What this is for is the second coordinate — where the switch
# sits — and the answer to the permission question: on Linux there is usually
# nothing to grant, and what `requestPermission` does when the switch goes on
# has never been watched.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
PROFILE=${3:?profile}
source "$OUT/bus.env"
mkdir -p "$OUT/shots"

{
  echo "wait 6000"
  echo "key ctrl+comma"
  echo "wait 1200"
  echo "click 170 177"
  echo "wait 900"
  echo "ss $OUT/shots/e3-notifications.png"
  echo "quit"
} | node "$TREE/.claude/skills/run-ircx/window.mjs" --release \
      --profile "$PROFILE" --keep \
      > "$OUT/explore2.log" 2>&1 || echo "walk exited $?"

tail -2 "$OUT/explore2.log"
