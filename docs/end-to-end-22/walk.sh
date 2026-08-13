#!/usr/bin/env bash
# The two-launch restore walk, on either build.
#
#     walk.sh <tree> <output directory> <runs> <first tap port> <ergo port> [--release]
#
# Every walk before run 18 drove the debug build against Vite, which means
# `StrictMode`, which means each effect mounted twice. Run 21 recommended a
# release walk of something already covered for that reason, and the WebKitGTK
# accessibility run named the path where it would show: the restore, which is
# the one that behaves differently under a double mount.
#
# So this is deliberately not a new walk. It is runs 12 to 19's own cycle — a
# channel with history behind it, a kept profile, a second launch that opens on
# an archive — with the pane split before the quit, so what comes back is a tree
# rather than a single pane. What is counted is what reaches the socket.
#
# One tap in front of both launches, so the first launch's asks are on the same
# log as the second's and a session number tells them apart.
set -euo pipefail

TREE=${1:?tree}
OUT=${2:?output directory}
RUNS=${3:?how many}
PORT=${4:?first tap port}
ERGO=${5:?ergo port}
ARM=${6:-}

HARNESS="$TREE/.claude/skills/run-ircx/window.mjs"
ASKS="$TREE/docs/end-to-end-22/asks.py"
TAP="$TREE/docs/end-to-end-22/tap.py"
mkdir -p "$OUT"

BUILD=(--release)
[ "$ARM" = "--release" ] || BUILD=()
echo "=== $RUNS runs, ${BUILD[*]:-debug against Vite}"

for run in $(seq 1 "$RUNS"); do
  DIR="$OUT/run$run"
  mkdir -p "$DIR"
  TAP_PORT=$((PORT + run))

  python3 "$TAP" "$TAP_PORT" "127.0.0.1:$ERGO" "$DIR/wire.log" &
  TAP_PID=$!
  sleep 1

  # The first launch joins, takes its page of history, writes the archive, and
  # splits the pane so there is a tree to restore. `Mod+\` is `pane.splitVertical`
  # and both panes then hold the same conversation, which is the sharper case:
  # two `Timeline` mounts over one store entry, which is the shape a double
  # mount also has.
  PROFILE=$(
    {
      echo "wait 9000"
      echo "ss $DIR/first-joined.png"
      echo "key ctrl+backslash"
      echo "wait 2500"
      echo "ss $DIR/first-split.png"
      echo "quit"
    } | node "$HARNESS" "${BUILD[@]}" --server "127.0.0.1:$TAP_PORT" \
          --join '#restore' --keep 2>&1 \
      | tee "$DIR/first.log" \
      | sed -n 's/^ok profile kept at //p'
  )

  if [ -z "$PROFILE" ]; then
    echo "run $run: no profile kept — see $DIR/first.log"
    kill "$TAP_PID" 2>/dev/null || true
    continue
  fi

  # The second launch opens on that profile as it stands: the layout comes back
  # from `localStorage`, each pane asks the archive with `before` null because it
  # has no message to ask from, and the server's own history lands while those
  # reads are in flight.
  #
  # Then it scrolls, because startup alone asks the server for nothing a mount
  # regime could double. The archive answers a restored pane with 200 messages,
  # which is more than a screenful, so the priming loop in `Timeline.tsx` never
  # runs and `pageBack` — the one path the frontend takes to the socket — is
  # never reached. Eight bursts over-scroll to the top, which is what asks for
  # the page behind, and those asks are `CHATHISTORY BEFORE`: the same ones runs
  # 16 to 19 counted, now on a build that mounts each effect once.
  {
    echo "wait 12000"
    echo "ss $DIR/second-restored.png"
    for _ in $(seq 1 8); do
      echo "wheel 400 400 -1600"
      echo "wait 3500"
    done
    echo "ss $DIR/second-scrolled.png"
    echo "quit"
  } | node "$HARNESS" "${BUILD[@]}" --profile "$PROFILE" > "$DIR/second.log" 2>&1 \
    || echo "    run $run second launch exited $?"

  kill "$TAP_PID" 2>/dev/null || true
  wait "$TAP_PID" 2>/dev/null || true
  rm -rf "$PROFILE"

  if [ -s "$DIR/wire.log" ]; then
    python3 "$ASKS" "$DIR/wire.log"
  else
    echo "run $run: no wire log"
  fi
done
