"""Answers a reader's first page-back last, into a client that has asked twice since.

    twoasks.py <listen port> <upstream host:port> <log file> <when>

Run 30's `latepage.py` holds every page-back for a fixed time, which is a slow
link. This holds one of them and lets the next through, which is #540: two asks
outstanding, both answered, and the older answer arriving against a guard armed
for a question it knows nothing about.

The policy is by the order the asks go out on this connection, because that is
the only thing that tells them apart from outside the client. Ergo answers all
of them at once and in order; the first one's answer is the only one this keeps:

  1st  held, and let go at `when`.
  2nd  straight through. This is the ask that replaces the first — same msgid,
       a second label — and its answer is the page the reader actually reads.
  3rd  straight through, except in `inflight`. Its answer is what the held one
       is aimed at: every guard either build arms comes off with the batch that
       answers the ask it was armed for, so the state a stale page can be read
       against exists only around a page of the reader's own.
  4th  straight through, and it is the reading. A reader who can still ask is a
       reader whose history did not end; #540 is that this ask never goes out.

`when` is where this run's three timings differ, and none of them is a clock the
walk starts:

  <seconds>  that long after the third ask goes up, which is the reader's own
             shape — a page nobody is waiting for, landing on a conversation
             that has finished paging.
  behind     on the heels of the third ask's answer, written immediately after
             its closing line. This is the tightest aim a proxy has: the guard
             the old build arms goes up when that answer's *outcome* reaches the
             pane and comes off when the answer itself does, eight milliseconds
             later (`WINDOW`, `src-tauri/src/events.rs`), and nothing outside
             this process can be pointed nearer.
  inflight   five seconds after the third ask, with the third answer held five
             seconds longer still — so the stale page lands while that ask is
             out. This is the only arm that puts the question to #541's own
             guard, which is armed before its request goes out and stays up for
             the whole round trip. What refuses the stale page there is
             the name it carries and nothing else.

What is not held is what run 30 does not hold either, for its reasons:
`CHATHISTORY LATEST`, the page a join asks for — a pane refused it says
"Beginning of history" from the start (#496) and the walk would be measuring
that instead — and everything else on the wire, so nothing about when the client
asks or how it draws is measured through the instrument.

`labeled-response` is what tells the asks apart, the same capability the client
needs to tell a page-back from a gap fill (`session.rs`).
"""

import socket
import sys
import threading
import time

LISTEN = int(sys.argv[1])
HOST, PORT = sys.argv[2].split(":")
LOG = open(sys.argv[3], "w", buffering=1)
BEHIND = sys.argv[4] == "behind"
INFLIGHT = sys.argv[4] == "inflight"
# Five seconds is slack rather than a threshold in both arms that use it: what
# has to have happened inside it is a page landing on a local socket.
SETTLE = 0.0 if BEHIND else 5.0 if INFLIGHT else float(sys.argv[4])
# A walk where the third ask never goes out is a walk that measured something
# else, and `read.py` says so from the wire. This is only here so that a held
# batch is not still held when the app is killed, which loses the log line that
# says whether it ever went.
PATIENCE = 300.0
WRITING = threading.Lock()
# Two threads write to the client — the one forwarding the wire and the one
# letting the held answer go — and in `behind` they write in the same
# millisecond. Without this a released line lands inside a forwarded one.
SENDING = threading.Lock()
STARTED = time.time()


def to_client(client, lines):
    with SENDING:
        for line in lines:
            client.sendall(line)


def note(direction, line):
    """Stamped by this process rather than read off the `time` tag: what the
    walk needs is when the client asked and when each answer was let go, and a
    client's own line carries no tag at all."""
    with WRITING:
        LOG.write(f"{time.time() - STARTED:9.3f} {direction} {line}\n")


def tags(line):
    if not line.startswith("@"):
        return {}
    out = {}
    for item in line.split(" ", 1)[0][1:].split(";"):
        key, _, value = item.partition("=")
        out[key] = value
    return out


def words(line):
    """The command and its arguments, with the tags and the source off the
    front. A trailing argument may hold spaces and none of this reads one."""
    rest = line.split(" ", 1)[1] if line.startswith("@") else line
    parts = rest.split()
    return parts[1:] if parts and parts[0].startswith(":") else parts


def label_of_page_back(line):
    parts = words(line)
    if len(parts) >= 2 and parts[0].upper() == "CHATHISTORY" and parts[1].upper() == "BEFORE":
        return tags(line).get("label")
    return None


def lines(sock):
    buffer = b""
    while chunk := sock.recv(65536):
        buffer += chunk
        while (end := buffer.find(b"\r\n")) != -1:
            yield buffer[: end + 2]
            buffer = buffer[end + 2 :]


def close(*socks):
    for sock in socks:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


class Asks:
    """What has been asked on this connection, and when the third of them went.

    One per connection: the labels are minted by the client on this socket and
    answered on it, and so is the counting."""

    def __init__(self):
        self.lock = threading.Lock()
        self.ordinals = {}
        self.third = threading.Event()
        self.answered = threading.Event()

    def asked(self, label):
        with self.lock:
            ordinal = len(self.ordinals) + 1
            self.ordinals[label] = ordinal
        if ordinal == 3:
            self.third.set()
        return ordinal

    def ordinal(self, label):
        with self.lock:
            return self.ordinals.get(label)

    def third_answered(self):
        self.answered.set()

    def wait(self):
        """Whether the thing the release waits on happened. A walk it never
        happened in is unreadable, and this returning False is how the log says
        so rather than hanging."""
        return (self.answered if BEHIND else self.third).wait(PATIENCE)


def release(client, batch, ordinal, asks, after):
    """Sends what was held, once, when the third ask has reached whichever mark
    this arm waits for. A thread per batch so the rest of the wire keeps moving
    through the hold — the channel goes on being there, which is what says the
    connection was alive and the page was the only thing missing."""
    if not asks.wait():
        note("~~", f"ask {ordinal} released unheld: the third ask never got there")
    else:
        time.sleep(after)
    try:
        to_client(client, batch)
        # The epoch as well as the offset, because a frame is chosen against
        # this number afterwards rather than against a wait the walk counted:
        # the wheel burst that reaches the top of a pane takes seconds of its
        # own and not the same seconds twice.
        note("~~", f"released ask {ordinal}, {len(batch)} lines, at {time.time():.3f}")
    except OSError:
        pass


def downward(upstream, client, asks):
    """Server to client, holding the batches this run's policy holds.

    Batches are kept apart by their reference rather than accumulated into one
    list: the first answer is still in hand while the second is streaming
    through, and a client that gets one ask's rows inside another's batch is a
    different experiment."""
    holding = {}
    for_ref = {}
    try:
        for line in lines(upstream):
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            tag = tags(text)
            parts = words(text)
            ordinal = None
            ref = None
            if parts and parts[0].upper() == "BATCH" and len(parts) >= 2:
                ref = parts[1][1:]
                if parts[1].startswith("+"):
                    ordinal = asks.ordinal(tag.get("label"))
                    if ordinal is not None:
                        for_ref[ref] = ordinal
                else:
                    ordinal = for_ref.get(ref)
            elif tag.get("batch") in for_ref:
                ordinal = for_ref[tag.get("batch")]
            else:
                # A server that answers a page-back with something other than a
                # batch — a `FAIL`, or an `ACK` for a request it found nothing
                # for — is answering it all the same, and is owed the same wait.
                ordinal = asks.ordinal(tag.get("label"))

            # The whole of the policy. Everything else on the wire goes
            # straight through.
            if ordinal != 1 and not (INFLIGHT and ordinal == 3):
                note("<<", text)
                to_client(client, [line])
                # The mark the `behind` arm aims at, set after the line is on
                # the socket rather than before: what is wanted is the held
                # answer immediately *after* this one, not racing it.
                if ordinal == 3 and ref is not None and not parts[1].startswith("+"):
                    asks.third_answered()
                continue

            note("hold", text)
            holding.setdefault(ordinal, []).append(line)
            # The closing `BATCH -ref` is the last line of the answer, so the
            # whole of it is in hand before the wait starts.
            if ref is not None and not parts[1].startswith("+"):
                for_ref.pop(ref, None)
                # The third answer, where it is held at all, goes second: the
                # whole point of holding it is that the stale one lands while
                # this ask is still out.
                threading.Thread(
                    target=release,
                    args=(
                        client,
                        holding.pop(ordinal),
                        ordinal,
                        asks,
                        SETTLE * (2 if ordinal == 3 else 1),
                    ),
                    daemon=True,
                ).start()
    except OSError:
        pass
    finally:
        close(upstream, client)


def upward(client, upstream, asks):
    try:
        for line in lines(client):
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            label = label_of_page_back(text)
            if label is not None:
                note("**", f"ask {asks.asked(label)} out under label {label}")
            note(">>", text)
            upstream.sendall(line)
    except OSError:
        pass
    finally:
        close(client, upstream)


def serve(client):
    upstream = socket.create_connection((HOST, int(PORT)))
    asks = Asks()
    threading.Thread(target=upward, args=(client, upstream, asks), daemon=True).start()
    threading.Thread(target=downward, args=(upstream, client, asks), daemon=True).start()


listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", LISTEN))
listener.listen(8)
when = "behind the third answer" if BEHIND else f"{SETTLE:.0f}s after the third ask"
print(f"127.0.0.1:{LISTEN} -> {HOST}:{PORT}, first page-back answered {when}", flush=True)
while True:
    conn, _ = listener.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
