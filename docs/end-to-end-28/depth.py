"""How many pages of history a channel actually has behind its newest.

    depth.py <host:port> <#channel>

Run 17 closed on a channel that had drifted: 900 seeded lines pushed back by a
hundred sessions of join and quit noise, so a walk reached the start of history
after two asks where it used to take five. Every paging measurement since has
been made through that. This is what says so before a walk rather than after —
it asks the way the client asks, `LATEST * 200` and then `BEFORE msgid 200`,
and counts the pages until one comes back short.

It joins, because ergo answers CHATHISTORY only for a channel you are in, and
that join is itself an event in the buffer. Cheap, and not free: run this twice
and the oldest line has moved on by two.

A page is counted in events rather than in messages, which is what ergo's
`channel-length` caps and therefore what a page-back's `limit` is spent on. A
client without the caps to be told about a join is told about it anyway, as a
line from `HistServ` — so the rows here are what a page holds, not what was
said.
"""

import socket
import sys
import time

HOST, PORT = sys.argv[1].split(":")
CHANNEL = sys.argv[2]
LIMIT = 200

sock = socket.create_connection((HOST, int(PORT)))
buffer = b""


def send(line):
    sock.sendall(line.encode() + b"\r\n")


def lines(timeout=20):
    """Every line the server sends, PINGs answered on the way past."""
    global buffer
    deadline = time.time() + timeout
    while time.time() < deadline:
        while b"\r\n" in buffer:
            raw, buffer = buffer.split(b"\r\n", 1)
            line = raw.decode("utf-8", "replace")
            if line.startswith("PING"):
                send("PONG" + line[4:])
            yield line
        sock.settimeout(max(0.1, deadline - time.time()))
        try:
            chunk = sock.recv(65536)
        except TimeoutError:
            return
        if not chunk:
            return
        buffer += chunk
    raise TimeoutError("server went quiet")


def until(needle):
    for line in lines():
        if needle in line:
            return line
    raise TimeoutError(f"never saw {needle!r}")


def page(request):
    """A CHATHISTORY batch, as the messages inside it. The batch's own tag is
    what closes it; a page shorter than the limit is the end of what is there."""
    send(request)
    tag = None
    got = []
    for line in lines():
        if " BATCH " in line and tag is None:
            tag = line.split(" BATCH ", 1)[1].split()[0].lstrip("+")
            continue
        if tag and f"BATCH -{tag}" in line:
            return got
        if tag and " PRIVMSG " in line:
            got.append(line)
    raise TimeoutError("batch never closed")


def msgid(line):
    tags = line[1:].split(" ", 1)[0]
    for tag in tags.split(";"):
        if tag.startswith("msgid="):
            return tag.split("=", 1)[1]
    raise ValueError(f"no msgid on {line!r}")


def body(line):
    """What was said. A tagged line opens with `@tags :prefix`, so the text is
    after the *last* ` :` rather than the first."""
    return line.split(" :")[-1][:52]


send("CAP REQ :batch server-time message-tags draft/chathistory")
send("NICK depthprobe")
send("USER depthprobe 0 * :depthprobe")
until("CAP")
send("CAP END")
until(" 001 ")
send(f"JOIN {CHANNEL}")
until("JOIN")

def report(n, held):
    print(f"page {n:2d}: {len(held):3d}  {body(held[0])!r} … {body(held[-1])!r}")


held = page(f"CHATHISTORY LATEST {CHANNEL} * {LIMIT}")
pages, total = 1, len(held)
oldest = held[0] if held else None
report(pages, held)
while len(held) == LIMIT:
    held = page(f"CHATHISTORY BEFORE {CHANNEL} msgid={msgid(oldest)} {LIMIT}")
    if not held:
        print(f"page {pages + 1:2d}:   0  — the end")
        break
    pages += 1
    total += len(held)
    oldest = held[0]
    report(pages, held)

print(f"\n{CHANNEL}: {total} events behind the live edge, over {pages} pages")
send("QUIT :done")
