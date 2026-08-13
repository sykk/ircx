#!/usr/bin/env bash
# Sends one notification through `notify-send` on the walk's own bus, to prove
# the instrument records a call before anything is asked of the client.
#
#     probe.sh <output directory>
set -euo pipefail
OUT=${1:?output directory}
source "$OUT/bus.env"
notify-send -a probe "phrack in #harness" "the instrument works"
sleep 1
tail -2 "$OUT/notifications.jsonl"
