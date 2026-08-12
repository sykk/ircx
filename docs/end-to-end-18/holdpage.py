"""Swallows the server's answer to a page-back, and writes down both directions.

    holdpage.py <listen port> <upstream host:port> <log path> [--pass]

The defect under test needs one condition: the client asks the server for the
page behind its oldest message, and no page ever arrives. `page_back` then
comes back `waiting` — the round trip's own deadline, sixty seconds, having
already been spent inside the awaited call.

Run 15's `delay.py` and `stepdelay.py` hold *everything* the server says. That
is the wrong instrument here: past sixty seconds it holds `PING` with the rest,
and a client that reconnects has left the state under test rather than sat in
it. This one passes every byte through untouched except the lines belonging to
the batch answering a `CHATHISTORY BEFORE`, which it drops on the floor.

So the client's own asks are never held, the session stays up, and the only
thing missing is the page. What a real server does to earn this — a request it
ignores, a batch lost to a netsplit — is not reproduced, only its effect.

`--pass` drops nothing and is the same proxy otherwise. It is how the log is
read against a walk where the page does arrive, because an instrument that
cannot show the working case is not evidence about the broken one.

The log is `tap.py`'s format: monotonic seconds since the first connection, a
direction, and the line.
"""

import socket
import sys
import threading
import time

LISTEN = int(sys.argv[1])
HOST, PORT = sys.argv[2].split(":")
LOG = sys.argv[3]
PASS_THROUGH = "--pass" in sys.argv

started = None
lock = threading.Lock()
log = open(LOG, "w", buffering=1)


def note(direction, line):
    with lock:
        log.write(f"{time.monotonic() - started:9.3f} {direction} {line}\n")


def command_of(line):
    """The command and its arguments, past the tags and the source."""
    rest = line
    if rest.startswith("@"):
        rest = rest.split(" ", 1)[1] if " " in rest else ""
    if rest.startswith(":"):
        rest = rest.split(" ", 1)[1] if " " in rest else ""
    return rest.split(" ")


def tags_of(line):
    if not line.startswith("@"):
        return {}
    raw = line[1:].split(" ", 1)[0]
    out = {}
    for item in raw.split(";"):
        key, _, value = item.partition("=")
        out[key] = value
    return out


class Pump:
    """One client, both directions. The state that matters is shared between
    them: what the client asked for is what decides which batch is dropped."""

    def __init__(self, client, upstream):
        self.client = client
        self.upstream = upstream
        # A `CHATHISTORY BEFORE` has gone up and its batch has not come back.
        self.armed = False
        # The reference of the batch being swallowed, while one is.
        self.dropping = None
        self.asks = 0
        self.dropped = 0

    def up(self):
        """Client to server, verbatim. Nothing the client says is ever held —
        the ask has to reach the server for its deadline to be the real one."""
        for line in lines(self.client):
            words = command_of(line)
            if len(words) > 2 and words[0].upper() == "CHATHISTORY" and words[1].upper() == "BEFORE":
                self.armed = True
                self.asks += 1
                note("ask", line)
            else:
                note("-->", line)
            self.upstream.sendall(f"{line}\r\n".encode())
        shutdown(self.upstream)

    def down(self):
        """Server to client, less the batch that answers an ask."""
        for line in lines(self.upstream):
            if PASS_THROUGH or not self.swallow(line):
                note("<--", line)
                self.client.sendall(f"{line}\r\n".encode())
            else:
                self.dropped += 1
                note("XX ", line)
        shutdown(self.client)

    def swallow(self, line):
        """Whether this line belongs to the batch answering a page-back.

        Ergo answers `CHATHISTORY` inside a batch: an opening `BATCH +ref
        chathistory <target>`, the messages tagged with that reference, and a
        closing `BATCH -ref`. An empty result is the two batch lines and
        nothing between them, which is a page that never lands just as much as
        a lost one is.
        """
        words = command_of(line)
        batch = words[0].upper() == "BATCH"
        if self.dropping is not None:
            if batch and words[1:2] == [f"-{self.dropping}"]:
                self.dropping = None
                return True
            return tags_of(line).get("batch") == self.dropping
        if not self.armed:
            return False
        if batch and words[1:2] and words[1].startswith("+") and words[2:3] == ["chathistory"]:
            self.dropping = words[1][1:]
            self.armed = False
            return True
        # The server can refuse an ask outright rather than answering it with a
        # batch, and a refusal is an answer: the client is not left waiting.
        if words[0].upper() == "FAIL" and words[1:2] == ["CHATHISTORY"]:
            self.armed = False
        return False


def lines(sock):
    """The framing, which is all this proxy needs to understand."""
    buffer = b""
    while True:
        try:
            chunk = sock.recv(65536)
        except OSError:
            return
        if not chunk:
            return
        buffer += chunk
        while b"\n" in buffer:
            raw, buffer = buffer.split(b"\n", 1)
            yield raw.rstrip(b"\r").decode("utf-8", "replace")


def shutdown(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


def serve(client):
    global started
    if started is None:
        started = time.monotonic()
    upstream = socket.create_connection((HOST, int(PORT)))
    pump = Pump(client, upstream)
    threads = [
        threading.Thread(target=pump.up, daemon=True),
        threading.Thread(target=pump.down, daemon=True),
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    note("end", f"asks={pump.asks} dropped={pump.dropped}")


listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", LISTEN))
listener.listen(8)
print(f"holdpage on {LISTEN} -> {HOST}:{PORT}{' (passing)' if PASS_THROUGH else ''}", flush=True)
while True:
    conn, _ = listener.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
