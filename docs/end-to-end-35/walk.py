"""The instrument for run 35: the window, the sockets and the ids in one process.

Run 34's shape, with the part a reaction needs added.  A reaction names the
message it answers by `msgid`, so a walk that sends one has to know an id the
server minted a moment earlier — `sayid` says a line, waits for the sender's own
echo, and keeps the id under a name the later commands spell.

    walk.py <fifo> <log> <shots> [window.mjs options...]

Commands, one per line on the FIFO:

    win <command...>        forward to window.mjs, log its reply
    spawn <who> [#channel]  a new socket client, registered and joined
    kill <who>
    say <who> <target> <text>
    sayid <who> <name> <target> <text>   say it, keep the echo's msgid as <name>
    react <who> <target> <name> <emoji>      TAGMSG, +draft/react + +draft/reply
    unreact <who> <target> <name> <emoji>    the same with +draft/unreact
    rawtag <who> <tags> <rest>   send `@<tags> <rest>`, with $name spelled out
    raw <who> <line>
    reply <who> <target> <name> <text>   PRIVMSG carrying +draft/reply
    ids                     log every id held
    since <who> <n>         log every line that client has past index n
    count <who>             log how many lines it holds
    grep <who> <needle>
    note <text>
    quit
"""

import os
import subprocess
import sys
import time

from irc import Client, register

WORKTREE = "/home/syk/ircx-run35"
WINDOW = f"{WORKTREE}/.claude/skills/run-ircx/window.mjs"

# `echo-message` is what makes a client hear its own line back, and the echo is
# the only place the id the server minted appears.  `message-tags` carries the
# reaction itself; without it ergo relays no TAGMSG at all.
CAPS = ("message-tags", "server-time", "echo-message", "account-tag", "batch")

fifo, logpath, shots = sys.argv[1], sys.argv[2], sys.argv[3]
log = open(logpath, "a", buffering=1)


def note(text):
    log.write(f"{time.time():.3f} {text}\n")


win = subprocess.Popen(
    [
        "node",
        WINDOW,
        "--release",
        "--server",
        "127.0.0.1:6690",
        "--nick",
        "walker35",
        "--join",
        "#react35",
        "--keep",
    ]
    + sys.argv[4:],
    cwd=WORKTREE,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True,
    bufsize=1,
)

note(f"window: {win.stdout.readline().strip()}")

clients = {}
ids = {}


def spawn(name, channel=None):
    client = Client(name)
    _, line = register(client, name, caps=CAPS)
    note(f"{name} registered: {line}")
    if channel:
        client.send(f"JOIN {channel}")
        client.wait(" 366 ", timeout=10)
        note(f"{name} joined {channel}")
    clients[name] = client


def msgid_of(line):
    """The `msgid` tag of a tagged line, which is the whole point of the echo."""
    if not line.startswith("@"):
        return None
    for tag in line[1:].split(" ", 1)[0].split(";"):
        key, _, value = tag.partition("=")
        if key == "msgid":
            return value
    return None


def sayid(who, name, target, text):
    client = clients[who]
    at = len(client.lines)
    client.send(f"PRIVMSG {target} :{text}")
    index, line = client.wait(f"PRIVMSG {target} :{text}", timeout=10, after=at)
    if line is None:
        note(f"   !! no echo of {who}'s line to {target}")
        return
    ids[name] = msgid_of(line)
    note(f"   {name} = {ids[name]}   ({line})")


def spell(text):
    """`$name` is the id kept under that name, so a raw line can name one."""
    for name, value in ids.items():
        text = text.replace(f"${name}", value or "")
    return text


print("ready", flush=True)

while True:
    with open(fifo) as commands:
        for command in commands:
            verb, _, rest = command.strip().partition(" ")
            if not verb:
                continue
            note(f"-- {command.strip()}")
            if verb == "win":
                win.stdin.write(rest + "\n")
                win.stdin.flush()
                note(f"   window: {win.stdout.readline().strip()}")
            elif verb == "spawn":
                who, _, channel = rest.partition(" ")
                spawn(who, channel or None)
            elif verb == "kill":
                clients.pop(rest).close()
                note(f"   {rest} closed")
            elif verb == "say":
                who, _, rest = rest.partition(" ")
                target, _, text = rest.partition(" ")
                clients[who].send(f"PRIVMSG {target} :{text}")
            elif verb == "sayid":
                who, _, rest = rest.partition(" ")
                name, _, rest = rest.partition(" ")
                target, _, text = rest.partition(" ")
                sayid(who, name, target, text)
            elif verb in ("react", "unreact"):
                who, _, rest = rest.partition(" ")
                target, _, rest = rest.partition(" ")
                name, _, emoji = rest.partition(" ")
                tag = "+draft/react" if verb == "react" else "+draft/unreact"
                clients[who].send(
                    f"@{tag}={emoji};+draft/reply={ids[name]} TAGMSG {target}"
                )
            elif verb == "reply":
                who, _, rest = rest.partition(" ")
                target, _, rest = rest.partition(" ")
                name, _, text = rest.partition(" ")
                clients[who].send(
                    f"@+draft/reply={ids[name]} PRIVMSG {target} :{text}"
                )
            elif verb == "rawtag":
                who, _, rest = rest.partition(" ")
                tags, _, line = rest.partition(" ")
                clients[who].send(spell(f"@{tags} {line}"))
            elif verb == "raw":
                who, _, line = rest.partition(" ")
                clients[who].send(spell(line))
            elif verb == "ids":
                for name, value in ids.items():
                    note(f"   {name} = {value}")
            elif verb == "since":
                who, _, at = rest.partition(" ")
                client = clients[who]
                for i in range(int(at), len(client.lines)):
                    note(f"   [{i}] {client.lines[i][1]}")
            elif verb == "count":
                note(f"   {rest} holds {len(clients[rest].lines)} lines")
            elif verb == "grep":
                who, _, needle = rest.partition(" ")
                for i, (_, line) in enumerate(clients[who].lines):
                    if needle in line:
                        note(f"   [{i}] {line}")
            elif verb == "note":
                pass
            elif verb == "quit":
                break
            time.sleep(0.2)
        else:
            continue
        break

win.stdin.write("quit\n")
win.stdin.flush()
note(f"window: {win.stdout.readline().strip()}")
for client in clients.values():
    client.close()
note("closed")
