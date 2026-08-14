"""Keeps the server's answer to a page-back to itself, and passes the rest.

    holdpage.py <listen port> <upstream host:port> <log file>

The head of a pane says "Loading older messages" for as long as a page is in
flight, and #516 was that it said so in a pane that had asked for nothing.
Photographing that needs the flight to outlast a screenshot, and against an
ergo on the loopback the answer is back inside a millisecond.

So one kind of line is held and everything else goes through at wire speed: the
batch answering `CHATHISTORY BEFORE`, which is the page-back and nothing else.
`LATEST` — the page a join asks for — is not touched, and must not be. A pane
that opens on an empty timeline asks the server for the page behind no message
at all, is answered `end`, and spends the walk saying "Beginning of history"
with nothing left to ask for (#496). The join's page is what keeps the
conversation out of that state.

`labeled-response` tells the two apart, which is the same capability the client
needs to tell a page-back from a gap fill (`session.rs`). The client labels
every chathistory request it makes; the label comes back on the batch that
answers it, and the batch's reference names the lines inside.

Nothing held is ever sent on. What the walk is after is the five seconds the
client waits before deciding the server has not answered yet, and an answer
landing inside them would prepend a page and move the pane it landed in.
"""

import socket
import sys
import threading
import time

LISTEN = int(sys.argv[1])
HOST, PORT = sys.argv[2].split(":")
LOG = open(sys.argv[3], "w", buffering=1)
WRITING = threading.Lock()


def note(direction, line, held=False):
    """Stamped by this process rather than read off the `time` tag: what the
    walk needs to know is when the client asked, and a client's own line
    carries no tag at all."""
    at = time.strftime("%H:%M:%S")
    with WRITING:
        LOG.write(f"{at} {'held' if held else direction} {line}\n")


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
    # all the same, and the client is owed the same silence.
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


def downward(upstream, client, labels):
    refs = set()
    try:
        for line in lines(upstream):
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            held = answers_a_page_back(text, labels, refs)
            note("<<", text, held)
            if not held:
                client.sendall(line)
    except OSError:
        pass
    finally:
        close(upstream, client)


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
print(f"127.0.0.1:{LISTEN} -> {HOST}:{PORT}, holding page-backs", flush=True)
while True:
    conn, _ = listener.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
