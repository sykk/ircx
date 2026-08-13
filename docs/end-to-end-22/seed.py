"""Fills a channel with numbered messages before ircx exists.

    seed.py <host:port> <#channel> <how many>

Run 12's `seed_history.py` with its three constants moved onto the command line,
because this run brings its own server on a port it picked rather than the
operator's on 6677. Everything else is that script's, including the reason the
seeders stay resident: ergo destroys an unregistered channel the moment it
empties and the history goes with it, so a seeder that quits leaves a server
with nothing to page back.

Every line starts `line NNNN`, so a screenshot names which message is at the top
of the viewport. Nothing starts with `[` or with `nick:`, which groups.ts would
read as a declared topic or an addressed pair. Heights vary because the anchor
adds back the scroller's growth and the virtualiser estimates any row it has not
measured.
"""

import select
import socket
import sys
import time

HOST, PORT = sys.argv[1].split(":")
CHANNEL = sys.argv[2]
TOTAL = int(sys.argv[3])

SHORT = "ack"
MEDIUM = "the reader is somewhere above this line and should stay there"
LONG = (
    "a longer line, wrapping over more than one row, so the page that lands "
    "above the viewport is not a stack of rows the virtualiser can size from "
    "its estimate alone and the arithmetic has something to be wrong about"
)


class Client:
    def __init__(self, nick):
        self.nick = nick
        self.sock = socket.create_connection((HOST, int(PORT)))
        self.buffer = b""
        self.send(f"NICK {nick}")
        self.send(f"USER {nick} 0 * :{nick}")
        self.wait_for(" 001 ")
        self.send(f"JOIN {CHANNEL}")
        self.wait_for("JOIN")

    def send(self, line):
        self.sock.sendall(line.encode() + b"\r\n")

    def wait_for(self, needle, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.buffer += self.sock.recv(8192)
            while b"\r\n" in self.buffer:
                raw, self.buffer = self.buffer.split(b"\r\n", 1)
                line = raw.decode("utf-8", "replace")
                if line.startswith("PING"):
                    self.send("PONG" + line[4:])
                if needle in line:
                    return line
        raise TimeoutError(f"{self.nick}: never saw {needle!r}")

    def say(self, text):
        self.send(f"PRIVMSG {CHANNEL} :{text}")


def body(n):
    if n % 17 == 0:
        return LONG
    if n % 5 == 0:
        return SHORT
    return MEDIUM


people = [Client("historian"), Client("archivist")]
for n in range(1, TOTAL + 1):
    people[n % 2].say(f"line {n:04d} {body(n)}")
    # Ergo timestamps at millisecond resolution and CHATHISTORY orders by that
    # timestamp, so messages sharing one come back in an order the seed did not
    # choose. A page boundary landing inside such a pair is the walk failing to
    # be reproducible rather than the client being wrong.
    time.sleep(0.002)

print(f"seeded {TOTAL} messages into {CHANNEL}", flush=True)

while True:
    ready, _, _ = select.select([p.sock for p in people], [], [], 30)
    for sock in ready:
        person = next(p for p in people if p.sock is sock)
        chunk = sock.recv(65536)
        if not chunk:
            sys.exit(f"{person.nick} was disconnected")
        person.buffer += chunk
        while b"\r\n" in person.buffer:
            raw, person.buffer = person.buffer.split(b"\r\n", 1)
            line = raw.decode("utf-8", "replace")
            if line.startswith("PING"):
                person.send("PONG" + line[4:])
