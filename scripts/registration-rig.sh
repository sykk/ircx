#!/usr/bin/env bash
#
# Stands up the server `crates/ircx-core/tests/registration_ergo.rs` runs
# against: an ergo that takes account registrations from a client and lets one
# withdraw its own messages.
#
#   scripts/registration-rig.sh up      # start it, print the environment to export
#   scripts/registration-rig.sh test    # start it if needed, then run the probe
#   scripts/registration-rig.sh down    # stop what this script started
#
# Both capabilities are off or absent in a stock ergo, which is why this rig
# exists rather than a paragraph telling somebody to edit `default.yaml`:
# `draft/account-registration` needs `accounts.registration.enabled`, and
# `draft/message-redaction` is not advertised at all until
# `history.retention.allow-individual-delete` is on. A run against a server
# without them is a run that proves the client degrades, which is a different
# test and one `tests/session.rs` already does.
#
# Everything lands under $IRCX_REG_LAB and nothing outside it is touched. The
# port is the rig's own and so is the name of the config, and that name is what
# `down` goes by — an ergo running from `registration.yaml` was started here,
# where one running from `ircd.yaml` belongs to somebody else and is never
# touched. `scripts/sasl-rigs.sh` says why that is the test rather than a pid
# file, and its `rig_ergo` is this one: a stale pid reads as "nothing to stop"
# while the server is still up.

set -euo pipefail

LAB=${IRCX_REG_LAB:-${TMPDIR:-/tmp}/ircx-registration-lab}
PORT=${IRCX_REG_PORT:-6694}
ERGO=${IRCX_ERGO:-$HOME/ergo/ergo-2.19.0-linux-x86_64}

need() {
	command -v "$1" > /dev/null || {
		echo "$1 is not on PATH; the rig needs it" >&2
		exit 1
	}
}

# Every ergo this rig has running.
#
# `pgrep -f` matches on the whole command line, so a shell invoked with this
# pattern in its own arguments matches too — and `down` would kill the caller.
# The `comm` check is what tells a server from anything else merely mentioning
# one; `scripts/sasl-rigs.sh` learned it the hard way.
rig_ergo() {
	local pid
	for pid in $(pgrep -f "ergo run --conf registration.yaml" 2> /dev/null || true); do
		[ "$(cat "/proc/$pid/comm" 2> /dev/null)" = "ergo" ] || continue
		echo "$pid"
	done
}

write_config() {
	# The shipped config with this rig's port on it, its own name, and the two
	# settings the probe is about turned on.
	python3 - "$ERGO/default.yaml" "$LAB/registration.yaml" "$PORT" << 'PY'
import sys

source, into, port = sys.argv[1:4]
text = open(source).read()

# This rig's own listener, both loopback families as the shipped config has
# them. A rig has no business listening off this machine, so the `:6697` TLS
# listener goes: nothing here speaks TLS.
text = text.replace(
    '"127.0.0.1:6667": # (loopback ipv4, localhost-only)\n        "[::1]:6667":     # (loopback ipv6, localhost-only)',
    f'"127.0.0.1:{port}":\n        "[::1]:{port}":',
)
# The TLS listener is a block with its own keys under it, and its certificate
# does not exist here. Dropping the key alone would orphan the `tls:` beneath
# it, which ergo then reads as a listener with no certificate — so the whole
# block goes: the key line and every line indented past it.
lines = text.split("\n")
kept, skipping = [], False
for line in lines:
    if line.strip() == '":6697":':
        skipping = True
        continue
    if skipping:
        if line.strip() == "" or line.startswith(" " * 12):
            continue
        skipping = False
    kept.append(line)
text = "\n".join(kept)
if '":6697"' in text:
    sys.exit("the TLS listener is still in the config")

# What the probe is here to exercise. Ergo stops advertising
# `draft/message-redaction` entirely when this is off, so without it the client
# refuses `/redact` before a line reaches the server and the probe measures its
# own refusal.
before = text
text = text.replace(
    "        allow-individual-delete: false", "        allow-individual-delete: true"
)
if text == before:
    sys.exit("allow-individual-delete not found in the shipped config")

open(into, "w").write(text)
PY
}

start_ergo() {
	[ -x "$ERGO/ergo" ] || {
		echo "no ergo at $ERGO — set IRCX_ERGO" >&2
		exit 1
	}
	if [ -n "$(rig_ergo)" ]; then
		echo "  ergo: already up"
		return
	fi
	mkdir -p "$LAB"
	write_config
	ln -sfn "$ERGO/languages" "$LAB/languages"
	rm -f "$LAB/ircd.lock"
	(cd "$LAB" && "$ERGO/ergo" initdb --conf registration.yaml > /dev/null 2>&1 || true)
	# `setsid --fork` so the daemon leaves this script's process tree: a child
	# is one the shell waits for on the way out, and `test` then never returns
	# to whatever is reading its output. #671, in `scripts/sasl-rigs.sh`.
	(cd "$LAB" && setsid --fork "$ERGO/ergo" run --conf registration.yaml > "$LAB/ergo.log" 2>&1 < /dev/null &)
	sleep 2
	grep -q "now listening on 127.0.0.1:$PORT" "$LAB/ergo.log" || {
		echo "ergo did not come up; see $LAB/ergo.log" >&2
		exit 1
	}
}

# The probe registers a fresh account on every run, because that is the thing
# being measured. Ergo keeps accounts in `ircd.db`, so a second run would meet
# `ACCOUNT_EXISTS` and measure the refusal instead — the probe names its
# account after the clock for that reason, and this is the other half of it:
# `up` on a lab that already has a database keeps it, and `reset` is how a run
# starts from nothing.
reset_database() {
	stop_ergo
	rm -f "$LAB/ircd.db" "$LAB/ircd.lock"
	echo "  database: cleared"
}

stop_ergo() {
	local pids
	pids=$(rig_ergo)
	if [ -z "$pids" ]; then
		echo "  ergo: not running"
		return
	fi
	# shellcheck disable=SC2086
	kill $pids
	echo "  ergo: stopped ($pids)"
}

environment() {
	echo
	echo "export IRCX_REG_PORT=$PORT"
}

case "${1:-}" in
	up)
		need python3
		need pgrep
		start_ergo
		echo "  lab:  $LAB"
		environment
		;;
	test)
		need python3
		need pgrep
		start_ergo
		echo
		IRCX_REG_PORT=$PORT cargo test -p ircx-core --test registration_ergo -- \
			--ignored --nocapture --test-threads=1
		;;
	reset)
		reset_database
		;;
	down)
		stop_ergo
		;;
	*)
		echo "usage: $0 {up|test|reset|down}" >&2
		exit 2
		;;
esac
