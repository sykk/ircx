"""Holds what the server says for a fixed delay, and passes on what the client says at once.

    delay.py <listen port> <upstream host:port> <delay ms>

The two-frame instrument only catches the app moving on its own if the page
lands between the two frames, and against a loopback ergo it does not: a
`CHATHISTORY` answer comes back inside the 250ms `import` takes to photograph
the window, so the landing falls in the same gap as the wheel that asked for
it and nothing about it is attributable.

Delaying only the server's side puts the landing where the walk can see it. The
request goes out on the wheel, the frame is taken, and the page arrives most of
a second later with nothing else happening — so any difference between that
frame and the next is the page landing and nothing else.
"""

import queue
import socket
import sys
import threading
import time

LISTEN = int(sys.argv[1])
HOST, PORT = sys.argv[2].split(":")
DELAY = int(sys.argv[3]) / 1000


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
    then. Sleeping in the reader instead would charge the delay again for every
    chunk, so a page arriving in five of them would take five delays to come
    back — stretching the batch rather than shifting it."""
    due = queue.Queue()

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
            due.put((time.monotonic() + DELAY, chunk))
    except OSError:
        pass
    finally:
        due.put(None)
        sender.join(timeout=DELAY + 1)
        close(src, dst)


def serve(client):
    upstream = socket.create_connection((HOST, int(PORT)))
    threading.Thread(target=forward, args=(client, upstream), daemon=True).start()
    threading.Thread(target=hold, args=(upstream, client), daemon=True).start()


listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", LISTEN))
listener.listen(8)
print(f"127.0.0.1:{LISTEN} -> {HOST}:{PORT}, {DELAY * 1000:.0f}ms behind", flush=True)
while True:
    conn, _ = listener.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
