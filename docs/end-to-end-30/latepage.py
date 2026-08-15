"""Keeps the server's answer to a page-back until after the client has given up,
then sends it anyway.

    latepage.py <listen port> <upstream host:port> <log file> <hold seconds>

`holdpage.py` (run 26) drops that batch and never sends it, which is what makes
the waiting state stable enough to photograph: nothing lands, so nothing moves.
Its own report closes on what that costs — every answer in run 26 is held, so
what the head does *as the page it named arrives* has never been walked.

This is the same proxy with the drop made a delay. Held past `ROUND_TRIP_TIMEOUT`
— sixty seconds, `src-tauri/src/state.rs` — the client stops waiting, sets
`waitingBehind` and draws "The server has not sent this page yet". The batch is
then released into a pane that has already given up on it: `loadingOlder` back
to false, `askedBehind` never armed (a `waiting` outcome does not arm it), and
the oneshot the outcome would have travelled on dropped at the timeout, so the
page arrives as history that answers no question anybody is still asking.

That is a real link rather than an invented one. The timeout's own comment names
45 seconds a page as the slow link that found #491, and this holds for longer
than that on purpose: what is wanted is the state *after* the client concludes
the server is not going to answer.

Held in order and sent in order. The batch's opening `BATCH +ref`, the rows
inside it and the closing `BATCH -ref` go out as one write in the sequence the
server produced them, because a client that gets the rows before the batch they
belong to is a different experiment.

What is not held is what run 26 does not hold either, and for the same reasons:

  * `CHATHISTORY LATEST`, the page a join asks for. A pane that opens on an
    empty timeline and is refused it says "Beginning of history" for the rest of
    the session with nothing left to ask for (#496), and the conversation this
    walk needs would never exist.
  * everything else on the wire — registration, the join, the roster, the
    seeders' lines — so nothing about when the client asks or how it draws is
    measured through the instrument.

`labeled-response` tells the two requests apart, the same capability the client
itself needs to tell a page-back from a gap fill (`session.rs`).
"""

import socket
import sys
import threading
import time

LISTEN = int(sys.argv[1])
HOST, PORT = sys.argv[2].split(":")
LOG = open(sys.argv[3], "w", buffering=1)
HOLD_FOR = float(sys.argv[4])
WRITING = threading.Lock()
STARTED = time.time()


def note(direction, line):
    """Stamped by this process rather than read off the `time` tag: what the
    walk needs is when the client asked and when the answer was let go, and a
    client's own line carries no tag at all. Seconds since the proxy started,
    because every interval in this walk is a duration rather than a clock time."""
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


def answers_a_page_back(line, labels, refs):
    """Whether this server line belongs to a batch answering one. Batches are
    not nested here — one request, one batch — so a reference is enough to
    recognise the lines inside it."""
    tag = tags(line)
    if tag.get("batch") in refs:
        return True
    label = tag.get("label")
    parts = words(line)
    if parts and parts[0].upper() == "BATCH" and len(parts) >= 2:
        ref = parts[1][1:]
        if parts[1].startswith("+") and label is not None and label in labels:
            refs.add(ref)
            return True
        if parts[1].startswith("-") and ref in refs:
            refs.discard(ref)
            return True
    # A server that answers a page-back with something other than a batch — a
    # `FAIL`, or an `ACK` for a request it found nothing for — is answering it
    # all the same, and is owed the same delay.
    return label is not None and label in labels


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


def release(client, batch, at):
    """Sends what was held, once, after the wait. A separate thread per batch so
    the rest of the wire keeps moving through the hold — the channel goes on
    talking, which is what says the connection was alive the whole time and the
    page was the only thing missing."""
    time.sleep(max(0.0, at - time.time()))
    try:
        for line in batch:
            client.sendall(line)
        # The epoch as well as the offset, and it is load-bearing rather than
        # tidy. A walk cannot time a frame from the ask: the wheel burst that
        # reaches the top of the pane takes seconds of its own, so a wait
        # counted from the screenshot before it lands wherever that burst
        # happened to end. The first set of this run was taken that way and
        # photographed the same state twice — both frames after the landing, a
        # comparison of nothing at all. Frames are chosen against this number
        # afterwards instead, which is the moment the page went on the wire.
        note("~~", f"released {len(batch)} lines held for {HOLD_FOR:.0f}s at {time.time():.3f}")
    except OSError:
        pass


def downward(upstream, client, labels):
    refs = set()
    held = []
    due = None
    try:
        for line in lines(upstream):
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            if answers_a_page_back(text, labels, refs):
                if due is None:
                    due = time.time() + HOLD_FOR
                note("hold", text)
                held.append(line)
                # The closing `BATCH -ref` is the last line of the answer, so
                # the whole of it is in hand and the clock can start on the
                # first line rather than on this one — the client has been
                # waiting since the batch opened.
                if not refs:
                    threading.Thread(
                        target=release, args=(client, held, due), daemon=True
                    ).start()
                    held, due = [], None
                continue
            note("<<", text)
            client.sendall(line)
    except OSError:
        pass
    finally:
        close(upstream, client)


def upward(client, upstream, labels):
    try:
        for line in lines(client):
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            label = label_of_page_back(text)
            if label is not None:
                labels.add(label)
            note(">>", text)
            upstream.sendall(line)
    except OSError:
        pass
    finally:
        close(client, upstream)


def serve(client):
    upstream = socket.create_connection((HOST, int(PORT)))
    # One set per connection, shared by the two directions: the labels are
    # minted by the client on this socket and answered on it.
    labels = set()
    threading.Thread(target=upward, args=(client, upstream, labels), daemon=True).start()
    threading.Thread(target=downward, args=(upstream, client, labels), daemon=True).start()


listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", LISTEN))
listener.listen(8)
print(f"127.0.0.1:{LISTEN} -> {HOST}:{PORT}, page-backs {HOLD_FOR:.0f}s late", flush=True)
while True:
    conn, _ = listener.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
