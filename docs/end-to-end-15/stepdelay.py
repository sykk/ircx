"""Holds what the server says, by a delay that steps up part-way through the walk.

    stepdelay.py <listen port> <upstream host:port> <base ms> <step at s> <stepped ms>

Run 14's `delay.py` holds the server's side by one fixed delay, which is enough
to bracket a page landing in a pane nobody has touched. It is not enough for a
reader who scrolls to the top and comes back: reaching the top is a thousand
wheel notches and so is the way back, which is thirty-odd seconds of walking
against a page that lands eight hundred milliseconds after it is asked for.
Holding the whole session by thirty seconds instead would work, and costs three
round trips of it before registration finishes.

So the delay steps. The walk registers, joins and settles at the base delay;
the delay steps up before the scroll that asks for the page; and the page is
still in the air when the reader is back at the live edge. Only the server's
side is held either way, so nothing about when the client asks, or how it
draws, is being measured through it.

The step is timed from the first connection rather than from this process
starting, because what the walk knows is when it launched the app.

Ordering is what makes this safe to do mid-session: the delay only ever goes
up, and a chunk is due no earlier than the one before it, so the server's lines
reach the client in the order it sent them.
"""

import queue
import socket
import sys
import threading
import time

LISTEN = int(sys.argv[1])
HOST, PORT = sys.argv[2].split(":")
BASE = int(sys.argv[3]) / 1000
STEP_AT = float(sys.argv[4])
STEPPED = int(sys.argv[5]) / 1000

started = None


def delay():
    if started is None or time.monotonic() - started < STEP_AT:
        return BASE
    return STEPPED


def close(*socks):
    for sock in socks:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def forward(src, dst):
    """Straight through, for what the client says."""
    try:
        while chunk := src.recv(65536):
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        close(src, dst)


def hold(src, dst):
    """Each chunk carries the moment it is due, and a second thread sends it
    then. `last` is what keeps the order: a chunk read after the step is due
    later than one read before it, and never earlier."""
    due = queue.Queue()
    last = 0.0

    def send():
        while (item := due.get()) is not None:
            at, chunk = item
            time.sleep(max(0, at - time.monotonic()))
            try:
                dst.sendall(chunk)
            except OSError:
                return

    sender = threading.Thread(target=send, daemon=True)
    sender.start()
    try:
        while chunk := src.recv(65536):
            at = max(time.monotonic() + delay(), last)
            last = at
            due.put((at, chunk))
    except OSError:
        pass
    finally:
        due.put(None)
        sender.join(timeout=STEPPED + 1)
        close(src, dst)


def serve(client):
    global started
    if started is None:
        started = time.monotonic()
        print(f"stepping to {STEPPED * 1000:.0f}ms at +{STEP_AT:.0f}s", flush=True)
    upstream = socket.create_connection((HOST, int(PORT)))
    threading.Thread(target=forward, args=(client, upstream), daemon=True).start()
    threading.Thread(target=hold, args=(upstream, client), daemon=True).start()


listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", LISTEN))
listener.listen(8)
print(f"127.0.0.1:{LISTEN} -> {HOST}:{PORT}, {BASE * 1000:.0f}ms behind", flush=True)
while True:
    conn, _ = listener.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
