"""Answers a page-back with messages the client already holds.

    replaypage.py <listen port> <upstream host:port> <log path> [--pass]

Run 18 walked one of the three ways a page-back can fail to disarm the `#487`
guard — the batch that never arrives — and left the other two argued from the
code, on the reasoning that all three end in the same place and the `waiting`
fix covers them. For this one it does not, and that is #522.

The route this reproduces needs nothing to go missing. The batch arrives, on
time, and carries only rows the pane already holds; `holdMessages` files none of
them, so the window's oldest message does not move, so the guard that was
watching it stays armed. `page_back` answers `more` rather than `waiting`,
because the round trip completed — it is the disarm that does not happen, not
the answer.

That is `CHATHISTORY LATEST`'s own shape, which is why `PageBack::Deferred`
answers `true` for it, and why this is not an exotic condition to manufacture:
the proxy replays the batch the client was sent when it joined.

So the client's own asks pass untouched, the session stays up, every ask is
answered inside its deadline, and the only thing wrong is that the answer says
nothing new. `holdpage.py` is the run 18 instrument this is built from; the
difference is that this one replaces the batch's contents rather than dropping
them, and therefore tests a guard that was told its page arrived.

`--pass` replaces nothing and is the same proxy otherwise. It is how the log is
read against a walk where the page carries history, because an instrument that
cannot show the working case is not evidence about the broken one.

The log is `holdpage.py`'s format: monotonic seconds since the first connection,
a direction, and the line.
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


def retagged(line, reference):
    """The same message under another batch reference.

    Everything else is left exactly as it was — `msgid` above all, which is what
    the client dedupes on and therefore the whole of why this batch lands as
    nothing.
    """
    if not line.startswith("@"):
        return f"@batch={reference} {line}"
    raw, rest = line[1:].split(" ", 1)
    items = [item for item in raw.split(";") if not item.startswith("batch=")]
    items.append(f"batch={reference}")
    return "@" + ";".join(items) + " " + rest


class Pump:
    """One client, both directions. The state that matters is shared between
    them: the batch the client was sent on joining is what every later page-back
    is answered with."""

    def __init__(self, client, upstream):
        self.client = client
        self.upstream = upstream
        # A `CHATHISTORY BEFORE` has gone up and its batch has not come back.
        self.armed = False
        # The reference of the batch being replaced, while one is.
        self.replacing = None
        # The message lines of the first `chathistory` batch the client was
        # sent, which is the join's `LATEST`. What it holds, in other words.
        self.held = []
        # The batch currently being collected into `held`, while one is.
        self.collecting = None
        self.asks = 0
        self.replaced = 0

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
        """Server to client, with the answer to an ask swapped for what the
        client already has."""
        for line in lines(self.upstream):
            if PASS_THROUGH:
                self.send(line)
                continue
            for out in self.rewrite(line):
                self.send(out)
        shutdown(self.client)

    def send(self, line):
        note("<--", line)
        self.client.sendall(f"{line}\r\n".encode())

    def rewrite(self, line):
        """The lines to pass on in place of this one.

        Ergo answers `CHATHISTORY` inside a batch: an opening `BATCH +ref
        chathistory <target>`, the messages tagged with that reference, and a
        closing `BATCH -ref`. The opening line is passed through untouched —
        its label is what the client correlates the answer by, and the answer
        is not what is being interfered with. Only what is between the two
        changes.
        """
        words = command_of(line)
        batch = words[0].upper() == "BATCH"

        if self.replacing is not None:
            if batch and words[1:2] == [f"-{self.replacing}"]:
                out = [retagged(held, self.replacing) for held in self.held]
                self.replaced += len(out)
                note("~~ ", f"replayed {len(out)} into +{self.replacing}")
                self.replacing = None
                return out + [line]
            # The server's real answer, which the reader never sees.
            if tags_of(line).get("batch") == self.replacing:
                note("XX ", line)
                return []
            return [line]

        if self.collecting is not None:
            if batch and words[1:2] == [f"-{self.collecting}"]:
                self.collecting = None
                note("~~ ", f"holding {len(self.held)} the client now has")
            elif tags_of(line).get("batch") == self.collecting:
                self.held.append(line)
            return [line]

        if batch and words[1:2] and words[1].startswith("+") and words[2:3] == ["chathistory"]:
            reference = words[1][1:]
            if self.armed and self.held:
                self.armed = False
                self.replacing = reference
            elif not self.held:
                # The join's own page, which is what the client will hold and
                # therefore what every later ask is answered with.
                self.collecting = reference
            return [line]

        # A refusal is an answer, and leaves nothing to replace.
        if words[0].upper() == "FAIL" and words[1:2] == ["CHATHISTORY"]:
            self.armed = False
        return [line]


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
    note("end", f"asks={pump.asks} replayed={pump.replaced}")


listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", LISTEN))
listener.listen(8)
print(f"replaypage on {LISTEN} -> {HOST}:{PORT}{' (passing)' if PASS_THROUGH else ''}", flush=True)
while True:
    conn, _ = listener.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
