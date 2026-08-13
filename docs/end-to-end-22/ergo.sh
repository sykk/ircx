#!/usr/bin/env bash
# Starts an ergo of this run's own, on 6688, with fakelag off.
#
#     ergo.sh <output directory> <port>
#
# **Check the port is free, and check the listener is yours.** The first version
# of this took 6688 and reported success, and 6688 was another session's proxy
# forwarding to their ergo on 6677. The whole first walk ran against it: the
# notifications were real, and the burst was shaped by a fakelag this run had
# switched off in a config nothing was reading. `ss | grep :<port>` answers
# "somebody is listening", which is not the question. Run 19 learned the same
# thing about `pgrep -x ircx` matching another session's build — a shared
# machine means a name is not an identity, and neither is a port.
#
# Not the operator's `ircd.yaml`: run 19 found `#scrollback` had drifted out of
# its buffer under a hundred sessions of other runs' noise, and a walk that
# edits a shared server's config is how the next run inherits a surprise.
#
# Fakelag is the reason for the copy. It allows five commands and then two a
# second, which turns the burst of twenty into eight seconds of dribble — and
# the burst is one of the four questions. What is being asked is what the client
# does when twenty highlights land at once, not what a server lets one client
# send, so the limit is the harness's to remove.
set -euo pipefail

OUT=${1:?output directory}
PORT=${2:?port}
ERGO=$HOME/ergo/ergo-2.19.0-linux-x86_64
mkdir -p "$OUT/ergo"

if ss -lnt 2>/dev/null | grep -qE "[:.]$PORT\b"; then
  echo "port $PORT is already somebody's; pick another" >&2
  exit 1
fi

sed -e "s/^\( *\)\"127\.0\.0\.1:6667\":/\1\"127.0.0.1:$PORT\":/" \
    -e "s/^\( *\)\"\[::1\]:6667\":/\1\"[::1]:$PORT\":/" \
    "$ERGO/ircd.yaml" > "$OUT/ergo/ircd.yaml"

# `enabled: true` appears once under `fakelag:` and this is the only knob this
# run changes, so the whole block is rewritten rather than matched loosely.
python3 - "$OUT/ergo/ircd.yaml" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
text, count = re.subn(r"(?m)^(fakelag:\n(?:.*\n)*?    enabled: )true$", r"\1false", text)
if count != 1:
    sys.exit(f"expected one fakelag block, rewrote {count}")
open(path, "w").write(text)
PY
# `datastore.path` is relative, so running from this directory is what keeps the
# database beside the config rather than in the operator's. The other two
# relative paths in the config point at files this run does not copy.
ln -sfn "$ERGO/languages" "$OUT/ergo/languages"
ln -sf "$ERGO/ergo.motd" "$OUT/ergo/ergo.motd"
cd "$OUT/ergo"
[ -f ircd.db ] || "$ERGO/ergo" initdb --conf ircd.yaml
"$ERGO/ergo" run --conf ircd.yaml > "$OUT/ergo/ergo.log" 2>&1 &
echo $! > "$OUT/ergo.pid"

ERGOPID=$(cat "$OUT/ergo.pid")
for _ in $(seq 40); do
  # The pid in the socket's own line, not merely that the port answers.
  if ss -lntp 2>/dev/null | grep "127.0.0.1:$PORT" | grep -q "pid=$ERGOPID,"; then
    echo "ergo listening on 127.0.0.1:$PORT, pid $ERGOPID"
    exit 0
  fi
  sleep 0.25
done
echo "ergo never took 127.0.0.1:$PORT; see $OUT/ergo/ergo.log" >&2
ss -lntp 2>/dev/null | grep ":$PORT" >&2 || true
exit 1
