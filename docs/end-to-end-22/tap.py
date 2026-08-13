"""Forwards a session and writes down both sides of it.

    tap.py <listen port> <upstream host:port> <log file>

Run 15's `stepdelay.py` holds the server's side to bracket a page landing.
This holds nothing: what run 16 needs to see is not *when* a line arrives but
*what the client asked for*, and #496 is a request that costs a round trip and
draws nothing. It has no symptom on screen at all now that #494 has ordered the
list, so a screenshot cannot answer it and the timeline's own raw log records
the queue rather than the socket.

Each line is stamped and prefixed `>` for what the client sent and `<` for what
the server answered, which is the direction that matters: `> CHATHISTORY` is the
whole of the evidence.
"""

import socket
import sys
import threading
import time

LISTEN = int(sys.argv[1])
HOST, PORT = sys.argv[2].split(":")
LOG = open(sys.argv[3], "w", buffering=1)

started = time.monotonic()
lock = threading.Lock()


def note(arrow, line):
    if not line:
        return
    with lock:
        LOG.write(f"{time.monotonic() - started:8.3f} {arrow} {line}\n")


def forward(src, dst, arrow):
    """Straight through, and written down a line at a time."""
    rest = b""
    try:
        while chunk := src.recv(65536):
            dst.sendall(chunk)
            rest += chunk
            while b"\r\n" in rest:
                raw, rest = rest.split(b"\r\n", 1)
                note(arrow, raw.decode("utf-8", "replace"))
    except OSError:
        pass
    finally:
        for sock in (src, dst):
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


def session(client):
    upstream = socket.create_connection((HOST, int(PORT)))
    note("-", f"session opened to {HOST}:{PORT}")
    for src, dst, arrow in ((client, upstream, ">"), (upstream, client, "<")):
        threading.Thread(target=forward, args=(src, dst, arrow), daemon=True).start()


listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", LISTEN))
listener.listen(8)
print(f"tap {LISTEN} -> {HOST}:{PORT}, writing {sys.argv[3]}", flush=True)

while True:
    conn, _ = listener.accept()
    session(conn)
