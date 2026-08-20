"""A client that answers a CTCP the way ircx answers one, and counts.

`handle_incoming_ctcp` replies on whatever command the request arrived on, and
nothing above it asks whether that command was a NOTICE.  Both halves of that
are what CTCP forbids, and the reason it forbids them is this program: a peer
following the same rule has no way to tell ircx's reply from a request, so the
two of them trade the same line until something outside stops it.

    ctcploop.py <nick> <target> [exchanges]

Sends one `\\x01PING\\x01` as a PRIVMSG, then answers every CTCP it is sent with
the same body on the same command, up to `exchanges` and no further — the point
is that nothing at either end would have stopped.
"""

import sys
import time

from irc import Client, register

nick, target = sys.argv[1], sys.argv[2]
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 8

client = Client(nick)
register(client, nick)
time.sleep(0.5)

cursor = len(client.lines)
client.send(f"PRIVMSG {target} :\x01PING loop\x01")
print(f">> PRIVMSG {target} :\\x01PING loop\\x01", flush=True)

seen = 0
deadline = time.time() + 60
while seen < limit and time.time() < deadline:
    if cursor >= len(client.lines):
        time.sleep(0.1)
        continue
    line = client.lines[cursor][1]
    cursor += 1
    if " :\x01" not in line or f" {nick} :" not in line:
        continue
    verb = line.split(" ")[1]
    body = line.split(" :", 1)[1]
    seen += 1
    print(f"<< {verb} {body.strip(chr(1))!r}", flush=True)
    client.send(f"{verb} {target} :{body}")
    time.sleep(0.4)

ended = "the counter, not by either client" if seen >= limit else "ircx going quiet"
print(f"{seen} exchanges of {limit} allowed — stopped by {ended}")
client.close()
