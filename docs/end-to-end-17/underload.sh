#!/usr/bin/env bash
# Run 16's walk, with the machine contended, read off the wire.
#
#     underload.sh <tree> <output directory> <walks> <tap port> [spinners]
#
# Runs 14, 15 and 16 each named a machine under load and none of them ran one.
# It is not a fourth item on that list: it is the instrument #494 needs, and the
# argument is in the code rather than in the wish.
#
# #494 is a race between two reads. `loadOlder` asks the archive with `before`
# null, awaits it, and the server's own `CHATHISTORY LATEST` lands while it is
# in flight. The archive answer is then filed in front of the window. Which
# read wins decides whether anything is drawn out of order, and on this machine
# the archive wins nearly every time: the profile is under `/tmp`, which is a
# tmpfs, so `load_history` is a RAM read behind an index, and ergo is a local
# socket a millisecond away.
#
# So the disk is not the lever and there is no point loading it. What stretches
# the archive read is the CPU: `load_history` is a 200-row page followed by
# `attach_reactions`, `attach_annotations` and `attach_raised`, each of which
# runs *one statement per message* — six hundred executions behind a Tauri
# command, on a runtime whose threads have to be scheduled. Contend for those
# and the read stretches; the socket does not.
#
# The spinners are plain shell loops rather than a `stress-ng` this machine does
# not have. What they are worth is measured rather than assumed — `spin.log`
# records the walk's own wall clock, so a run that changed nothing says so.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
WALKS=${3:?how many}
PORT=${4:?tap port}
SPINNERS=${5:-16}

HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"

python3 "$HERE/tap.py" "$PORT" 127.0.0.1:6677 "$OUT/wire.log" &
TAP=$!

SPIN=()
for _ in $(seq 1 "$SPINNERS"); do
  # `: ` in a bare loop, which costs a core and no memory. Backgrounded from a
  # subshell so the pid is the loop rather than a pipeline's last stage.
  bash -c 'while :; do :; done' &
  SPIN+=($!)
done

# The tap and every spinner, whichever way this exits. A spinner that outlives
# its run is worse than run 15's leftover taps: that one held a port, this one
# holds a core, and the next walk on this machine would be measuring it.
cleanup() {
  kill "$TAP" "${SPIN[@]}" 2>/dev/null || true
  wait "$TAP" "${SPIN[@]}" 2>/dev/null || true
}
trap cleanup EXIT

sleep 1
echo "=== $SPINNERS spinners on $(nproc) cores, tap on $PORT"
uptime > "$OUT/spin.log"

started=$SECONDS
"$TREE/docs/end-to-end-16/head.sh" "$OUT" "$WALKS" "127.0.0.1:$PORT" \
  || echo "head.sh exited $?"
echo "walks took $((SECONDS - started))s under $SPINNERS spinners" >> "$OUT/spin.log"
uptime >> "$OUT/spin.log"

echo "=== whether the client asked from the oldest row it holds"
python3 "$HERE/ahead.py" "$OUT/wire.log" | tee "$OUT/ahead.txt"
