"""The instrument for run 34: one process holding the window and every socket
beside it, driven from a FIFO.

Run 33 kept its second session in a program of its own and interleaved it with
the window by hand.  An ignore is a question about what the app does *not* do,
which is only ever answered by a line on the wire and a photograph taken after
it, so both ends belong in one process where the ordering is stated rather than
hoped for.

    walk.py <fifo> <log> <shots>

Commands, one per line on the FIFO:

    win <command...>        forward to window.mjs, log its reply
    say <who> <target> <text>
    ctcp <who> <target> <request>
    raw <who> <line>
    spawn <who> [#channel]  a new socket client, registered and joined
    kill <who>
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

WORKTREE = "/home/syk/ircx/.claude/worktrees/e2e-run-34"
WINDOW = f"{WORKTREE}/.claude/skills/run-ircx/window.mjs"

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
        "walker34",
        "--join",
        "#ignore34",
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


def spawn(name, channel=None):
    client = Client(name)
    _, line = register(client, name)
    note(f"{name} registered: {line}")
    if channel:
        client.send(f"JOIN {channel}")
        client.wait(" 366 ", timeout=10)
        note(f"{name} joined {channel}")
    clients[name] = client


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
            elif verb == "ctcp":
                who, _, rest = rest.partition(" ")
                target, _, request = rest.partition(" ")
                clients[who].send(f"PRIVMSG {target} :\x01{request}\x01")
            elif verb == "raw":
                who, _, line = rest.partition(" ")
                clients[who].send(line)
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
