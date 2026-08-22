"""Fills a channel with numbered lines, on a mark the walk leaves for it.

    talker.py <host:port> <#channel> <first> <count> [--after FILE] [--nicks a,b,c]

Run 40's seeder sends its lines and then holds, which is what a walk that pages
back through history needs: the channel is filled before ircx ever joins, and
the client reads it off the server. **This walk needs the opposite.** Search
reads ircx's own SQLite archive, and the archive holds what the client
*received* — so every line this run searches for has to be said while ircx is in
the channel, after it has joined and settled.

So the lines wait for a mark. `--after` is run 45's trick: `ss` is the only
command `window.mjs` has that leaves a file another process can see, so the walk
photographs something it does not need and this speaks when the file appears.

Two of these run per walk. The first fills the channel under a client that is
watching, which is what the archive is made of. The second says a handful more
after the reader has jumped into the middle of it, which is what asks whether a
conversation that has moved on can still reach them.

`line NNNN` at the head of every line, four digits, because `src/lib/swatch.ts`
paints a stripe from exactly that and `docs/end-to-end-42/sequence.py` reads the
stripes back off a screenshot. A line numbered otherwise is a line no frame can
name.

**One nick means one socket, and that is what makes the numbers an order.** The
first walk of this run seeded from three, run 40's way, and the archive came
back with `line 0120` filed between `0101` and `0102` — every one of them
stamped the same millisecond by ergo, which had read one connection's queue
forty milliseconds late. Run 40 says as much about its own seed and does not
mind, because a page boundary is all it reads. This run reads a step in the
numbers as a hole in the conversation, so a seed that can invent one is a seed
that can invent the finding. Passing `--nicks` a single name serialises the
whole channel down one connection, where ergo's order is the order it was
given.

Stays resident afterwards: ergo destroys an unregistered channel the moment it
empties, and a walk against a channel nobody is in is a walk against a channel
that cannot talk.
"""

import os
import select
import socket
import sys
import time

HOST, PORT = sys.argv[1].split(":")
CHANNEL = sys.argv[2]
FIRST = int(sys.argv[3])
COUNT = int(sys.argv[4])
args = sys.argv[5:]
AFTER = args[args.index("--after") + 1] if "--after" in args else None
NICKS = (
    args[args.index("--nicks") + 1] if "--nicks" in args else "historian,archivist,curator"
).split(",")

SHORT = "ack"
MEDIUM = "the reader is somewhere above this line and should stay there"
LONG = (
    "a longer line, wrapping over more than one row, so the window a jump opens "
    "is not a stack of rows the virtualiser can size from its estimate alone and "
    "the arithmetic has something to be wrong about"
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


def speaker(n):
    """Runs of twenty, rather than run 40's sixty.

    Nothing here is parked inside a single row, so the tall first row that seed
    needed is not wanted; twenty keeps three people in the window a jump opens
    instead of putting three hundred lines under one name."""
    return NICKS[(n // 20) % len(NICKS)]


people = {nick: Client(nick) for nick in NICKS}
print("joined", flush=True)

if AFTER:
    while not os.path.exists(AFTER):
        time.sleep(0.05)
    print(f"marked by {AFTER}", flush=True)

for n in range(FIRST, FIRST + COUNT):
    people[speaker(n)].say(f"line {n:04d} {body(n)}")
    # Ergo timestamps at millisecond resolution and orders history by it, so two
    # lines sharing one come back in an order this seed did not choose.
    time.sleep(0.002)

print(f"said {COUNT} lines from {FIRST:04d} into {CHANNEL}", flush=True)

while True:
    ready, _, _ = select.select([p.sock for p in people.values()], [], [], 30)
    for sock in ready:
        person = next(p for p in people.values() if p.sock is sock)
        chunk = sock.recv(65536)
        if not chunk:
            sys.exit(f"{person.nick} was disconnected")
        person.buffer += chunk
        while b"\r\n" in person.buffer:
            raw, person.buffer = person.buffer.split(b"\r\n", 1)
            line = raw.decode("utf-8", "replace")
            if line.startswith("PING"):
                person.send("PONG" + line[4:])
