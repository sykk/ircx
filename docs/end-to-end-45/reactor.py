"""Reacts to a line the reader has scrolled past, while they are scrolling.

    reactor.py <host:port> <#channel> <probe.log> <how many> [--behind N]
               [--every MS] [--after FILE]

#611 needs three things at once: a row above the fold, already measured, whose
height changes while the virtualiser calls the scroll a backward one. The first
two a seeded channel gives for nothing. The third is 150ms wide — the whole of
an upward gesture and `isScrollingResetDelay` past its last notch — and no
schedule computed from the outside lands inside it reliably.

So it is not computed. This joins the channel, learns which `msgid` carries
which `line NNNN`, and then **tails the probe log the pane itself writes**: a
`commit` record carries `top`, and two of them with `top` falling is the reader
scrolling back, in the app's own words. A reaction goes out on seeing it, and
the round trip to a loopback `ergo` is milliseconds against the 100ms the probe
buffers for.

The target is the fold's own message less `--behind` lines, which is what makes
this self-locating: the record names the message at the top of the pane, the map
turns it into a line number, and the line that far above it is in a row the
reader has read past and the virtualiser still has mounted. Each reaction goes
to a message that has had none, because the first one on a message is what adds
a row of chips under it — a second only lengthens one.

`--after` is how the burst is kept out of the parking. Parking a pane is itself
a backward gesture and the first thing this would fire at, which leaves the
gesture being measured with nothing arriving in it. The walk takes a screenshot
it does not need on the line before the gesture starts, and this waits for that
file: `ss` is the only command `window.mjs` has that leaves a mark another
process can see.

Prints a line per reaction, and `docs/end-to-end-45/moved.py` reads them back
against the records.
"""

import json
import os
import socket
import sys
import time

HOST, PORT = sys.argv[1].split(":")
CHANNEL = sys.argv[2]
PROBE = sys.argv[3]
HOW_MANY = int(sys.argv[4])
args = sys.argv[5:]
BEHIND = int(args[args.index("--behind") + 1]) if "--behind" in args else 100
EVERY_MS = int(args[args.index("--every") + 1]) if "--every" in args else 250
AFTER = args[args.index("--after") + 1] if "--after" in args else None


def say(text):
    print(text, flush=True)


sock = socket.create_connection((HOST, int(PORT)))
sock.settimeout(0.05)
wire = sock.makefile("rwb", buffering=0)


def send(line):
    wire.write((line + "\r\n").encode())


send("CAP REQ :message-tags server-time")
send("NICK reactor")
send("USER reactor 0 * :reactor")
send("CAP END")
send(f"JOIN {CHANNEL}")

# `line NNNN` to the msgid that carried it, and the set of messages already
# reacted to.
line_of = {}
msgid_of = {}
reacted = set()
buffer = b""
# A list so `handle` can set it without a global.
joined = [False]


def pump():
    """Everything the server has said since last time, without blocking."""
    global buffer
    try:
        chunk = sock.recv(65536)
    except (TimeoutError, socket.timeout):
        return
    if not chunk:
        raise SystemExit("the server closed the connection")
    buffer += chunk
    while b"\r\n" in buffer:
        raw, buffer = buffer.split(b"\r\n", 1)
        handle(raw.decode("utf-8", "replace"))


def handle(raw):
    tags = {}
    rest = raw
    if rest.startswith("@"):
        head, rest = rest[1:].split(" ", 1)
        for pair in head.split(";"):
            key, _, value = pair.partition("=")
            tags[key] = value
    if rest.startswith("PING"):
        send("PONG" + rest[4:])
        return
    parts = rest.split(" ")
    # 366 is the end of the names list, which is this client being in the
    # channel rather than having asked to be.
    if len(parts) > 1 and parts[1] == "366":
        joined[0] = True
        return
    if len(parts) < 3 or parts[1] != "PRIVMSG":
        return
    text = rest.split(" :", 1)[1] if " :" in rest else ""
    at = text.find("line ")
    if at == -1 or "msgid" not in tags:
        return
    number = text[at + 5 : at + 9]
    if not number.isdigit():
        return
    line_of[tags["msgid"]] = int(number)
    msgid_of[int(number)] = tags["msgid"]


def react(msgid):
    send(f"@+draft/react=\N{THUMBS UP SIGN};+draft/reply={msgid} TAGMSG {CHANNEL}")


# In the channel before the seeder starts, because a message this did not see
# is a message whose id it cannot name. The walk waits for both of these.
while not joined[0]:
    pump()
    time.sleep(0.05)
say("joined")

# Everything the seeder says, until it has been quiet long enough to be done.
quiet = time.time()
while time.time() - quiet < 4 or len(line_of) == 0:
    known = len(line_of)
    pump()
    if len(line_of) != known:
        quiet = time.time()
    time.sleep(0.02)
say(f"holding {len(line_of)} messages by line")

while AFTER is not None and not os.path.exists(AFTER):
    pump()
    time.sleep(0.05)

# From the end, so what is read is what the pane does from here rather than what
# it did while the channel was filling.
while not os.path.exists(PROBE):
    pump()
    time.sleep(0.1)
log = open(PROBE, "r")
log.seek(0, os.SEEK_END)

was = None
sent = 0
last = 0.0
while sent < HOW_MANY:
    pump()
    where = log.tell()
    line = log.readline()
    if not line.endswith("\n"):
        log.seek(where)
        time.sleep(0.02)
        continue
    try:
        record = json.loads(line)
    except ValueError:
        continue
    if record.get("kind") != "commit":
        continue
    top = record.get("top")
    fold = record.get("fold")
    if top is None:
        continue
    falling = was is not None and top < was - 1
    was = top
    if not falling or fold is None:
        continue
    if (time.time() - last) * 1000 < EVERY_MS:
        continue
    at = line_of.get(fold["id"])
    if at is None:
        continue
    # The first line that far above the reader nobody has reacted to yet, and
    # older still until one is free.
    target = next((n for n in range(at - BEHIND, 0, -1) if n in msgid_of and n not in reacted), None)
    if target is None:
        continue
    reacted.add(target)
    react(msgid_of[target])
    sent += 1
    last = time.time()
    say(
        f"reacted line {target:04d} while the fold was line {at:04d} "
        f"at y {fold['y']} and top {top}"
    )

say(f"sent {sent}")
# The reader has to still be here for the reaction to be relayed to them, and a
# client that leaves takes its own line off the wire with it.
while True:
    pump()
    time.sleep(0.1)
