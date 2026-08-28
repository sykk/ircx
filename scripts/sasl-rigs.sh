#!/usr/bin/env bash
#
# Stands up the rigs `crates/ircx-core/tests/scram_ergo.rs` and
# `crates/ircx-core/tests/external_ergo.rs` run against: an ergo listening in
# plaintext and over TLS, the two accounts those probes log in as, and the
# certificates EXTERNAL is about.
#
# Both were a paragraph of instructions at the top of a test file before this.
# Neither is hard, and the EXTERNAL one is a dozen steps — a config with a TLS
# listener, `mkcerts`, two self-signed certificates, an account, and its
# fingerprint registered — which is a dozen chances to stand up something
# subtly different from what the last run measured.
#
#   scripts/sasl-rigs.sh up      # start it, print the environment to export
#   scripts/sasl-rigs.sh test    # start it if needed, then run the probes
#   scripts/sasl-rigs.sh down    # stop what this script started
#
# Everything lands under $IRCX_SASL_LAB (default below), and nothing outside it
# is touched. The ports are the rig's own and so is the name of the config, and
# that name is what `down` goes by: an ergo running from `sasl.yaml` was started
# here, where one running from `ircd.yaml` belongs to somebody else and is never
# touched. A pid file would be the other way to say it, and it is the way this
# rig started out — but a pid written once goes stale, and a stale one reads as
# "nothing to stop" while the server is still up.
#
# The third SASL probe needs no rig at all. `tests/sasl_probe.rs` dials Libera
# to settle what a `904` does, on an account that does not exist, so it borrows
# nobody's credentials:
#
#   cargo test -p ircx-core --test sasl_probe -- --ignored --nocapture

set -euo pipefail

LAB=${IRCX_SASL_LAB:-${TMPDIR:-/tmp}/ircx-sasl-lab}
PORT=${IRCX_SASL_PORT:-6695}
TLS_PORT=${IRCX_SASL_TLS_PORT:-6696}
ERGO=${IRCX_ERGO:-$HOME/ergo/ergo-2.19.0-linux-x86_64}

# The accounts the two probes name. Changing either here changes nothing: they
# are constants in the test files, and this is where they are created.
SCRAM_ACCOUNT=scramwalk
SCRAM_PASSWORD=correct-horse-battery
CERT_ACCOUNT=certwalk
CERT_PASSWORD=correct-horse-battery

# Every ergo this rig has running.
#
# The config name is what tells this rig's server from somebody else's, and the
# process name is what tells a server from anything else that merely mentions
# one: `pgrep -f` matches on the whole command line, so a shell invoked with
# this pattern in its own arguments matches too — and `down` would kill the
# caller. Which it did, once.
rig_ergo() {
	local pid
	for pid in $(pgrep -f "ergo run --conf sasl.yaml" 2> /dev/null || true); do
		[ "$(cat "/proc/$pid/comm" 2> /dev/null)" = "ergo" ] || continue
		echo "$pid"
	done
}

need() {
	command -v "$1" > /dev/null || {
		echo "$1 is not on PATH; the rig needs it" >&2
		exit 1
	}
}

write_config() {
	# The shipped config with this rig's own ports on it, and its own name, so
	# that neither the listeners nor `pgrep` can collide with another ergo.
	python3 - "$ERGO/default.yaml" "$LAB/sasl.yaml" "$PORT" "$TLS_PORT" << 'PY'
import sys

source, into, port, tls_port = sys.argv[1:5]
text = open(source).read()

# The plaintext listener SCRAM signs in over. Both loopback families, the way
# the shipped config has them.
text = text.replace(
    '"127.0.0.1:6667": # (loopback ipv4, localhost-only)\n        "[::1]:6667":     # (loopback ipv6, localhost-only)',
    f'"127.0.0.1:{port}":\n        "[::1]:{port}":',
)

# The TLS listener EXTERNAL needs, which the shipped config offers on every
# interface. A rig has no business listening off this machine.
text = text.replace('        ":6697":\n', f'        "127.0.0.1:{tls_port}":\n')

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
	write_config
	ln -sfn "$ERGO/languages" "$LAB/languages"
	rm -f "$LAB/ircd.lock"
	(cd "$LAB" && "$ERGO/ergo" mkcerts --conf sasl.yaml > /dev/null 2>&1 || true)
	(cd "$LAB" && "$ERGO/ergo" initdb --conf sasl.yaml > /dev/null 2>&1 || true)
	# `setsid --fork` so the daemon leaves this script's process tree: a child
	# is one the shell waits for on the way out, and `test` then never returns
	# to whatever is reading its output. #671.
	(cd "$LAB" && setsid --fork "$ERGO/ergo" run --conf sasl.yaml > "$LAB/ergo.log" 2>&1 < /dev/null &)
	sleep 2
	grep -q "now listening on 127.0.0.1:$PORT" "$LAB/ergo.log" || {
		echo "ergo did not come up; see $LAB/ergo.log" >&2
		exit 1
	}
}

make_certificates() {
	# One certificate for the account and one for nobody, which is the pair the
	# probe is written around: a fingerprint the server knows, and a
	# well-formed certificate it has never been told about.
	[ -f "$LAB/client.pem" ] || {
		openssl req -x509 -newkey rsa:2048 -keyout "$LAB/client.key" \
			-out "$LAB/client.crt" -days 30 -nodes -subj "/CN=$CERT_ACCOUNT" 2> /dev/null
		cat "$LAB/client.crt" "$LAB/client.key" > "$LAB/client.pem"
	}
	[ -f "$LAB/stranger.pem" ] || {
		openssl req -x509 -newkey rsa:2048 -keyout "$LAB/stranger.key" \
			-out "$LAB/stranger.crt" -days 30 -nodes -subj "/CN=stranger" 2> /dev/null
		cat "$LAB/stranger.crt" "$LAB/stranger.key" > "$LAB/stranger.pem"
	}
}

# Registers one account, and says what happened. Run again against the lab it
# already made, it finds the account there and says so rather than failing: the
# database outlives `down`, and a rig that can only be built once is one nobody
# will rebuild.
register() {
	python3 - "$1" "$2" "$3" "$4" "${5:-}" << 'PY'
import socket, ssl, sys, time

host, port, nick, password = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
certificate = sys.argv[5] or None

if certificate:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    # The server's own certificate is the self-signed one `mkcerts` wrote a
    # minute ago. What is being checked here is the client's, by fingerprint.
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    context.load_cert_chain(certificate)
    sock = context.wrap_socket(
        socket.create_connection((host, port), timeout=15), server_hostname=host
    )
else:
    sock = socket.create_connection((host, port), timeout=15)
sock.settimeout(1.0)


def read(seconds):
    end, buffer = time.time() + seconds, b""
    while time.time() < end:
        try:
            chunk = sock.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            break
        buffer += chunk
        # A server that answers early is not a reason to keep waiting.
        if b"NOTICE" in buffer or b"NICKNAME_RESERVED" in buffer:
            end = min(end, time.time() + 0.5)
    return buffer.decode(errors="replace")


sock.sendall(f"NICK {nick}\r\nUSER {nick} 0 * :{nick}\r\n".encode())
seen = read(3)
sock.sendall(f"PRIVMSG NickServ :REGISTER {password}\r\n".encode())
seen += read(3)
if certificate:
    # No argument: the fingerprint of the connection this is running over.
    sock.sendall(b"PRIVMSG NickServ :CERT ADD\r\n")
    seen += read(3)

held = "Account created" in seen
taken = "NICKNAME_RESERVED" in seen or "already" in seen.lower()
sock.sendall(b"QUIT\r\n")
sock.close()

if held:
    print(f"    {nick}: account created")
elif taken:
    print(f"    {nick}: account was already there")
else:
    print(f"    {nick}: neither created nor found\n{seen}", file=sys.stderr)
    sys.exit(1)
PY
}

make_accounts() {
	echo "  accounts:"
	register 127.0.0.1 "$PORT" "$SCRAM_ACCOUNT" "$SCRAM_PASSWORD"
	register 127.0.0.1 "$TLS_PORT" "$CERT_ACCOUNT" "$CERT_PASSWORD" "$LAB/client.pem"
}

up() {
	need openssl
	need python3
	mkdir -p "$LAB"
	start_ergo
	make_certificates
	make_accounts
	{
		echo "export IRCX_SASL_LAB='$LAB'"
		echo "export IRCX_SASL_PORT='$PORT'"
		echo "export IRCX_SASL_TLS_PORT='$TLS_PORT'"
		echo "export IRCX_CLIENT_CERT='$LAB/client.pem'"
		echo "export IRCX_STRANGER_CERT='$LAB/stranger.pem'"
	} > "$LAB/env.sh"
	echo "rig up in $LAB"
	echo "source $LAB/env.sh"
}

down() {
	local running
	running=$(rig_ergo)
	if [ -n "$running" ]; then
		# Word-split on purpose: a rig that somehow has two takes two kills.
		# shellcheck disable=SC2086
		kill $running 2> /dev/null || true
	fi
	# Waited for rather than assumed: ergo writes its database out on the way
	# down, and an `up` that starts while the old one still holds the port gets
	# a server that cannot listen.
	for _ in $(seq 1 20); do
		[ -z "$(rig_ergo)" ] && break
		sleep 0.5
	done
	[ -z "$(rig_ergo)" ] || {
		echo "ergo is still running after 10 seconds: $(rig_ergo)" >&2
		exit 1
	}
	echo "rig down"
}

case "${1:-up}" in
	up) up ;;
	down) down ;;
	test)
		[ -f "$LAB/env.sh" ] && [ -n "$(rig_ergo)" ] || up
		# shellcheck disable=SC1091
		. "$LAB/env.sh"
		cargo test -p ircx-core --test scram_ergo -- --ignored --nocapture
		cargo test -p ircx-core --test external_ergo -- --ignored --nocapture
		;;
	*)
		echo "usage: $0 [up|test|down]" >&2
		exit 1
		;;
esac
