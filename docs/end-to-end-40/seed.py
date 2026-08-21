"""Fills a channel whose rows can change height after they are drawn, and whose
blocks are long enough to be parked inside.

    seed.py <host:port> <#channel> <how many>

Run 23's seeder with its speaker function changed, and the change is the whole
of what run 40 needed a seed of its own for: sixty lines to a run rather than
four. `docs/manual-verification.md` names a seed of twenty or more as what a
walk of #538 wants — a tall block is the only place a reader can sit past
`LOAD_OLDER_PX` and inside the row a page merges into at the same time, and run
31's four-line runs put every parked pane either at the top of its content,
where it asks for the page itself, or below anything the page could redraw.

What follows is run 23's own account of the rest of it, which is unchanged.

Run 22's `seed.py` with one property added, and it is the property #511 and
#512 spent themselves establishing the need for.

That seed chose a shape which keeps `groups.ts` out of a paging measurement:
nothing opening with `[` or with `nick:`, and the two speakers alternating every
line so no run is ever longer than a message. It works — no group is ever
assigned, and no page landing can alter a row that is already on the screen.
Which also means the channel cannot express the class of defect a landing page
is most likely to cause, and #511 measured 0px on it under every arm it had.

So this channel groups. Three people rather than two, speaking in runs (of
twenty here, of up to four in run 23's), and two things that open a group:

  - A declared topic every 100th line (run 23's was every 40th), its name drawn
    from three that recur.
    A declared group runs forward until the conversation stops for five minutes
    and this seeder never stops, so each declaration groups everything after it
    until the next one — and the same name said again rejoins the group it
    opened rather than opening a second. Where a page boundary falls therefore
    decides which block *opens* each group and draws its name, which is a line
    a row gains or loses without any message moving.
  - An address every 13th line, naming somebody who has just spoken, which is
    the other grade `groups.ts` assigns.

Every line still carries `line NNNN`, so a screenshot names the message at the
top of the viewport. A declared line reads `[heap] line 0040 ...` on the wire
and draws as `line 0040 ...` under the topic's name, because `bodyText` takes
the bracket off what it prints. An addressed line reads `curator: line 0013 ...`
and draws whole.

The bodies are run 22's three lengths, and the reason is run 22's: a page of
rows the virtualiser can size from its estimate alone gives the arithmetic
nothing to be wrong about.

**The property is measured rather than intended.** Take 800 of these lines, hold
the last 200 as a window and land the 200 behind them as a page: of the window's
86 rows, **12 draw something different afterwards** — a different number of
messages in the block, or the topic's name gone from over it. Run 22's channel
changes none of its own. That difference is the whole reason for this seed, and
a change to it that loses the property loses the run.

The seeders stay resident. Ergo destroys an unregistered channel the moment it
empties and the history goes with it, so a seeder that quits leaves a server
with nothing to page back.
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

NICKS = ["historian", "archivist", "curator"]
# Three names that recur, so a later declaration rejoins the group an earlier
# one opened and the group's opener is decided by where the window starts.
TOPICS = ["heap", "lfi", "tcache"]


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
    """Runs of sixty lines, and the length is arithmetic rather than taste.

    The band a reader can be parked in and still be a neighbour — past
    `LOAD_OLDER_PX` and inside the row an arriving page merges into — exists
    only where the window's *first* row is taller than 400px, because that row
    is the one the page merges into and it starts at the top of the content.
    `docs/manual-verification.md` says twenty lines, which is 480px and leaves a
    band 80px wide; a wheel notch was 69px in one pane of run 31 and 14px in
    another, so a band that narrow is one a burst can step over.

    Sixty leaves the window opening fifty lines into a run and ten behind it,
    which is a first row about 1250px tall and a band of 850px to park in.
    Where in the run the window opens is `run.sh`'s to arrange, in how many
    lines it seeds.

    Deterministic: the walk has to be reproducible from the seed alone."""
    return NICKS[(n // 60) % len(NICKS)]


people = {nick: Client(nick) for nick in NICKS}
said_by = None
for n in range(1, TOTAL + 1):
    nick = speaker(n)
    text = f"line {n:04d} {body(n)}"
    # Every hundredth rather than run 23's every fortieth, because a declaration
    # ends the run open above it — `rows.ts` splits a block whose group changes —
    # and a run cut every forty lines is a first row 950px tall at most. The band
    # a reader can be parked in is what is left of that row under 400px, so the
    # declarations are moved apart until the speaker change is what bounds the
    # row again.
    if n % 100 == 0:
        text = f"[{TOPICS[(n // 100) % len(TOPICS)]}] {text}"
    elif n % 13 == 0 and said_by is not None and said_by != nick:
        text = f"{said_by}: {text}"
    people[nick].say(text)
    said_by = nick
    # Ergo timestamps at millisecond resolution and CHATHISTORY orders by that
    # timestamp, so messages sharing one come back in an order the seed did not
    # choose. A page boundary landing inside such a pair is the walk failing to
    # be reproducible rather than the client being wrong.
    time.sleep(0.002)

print(f"seeded {TOTAL} messages into {CHANNEL}", flush=True)

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
