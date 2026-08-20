"""The instrument for run 38: the window, the sockets, and a bus of its own.

Run 37's shape with a notification daemon added. Whether ircx interrupts the
reader is a D-Bus call leaving the app rather than anything on screen, so the
whole walk starts under `dbus-run-session` — nothing reaches the operator's
desktop — and `notifyd.py` owns `org.freedesktop.Notifications` on that bus and
writes down every `Notify` it is handed. The window is a child of this process,
so it inherits the bus.

    dbus-run-session -- walk.py <fifo> <log> <shots> <notified> <worktree> \
        <nick> <channel> [opts...]

Commands, one per line on the FIFO:

    spawn <nick> [#chan]    a socket that registers and joins
    say <nick> <target> <text>
    sayid <nick> <name> <target> <text>     the same, and keep its msgid as $name
    react|unreact <nick> <target> <name> <emoji>
    raw <nick> <line>       $name is spelled out to the msgid it stands for
    win <command>           anything window.mjs takes
    pair <name>             two frames with a pause between, and their md5s
    since|grep|ids|kill|note|quit

What was raised is read out of <notified>, one JSON object per notification.
"""

import hashlib
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from irc import Client, register

fifo, logpath, shots, notified, worktree, nick, channel = sys.argv[1:8]
WINDOW = f"{worktree}/.claude/skills/run-ircx/window.mjs"

CAPS = ("message-tags", "server-time", "echo-message", "account-tag", "batch")

log = open(logpath, "a", buffering=1)


def note(text):
    log.write(f"{time.time():.3f} {text}\n")


# Before the window, so the name is owned by the time the app asks the bus who
# has it: a client that finds nobody there does not come back later.
notifier = subprocess.Popen(
    ["python3", os.path.join(os.path.dirname(os.path.abspath(__file__)), "notifyd.py"), notified],
    stdout=subprocess.PIPE, text=True, bufsize=1,
)
notifier.stdout.readline()

win = subprocess.Popen(
    ["node", WINDOW, "--server", "127.0.0.1:6677",
     "--nick", nick, "--join", channel, "--keep"] + sys.argv[8:],
    cwd=worktree, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
)
note(f"window: {win.stdout.readline().strip()}")

clients, ids = {}, {}


def send_window(command):
    win.stdin.write(command + "\n")
    win.stdin.flush()
    return win.stdout.readline().strip()


def msgid_of(line):
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
    for name, value in ids.items():
        text = text.replace(f"${name}", value or "")
    return text


print("ready", flush=True)

running = True
while running:
    with open(fifo) as commands:
        for command in commands:
            verb, _, rest = command.strip().partition(" ")
            if not verb:
                continue
            note(f"-- {command.strip()}")
            if verb == "win":
                # Through `spell`, so a `/react` typed into the composer can
                # name an id the server minted a moment ago.
                note(f"   window: {send_window(spell(rest))}")
            elif verb == "pair":
                first, second = f"{shots}/{rest}-a.png", f"{shots}/{rest}-b.png"
                note(f"   window: {send_window('ss ' + first)}")
                time.sleep(1.5)
                note(f"   window: {send_window('ss ' + second)}")
                digests = [hashlib.md5(open(p, 'rb').read()).hexdigest() for p in (first, second)]
                note(f"   {rest}: {digests[0]} {digests[1]} "
                     f"{'IDENTICAL' if digests[0] == digests[1] else 'MOVED'}")
            elif verb == "spawn":
                who, _, chan = rest.partition(" ")
                client = Client(who)
                _, line = register(client, who, caps=CAPS)
                note(f"   {who} registered: {line}")
                if chan:
                    client.send(f"JOIN {chan}")
                    client.wait(" 366 ", timeout=10)
                    note(f"   {who} joined {chan}")
                clients[who] = client
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
                clients[who].send(f"@{tag}={emoji};+reply={ids[name]} TAGMSG {target}")
            elif verb == "raw":
                who, _, line = rest.partition(" ")
                clients[who].send(spell(line))
            elif verb == "ids":
                for name, value in ids.items():
                    note(f"   {name} = {value}")
            elif verb == "since":
                who, _, at = rest.partition(" ")
                for i in range(int(at), len(clients[who].lines)):
                    note(f"   [{i}] {clients[who].lines[i][1]}")
            elif verb == "grep":
                who, _, needle = rest.partition(" ")
                for i, (_, line) in enumerate(clients[who].lines):
                    if needle in line:
                        note(f"   [{i}] {line}")
            elif verb == "note":
                pass
            elif verb == "quit":
                running = False
                break
            time.sleep(0.2)

note(f"window: {send_window('quit')}")
notifier.terminate()
for client in clients.values():
    client.close()
note("closed")
