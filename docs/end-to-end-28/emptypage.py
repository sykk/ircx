"""Answers a page-back with a batch that carries nothing.

    emptypage.py <listen port> <upstream host:port> <log path> [--pass]

The third thing run 27 left unread. A server with no history behind the message
it was asked about answers with an open batch, no messages, and a close — and
`message.rs` reads that as `paged_arrived >= limit` being false, which is `End`,
which is the pane drawing "Beginning of history". Every word of that is argued
from the code. `an_empty_page_is_the_history_running_out` asserts the core half
and `"is the beginning of history once the server has none either"` the frontend
half, and nothing has ever put the two together on a wire.

Which is not for want of trying. It cannot be walked against ergo directly:
`#scrollback` holds 2048 messages, the client asks in pages of 200, and 2048 is
not a multiple of 200 — so the last page comes back short rather than absent,
and short is a different line on the wire even though it is the same branch in
the client. A real server produces this one only where its history divides
exactly by the page size, which is why a proxy is cheaper than arranging it.

Three ways this differs from the two instruments it sits beside:

  * `end-to-end-26/holdpage.py` drops the batch whole, which is the answer never
    arriving — a deadline, and `Waiting`.
  * `end-to-end-27/replaypage.py` replaces the batch's contents with rows the
    client already holds, which is an answer that says nothing — `More`, and the
    wedge that run was about.
  * This drops the contents and keeps the batch, which is an answer that says
    there is nothing there — `End`.

So it holds no state about what the client was sent on joining; the emptying
needs nothing but the batch's own reference. The log is `holdpage.py`'s format,
and `--pass` replaces nothing, for its reason: an instrument that cannot show
the working case is not evidence about the broken one.
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
    out = {}
    for item in line[1:].split(" ", 1)[0].split(";"):
        key, _, value = item.partition("=")
        out[key] = value
    return out


class Pump:
    """One client, both directions."""

    def __init__(self, client, upstream):
        self.client = client
        self.upstream = upstream
        # A `CHATHISTORY BEFORE` has gone up and its batch has not come back.
        self.armed = False
        # The reference of the batch being emptied, while one is.
        self.emptying = None
        self.asks = 0
        self.dropped = 0

    def up(self):
        """Client to server, verbatim. Nothing the client says is ever held."""
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
        for line in lines(self.upstream):
            if PASS_THROUGH:
                self.send(line)
                continue
            for out in self.rewrite(line):
                self.send(out)
        shutdown(self.client)

    def send(self, line):
        note("<--", line)
        try:
            self.client.sendall(f"{line}\r\n".encode())
        except OSError:
            # The walk quit and the server is still talking. Logged and dropped:
            # a traceback at the end of every walk reads as a failed run.
            note("~~ ", "the client had gone")

    def rewrite(self, line):
        """The lines to pass on in place of this one.

        The batch's opening and closing lines both go through untouched — the
        opening carries the label the client correlates its ask by, and an
        answer that never opens is a different experiment. What is between them
        does not.
        """
        words = command_of(line)
        batch = words[0].upper() == "BATCH"

        if self.emptying is not None:
            if batch and words[1:2] == [f"-{self.emptying}"]:
                note("~~ ", f"dropped {self.dropped} out of +{self.emptying}")
                self.emptying = None
                return [line]
            if tags_of(line).get("batch") == self.emptying:
                self.dropped += 1
                return []
            return [line]

        if batch and words[1:2] and words[1].startswith("+") and words[2:3] == ["chathistory"]:
            if self.armed:
                self.armed = False
                self.emptying = words[1][1:]
                self.dropped = 0
            return [line]

        # A refusal is an answer, and leaves nothing to empty.
        if words[0].upper() == "FAIL" and words[1:2] == ["CHATHISTORY"]:
            self.armed = False
        return [line]


def lines(sock):
    buffer = b""
    while True:
        try:
            chunk = sock.recv(65536)
        except OSError:
            return
        if not chunk:
            return
        buffer += chunk
        while b"\r\n" in buffer:
            raw, buffer = buffer.split(b"\r\n", 1)
            yield raw.decode("utf-8", "replace")


def shutdown(sock):
    try:
        sock.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def serve():
    global started
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", LISTEN))
    listener.listen(4)
    print(
        f"emptypage on {LISTEN} -> {HOST}:{PORT}"
        f" ({'passing' if PASS_THROUGH else 'emptying'})",
        flush=True,
    )
    while True:
        client, _ = listener.accept()
        if started is None:
            started = time.monotonic()
        note("~~ ", "session opened")
        upstream = socket.create_connection((HOST, int(PORT)))
        pump = Pump(client, upstream)
        threading.Thread(target=pump.up, daemon=True).start()
        threading.Thread(target=pump.down, daemon=True).start()


serve()
