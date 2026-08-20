"""The instrument for run 36: the window, the sockets and the rewriting proxy.

Run 35's shape — one process holds the window and every socket, driven from a
FIFO, so the order of a line and the photograph after it is stated rather than
hoped for.  What this run adds is control of the proxy: `recase` writes the rule
file `proxy.py` re-reads, so a server that hands a nick back differently spelled
is something a walk can turn on between two lines and off again.

    walk.py <fifo> <log> <shots> <rules> <worktree> <nick> <channel> [opts...]

Commands, one per line on the FIFO — run 35's, plus:

    recase <from> <to>      from here on, that nick arrives on TAGMSG as <to>
    norecase                stop rewriting
    pair <name>             two frames with a pause between, and their md5s
"""

import hashlib
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from irc import Client, register

fifo, logpath, shots, rulepath, worktree, nick, channel = sys.argv[1:8]
WINDOW = f"{worktree}/.claude/skills/run-ircx/window.mjs"

CAPS = ("message-tags", "server-time", "echo-message", "account-tag", "batch")

log = open(logpath, "a", buffering=1)


def note(text):
    log.write(f"{time.time():.3f} {text}\n")


win = subprocess.Popen(
    ["node", WINDOW, "--release", "--server", "127.0.0.1:6690",
     "--nick", nick, "--join", channel, "--keep"] + sys.argv[8:],
    cwd=worktree, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
)
note(f"window: {win.stdout.readline().strip()}")

clients, ids, rules = {}, {}, []


def write_rules():
    with open(rulepath, "w") as handle:
        handle.write("".join(f"{old} {new}\n" for old, new in rules))
    note(f"   rules: {rules or 'none'}")


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


write_rules()
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
            elif verb == "recase":
                old, _, new = rest.partition(" ")
                rules.append((old, new))
                write_rules()
            elif verb == "norecase":
                rules.clear()
                write_rules()
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
for client in clients.values():
    client.close()
note("closed")
