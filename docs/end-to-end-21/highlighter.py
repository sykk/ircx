#!/usr/bin/env python3
"""A second client that stays, and says what it is told to say.

    highlighter.py <host:port> <nick> <channel> <control file> <log>

The walk cannot send its own highlights: a line ircx types is `isSelf` and
`worthNotifying` drops it first of all. So somebody else has to be in the
channel, and they have to still be there when the walk gets to the interesting
part — a client that connects, speaks and quits leaves a channel with nobody in
it, and a highlight nobody sent is indistinguishable from a notification that
was not raised.

It takes its orders from a file rather than a clock. The walk appends a line and
this sends it; aligning a second client's sleeps against `window.mjs`'s waits
was tried in run 4's idiom and drifts as soon as a build takes a moment longer.

Each line of the control file is one PRIVMSG to <channel>, except:

    /quit               leave, which is how the walk ends this
    /raw <line>         send it verbatim, for anything that is not a message

`<log>` records what went out and what came back, with seconds since start, so
a notification can be put beside the line that provoked it.
"""

import os
import socket
import sys
import threading
import time

started = time.monotonic()


def main():
    where, nick, channel, control, logpath = sys.argv[1:6]
    host, port = where.split(":")
    log = open(logpath, "a", buffering=1)

    def note(direction, text):
        log.write(f"{time.monotonic() - started:8.3f} {direction} {text}\n")

    sock = socket.create_connection((host, int(port)))
    sock.settimeout(0.2)

    def send(line):
        note(">>", line)
        sock.sendall((line + "\r\n").encode())

    send(f"NICK {nick}")
    send(f"USER {nick} 0 * :{nick}")

    joined = False
    buffer = b""
    # Only lines appended after this starts are orders; a control file left over
    # from an earlier walk would otherwise replay it.
    open(control, "a").close()
    seen = os.path.getsize(control)
    running = True

    def orders():
        nonlocal seen, running
        while running:
            time.sleep(0.05)
            size = os.path.getsize(control)
            if size <= seen:
                continue
            with open(control) as fh:
                fh.seek(seen)
                fresh = fh.read()
            seen = size
            for line in fresh.splitlines():
                if not line:
                    continue
                if line == "/quit":
                    send("QUIT :done")
                    running = False
                    return
                if line.startswith("/raw "):
                    send(line[5:])
                else:
                    send(f"PRIVMSG {channel} :{line}")

    reader = None
    while running:
        try:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buffer += chunk
        except socket.timeout:
            continue
        except OSError:
            break
        while b"\r\n" in buffer:
            raw, buffer = buffer.split(b"\r\n", 1)
            line = raw.decode("utf-8", "replace")
            note("<<", line)
            parts = line.split()
            if parts and parts[0] == "PING":
                send("PONG :" + line.split(":", 1)[1] if ":" in line else "PONG")
            elif len(parts) > 1 and parts[1] == "001":
                send(f"JOIN {channel}")
            elif len(parts) > 1 and parts[1] == "366" and not joined:
                # The names list is the end of the join, and the first moment
                # this client is really in the channel.
                joined = True
                note("--", "joined, taking orders")
                reader = threading.Thread(target=orders, daemon=True)
                reader.start()

    sock.close()
    if reader:
        reader.join(timeout=1)


if __name__ == "__main__":
    main()
