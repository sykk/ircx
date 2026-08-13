#!/usr/bin/env bash
# Waits for the control arm to finish, swaps the binary, runs the fix arm.
#
#     thenfix.sh <tree> <scratch dir>
#
# The two arms cannot overlap. They share a machine, and an arm running beside
# another is measuring it — run 17's reason for taking its arms one after the
# other, and it holds on an idle machine too. They also share
# `target/release/ircx`, which is the whole of what tells them apart.
#
# So this waits on the control's own process rather than on a duration, for the
# reason run 17's harness had to learn twice: a sleep standing in for a
# condition holds until the day it does not.
set -euo pipefail

TREE=${1:?tree}
SCRATCH=${2:?scratch dir}
HERE=$(cd "$(dirname "$0")" && pwd)

echo "waiting for the control arm to finish"
while pgrep -f "dupes-deep.sh.*end-to-end-19/before" > /dev/null; do
  sleep 10
done
echo "control arm done"

# Nothing of the control's may still be up: an ircx holding the old binary open
# while it is replaced is a walk on neither build.
#
# By path rather than by name. `pgrep -x ircx` matches any process called ircx
# on the machine, and this one is shared — another session's debug build was
# running throughout, so the name test waited on a process that had nothing to
# do with this run and would never exit.
while pgrep -f "$TREE/target/release/ircx" > /dev/null; do
  sleep 5
done

cp "$SCRATCH/ircx-after" "$TREE/target/release/ircx"
echo "installed the fix binary: $(md5sum "$TREE/target/release/ircx" | cut -d' ' -f1)"

exec bash "$HERE/dupes-deep.sh" "$TREE" "$TREE/docs/end-to-end-19/after" 12 6740
