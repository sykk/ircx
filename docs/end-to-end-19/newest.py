"""Prints the highest `line NNNN` the server currently holds for a channel.

    newest.py <nick>

The seeder sends faster than ergo accepts. `fakelag` lets a client send five
commands and then two per second, so 2400 seeded lines take ten minutes to
reach the history buffer however quickly the socket took them — and a walk
started before the drain finishes is a walk with live messages arriving in it.

Run this until the number stops moving.
"""

import re
import socket
import sys
import time

NICK = sys.argv[1]
s = socket.create_connection(("127.0.0.1", 6677))


def send(line):
    s.sendall(line.encode() + b"\r\n")


send("CAP LS 302")
send(f"NICK {NICK}")
send(f"USER {NICK} 0 * :{NICK}")
time.sleep(0.4)
send("CAP REQ :draft/chathistory server-time batch message-tags")
send("CAP END")
time.sleep(1.2)
send("JOIN #scrollback")
time.sleep(1.2)
send("CHATHISTORY LATEST #scrollback * 20")
time.sleep(2)

s.setblocking(False)
buffer = b""
try:
    while True:
        chunk = s.recv(65536)
        if not chunk:
            break
        buffer += chunk
except BlockingIOError:
    pass

found = re.findall(r" :line (\d{4})", buffer.decode("utf-8", "replace"))
print(max(found) if found else "none")
send("QUIT :bye")
