#!/usr/bin/env python3
"""Times a burst of twenty across the server, with no client under test in it.

    burstcheck.py <host:port> <channel>

The walk's burst arrived at the notification daemon as five at once and then one
every 500 ms, which is the shape fakelag makes — five and then two a second —
on a server this run's config turns fakelag off in. Either the config did not
take, or something in ircx spaces them.

This asks the question without ircx: one client blasts twenty PRIVMSGs in a
single write, another sits in the channel and writes down when each arrives. The
answer belongs to the server or it does not.
"""

import socket
import sys
import time


def register(host, port, nick, channel):
    sock = socket.create_connection((host, port))
    sock.sendall(f"NICK {nick}\r\nUSER {nick} 0 * :{nick}\r\nJOIN {channel}\r\n".encode())
    sock.settimeout(10)
    buffer = b""
    while b"366" not in buffer:
        chunk = sock.recv(4096)
        if not chunk:
            sys.exit(f"{nick} never joined")
        buffer += chunk
    sock.settimeout(0.5)
    return sock


def main():
    where, channel = sys.argv[1], sys.argv[2]
    host, port = where.split(":")
    port = int(port)

    watcher = register(host, port, "watcher", channel)
    talker = register(host, port, "talker", channel)
    time.sleep(0.5)

    started = time.monotonic()
    talker.sendall(
        b"".join(f"PRIVMSG {channel} :burst {i:02d}\r\n".encode() for i in range(1, 21))
    )
    print(f"{0.0:8.3f} sent twenty in one write")

    seen = 0
    buffer = b""
    while seen < 20 and time.monotonic() - started < 20:
        try:
            chunk = watcher.recv(4096)
        except socket.timeout:
            continue
        if not chunk:
            break
        at = time.monotonic() - started
        buffer += chunk
        while b"\r\n" in buffer:
            raw, buffer = buffer.split(b"\r\n", 1)
            line = raw.decode("utf-8", "replace")
            if "PRIVMSG" in line and "burst" in line:
                seen += 1
                print(f"{at:8.3f} {line.split(':')[-1]}")

    print(f"{seen} of 20 arrived")
    watcher.close()
    talker.close()


if __name__ == "__main__":
    main()
