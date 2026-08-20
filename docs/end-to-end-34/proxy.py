"""A logging pipe between ircx and ergo.

The app's own raw log records what it queued rather than what it wrote, so the
only honest record of what ircx said is a socket in between.  Every line is
stamped and tagged with its direction: `>>` is ircx to the server.
"""
import socket, threading, sys, time

LISTEN, UPSTREAM = ("127.0.0.1", 6690), ("127.0.0.1", 6677)


def pump(src, dst, tag, log):
    buf = b""
    while True:
        try:
            chunk = src.recv(65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        while b"\r\n" in buf:
            line, buf = buf.split(b"\r\n", 1)
            log.write(f"{time.time():.3f} {tag} {line.decode('utf-8', 'replace')}\n")
            log.flush()
        try:
            dst.sendall(chunk)
        except OSError:
            break
    for s in (src, dst):
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def serve(path):
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(LISTEN)
    listener.listen(4)
    log = open(path, "a", buffering=1)
    while True:
        client, _ = listener.accept()
        try:
            server = socket.create_connection(UPSTREAM)
        except OSError as e:
            # The client reconnects while the server is down, and a proxy that
            # dies there takes the record of the reconnection with it.
            log.write(f"{time.time():.3f} ** upstream refused: {e}\n")
            client.close()
            continue
        log.write(f"{time.time():.3f} ** connection opened\n")
        threading.Thread(target=pump, args=(client, server, ">>", log), daemon=True).start()
        threading.Thread(target=pump, args=(server, client, "<<", log), daemon=True).start()


if __name__ == "__main__":
    serve(sys.argv[1] if len(sys.argv) > 1 else "proxy.log")
