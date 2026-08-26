#!/usr/bin/env bash
#
# Stands up the rig `crates/ircx-core/tests/hexchat_dcc.rs` runs against: an IRC
# server, a headless display, and HexChat on it.
#
# HexChat is the point. Every other DCC test in this repository is ircx against
# ircx, which agrees with itself by construction; the protocol has no
# specification and several dialects, so the only thing that can say whether
# ircx reads it the way other clients write it is another client.
#
#   scripts/dcc-interop.sh up      # start it, print the environment to export
#   scripts/dcc-interop.sh test    # start it if needed, then run the probes
#   scripts/dcc-interop.sh down    # stop what this script started
#
# Everything lands under $IRCX_DCC_LAB (default below). Nothing outside it is
# touched, and `down` kills only the pids this script wrote — there may be
# another ergo on this machine that belongs to somebody else.

set -euo pipefail

LAB=${IRCX_DCC_LAB:-${TMPDIR:-/tmp}/ircx-dcc-lab}
PORT=${IRCX_DCC_PORT:-6699}
PEER=${IRCX_DCC_PEER:-hexer}
DISPLAY_NUMBER=${IRCX_DCC_DISPLAY:-:91}
ERGO=${IRCX_ERGO:-$HOME/ergo/ergo-2.19.0-linux-x86_64}

# HexChat is throttled so that a transfer has a middle: on loopback a few
# hundred kilobytes arrive faster than anything can be observed part-way
# through. Bytes per second.
THROTTLE=${IRCX_DCC_THROTTLE:-60000}

need() {
	command -v "$1" > /dev/null || {
		echo "$1 is not on PATH; the rig needs it" >&2
		exit 1
	}
}

start_ergo() {
	[ -x "$ERGO/ergo" ] || {
		echo "no ergo at $ERGO — set IRCX_ERGO" >&2
		exit 1
	}
	# A copy of the shipped config on a port of this rig's own, so the run
	# cannot collide with a server somebody else started. The TLS listener
	# goes with it: it wants certificate files that are not here, and ircx
	# dials this in plaintext.
	python3 - "$ERGO/default.yaml" "$LAB/ircd.yaml" "$PORT" << 'PY'
import re, sys
source, into, port = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(source).read().splitlines()
kept, dropping, depth = [], False, 0
for line in lines:
    indent = len(line) - len(line.lstrip())
    if dropping and (line.strip() == "" or indent > depth):
        continue
    dropping = False
    if re.match(r'^\s*":6697":', line):
        dropping, depth = True, indent
        continue
    kept.append(re.sub(r"(127\.0\.0\.1|\[::1\]):(6667|6697)", rf"\1:{port}", line))
text = "\n".join(kept) + "\n"

# Every line a client sends, with a timestamp. The handshake is the evidence a
# failed probe is read against, and it is cheaper to have it always than to
# reproduce a failure with logging turned on. `useroutput` stays excluded:
# including it slows the server enough to matter.
text = re.sub(
    r'^(\s+)type: ".*"$',
    r'\1type: "* -useroutput"',
    text,
    count=1,
    flags=re.MULTILINE,
)
text = re.sub(r"^(\s+)level: info$", r"\1level: debug", text, count=1, flags=re.MULTILINE)

# A cloaked host is what HexChat resolves when it works out what address to put
# in an offer, and it resolves to nothing. Numeric IPs are what a loopback rig
# needs to see of itself.
text = re.sub(
    r"(ip-cloaking:\n(?:\s*#.*\n)*\s+)enabled: true",
    r"\1enabled: false",
    text,
    count=1,
)
open(into, "w").write(text)
PY
	ln -sfn "$ERGO/languages" "$LAB/languages"
	rm -f "$LAB/ircd.lock"
	(cd "$LAB" && "$ERGO/ergo" initdb --conf ircd.yaml > /dev/null 2>&1 || true)
	(cd "$LAB" && nohup "$ERGO/ergo" run --conf ircd.yaml > "$LAB/ergo.log" 2>&1 &)
	sleep 2
	pgrep -f "ergo run --conf ircd.yaml" | head -1 > "$LAB/ergo.pid"
	grep -q "now listening on 127.0.0.1:$PORT" "$LAB/ergo.log" || {
		echo "ergo did not come up; see $LAB/ergo.log" >&2
		exit 1
	}
}

start_display() {
	Xvfb "$DISPLAY_NUMBER" -screen 0 1280x900x24 > "$LAB/xvfb.log" 2>&1 &
	echo $! > "$LAB/xvfb.pid"
	sleep 1
}

configure_hexchat() {
	mkdir -p "$LAB/hexchat" "$LAB/hexchat-downloads" "$LAB/files"
	cat > "$LAB/hexchat/hexchat.conf" << CONF
gui_slist_skip = 1
gui_tray = 0
irc_nick1 = $PEER
irc_user_name = $PEER
irc_real_name = hexchat interop probe
irc_logging = 1
dcc_dir = $LAB/hexchat-downloads
dcc_ip_from_server = 1
dcc_blocksize = 8192
dcc_timeout = 120
dcc_max_send_cps = $THROTTLE
dcc_max_get_cps = $THROTTLE
# Save and resume without asking: the probes drive the ircx side and need
# HexChat to answer rather than open a dialog nobody will click.
dcc_auto_recv = 2
# Readable, so a probe can compare what HexChat wrote against what was sent.
# HexChat's default of 0 writes the file with no permissions at all.
dcc_permissions = 420
CONF
	# F=10 is use-global-user-info plus autoconnect, and no TLS — HexChat
	# assumes TLS for a new network otherwise, and ergo here is plaintext.
	cat > "$LAB/hexchat/servlist.conf" << CONF
v=2.16.2

N=LabNet
L=0
E=UTF-8 (IRC)
F=10
D=0
S=127.0.0.1/$PORT

CONF
	# Two files with content worth comparing byte for byte, big enough that a
	# resume has a middle to start from.
	python3 - "$LAB" << 'PY'
import pathlib, sys
files = pathlib.Path(sys.argv[1], "files")
files.mkdir(parents=True, exist_ok=True)
(files / "from-hexchat.bin").write_bytes(bytes((i * 7 + 3) & 0xFF for i in range(600_000)))
(files / "from-ircx.bin").write_bytes(bytes((i * 11 + 5) & 0xFF for i in range(400_000)))
PY
}

start_hexchat() {
	# `dbus-daemon --fork` rather than `dbus-launch`, because the daemon
	# `dbus-launch` leaves behind inherits this script's stdout and holds it
	# open — which hangs anything reading the script's output to its end.
	exec 3> "$LAB/dbus.pid"
	DBUS_SESSION_BUS_ADDRESS=$(dbus-daemon --session --fork --print-address --print-pid=3)
	exec 3>&-
	export DBUS_SESSION_BUS_ADDRESS
	{
		echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'"
		echo "export DISPLAY='$DISPLAY_NUMBER'"
		echo "export IRCX_DCC_LAB='$LAB'"
		echo "export IRCX_DCC_PORT='$PORT'"
		echo "export IRCX_DCC_PEER='$PEER'"
	} > "$LAB/env.sh"
	DISPLAY=$DISPLAY_NUMBER nohup hexchat -d "$LAB/hexchat" > "$LAB/hexchat.log" 2>&1 &
	sleep 6
	pgrep -f "hexchat -d $LAB" | head -1 > "$LAB/hexchat.pid"
	grep -q "Welcome" "$LAB/hexchat/logs/labnet/labnet.log" 2>/dev/null || {
		echo "hexchat did not register; see $LAB/hexchat/logs/" >&2
		exit 1
	}
}

up() {
	need Xvfb
	need dbus-daemon
	need hexchat
	need python3
	mkdir -p "$LAB"
	start_ergo
	start_display
	configure_hexchat
	start_hexchat
	echo "rig up in $LAB"
	echo "source $LAB/env.sh"
}

down() {
	for what in hexchat ergo xvfb dbus; do
		[ -f "$LAB/$what.pid" ] || continue
		kill "$(cat "$LAB/$what.pid")" 2> /dev/null || true
		rm -f "$LAB/$what.pid"
	done
	echo "rig down"
}

case "${1:-up}" in
	up) up ;;
	down) down ;;
	test)
		[ -f "$LAB/env.sh" ] && [ -d "/proc/$(cat "$LAB/hexchat.pid" 2> /dev/null || echo 0)" ] || up
		# shellcheck disable=SC1091
		. "$LAB/env.sh"
		cargo test -p ircx-core --test hexchat_dcc -- --ignored --nocapture --test-threads=1
		;;
	*)
		echo "usage: $0 [up|test|down]" >&2
		exit 1
		;;
esac
