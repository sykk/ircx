"""Holds the page a join asks for, so it lands while the archive is being read.

    holdlatest.py <listen port> <upstream host:port> <log path> <delay ms>

The condition under test is a race a fresh profile runs on every channel it
opens, and the two builds disagree about who wins it.

A pane opening on a first launch has an empty timeline and an empty archive.
The priming read asks `load_history` with `before` null and awaits it, and the
server's own `CHATHISTORY LATEST` — the page the join asked for — is in flight
at the same time. If it lands *during* that await, the conversation's only
message when the read returns is one that arrived after the snapshot was taken:

    const oldest = older[0] ?? current.messages[0];   // before #497
    const oldest = olderOf(older[0], live[0]);        // after

`older` is empty, because the archive is. `current` is the snapshot from before
the await, which held nothing. So the old build computes `undefined`, and
`pageBack` reads that as a conversation with nothing behind it: `"end"`,
`hasMore` false, "Beginning of history" drawn over a server holding thousands.
**No `CHATHISTORY BEFORE` is ever sent, for the rest of the run.**

The window is the archive read, which on an empty table over a tmpfs is a
fraction of a millisecond — which is why eighty walks a run in 16 and 17 never
landed in it. This holds the batch back by a stated number of milliseconds so
that it does, and the delay is swept rather than guessed.

Only the `chathistory` batch is held, and only the first one, which is the join's
own page. `PING` and everything else crosses untouched, so nothing here can be
mistaken for a server that stopped answering — the mistake `stepdelay.py` would
have made and the reason run 18 stopped using it.
"""

import socket
import sys
import threading
import time

LISTEN = int(sys.argv[1])
HOST, PORT = sys.argv[2].split(":")
LOG = sys.argv[3]
DELAY = int(sys.argv[4]) / 1000

started = None
lock = threading.Lock()
log = open(LOG, "w", buffering=1)


def note(direction, line):
    with lock:
        log.write(f"{time.monotonic() - started:9.3f} {direction} {line}\n")


def command_of(line):
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
    def __init__(self, client, upstream):
        self.client = client
        self.upstream = upstream
        # The join's page has not been asked for yet.
        self.armed = False
        self.held = None
        self.done = False
        self.batch = []

    def up(self):
        for line in lines(self.client):
            words = command_of(line)
            if len(words) > 1 and words[0].upper() == "CHATHISTORY":
                if words[1].upper() == "LATEST" and not self.done:
                    self.armed = True
                note("ask", line)
            else:
                note("-->", line)
            self.upstream.sendall(f"{line}\r\n".encode())
        shutdown(self.upstream)

    def down(self):
        for line in lines(self.upstream):
            if self.collect(line):
                continue
            note("<--", line)
            self.client.sendall(f"{line}\r\n".encode())
        shutdown(self.client)

    def collect(self, line):
        """Whether this line belongs to the held batch. The whole batch is
        gathered and released together: releasing it line by line would let the
        client file the first row while the rest was still coming, which is a
        different arrival from the one the app sees without a proxy."""
        words = command_of(line)
        batch = words[0].upper() == "BATCH"
        if self.held is not None:
            self.batch.append(line)
            if batch and words[1:2] == [f"-{self.held}"]:
                self.release()
            return True
        if not self.armed:
            return False
        if batch and words[1:2] and words[1].startswith("+") and words[2:3] == ["chathistory"]:
            self.held = words[1][1:]
            self.armed = False
            self.done = True
            self.batch = [line]
            note("hold", f"batch {self.held} held for {DELAY * 1000:.0f}ms")
            return True
        return False

    def release(self):
        held, batch, self.held, self.batch = self.held, self.batch, None, []

        def later():
            time.sleep(DELAY)
            for line in batch:
                note("<--", line)
                try:
                    self.client.sendall(f"{line}\r\n".encode())
                except OSError:
                    return
            note("free", f"batch {held} released, {len(batch)} lines")

        threading.Thread(target=later, daemon=True).start()


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


listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", LISTEN))
listener.listen(8)
print(f"holdlatest on {LISTEN} -> {HOST}:{PORT}, join page held {DELAY * 1000:.0f}ms", flush=True)
while True:
    conn, _ = listener.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
