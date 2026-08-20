"""The instrument for run 39: two panes on one conversation, one of them live.

Run 38's walk with three changes, each of them because this run measures a
split rather than a notification.

  * The notification daemon is gone; nothing here interrupts anybody.
  * The plan arrives on stdin rather than through a FIFO. Every step of this
    run is decided before it starts — a frame, a line, a wheel burst, a frame —
    and a walk that can be replayed from a file is one `run.sh` can run nine
    times without a human at the other end of the pipe.
  * The launch is an argument. This run launches twice: once to split the pane
    and keep the profile, once to restore it and be measured, which is run 23's
    shape and for run 23's reason — `ctrl+backslash` has to have happened
    before anything is measured, and a launch that has just restored a two-pane
    tree is the state #508 was reported in.

    walk.py <log> <shots> <worktree> -- <window.mjs arguments...>

Commands, one per line on stdin:

    spawn <nick> [#chan]    a socket that registers and joins
    say <nick> <target> <text>
    win <command>           anything window.mjs takes
    shot <name>             one frame into <shots>/<name>.png
    pair <name>             two frames 1.5s apart, and whether they differ
    note <text>             a line in the log, for reading the walk afterwards
    since|grep|kill|quit

`say` returns when the server has echoed the line back to the client that sent
it, which is a barrier and not a tidiness: the frame after it has to be a frame
the line had a chance to reach, and `time.sleep` in the plan would be timing the
socket rather than the client.
"""

import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "end-to-end-38"))
from irc import Client, register  # noqa: E402

logpath, shots, worktree = sys.argv[1:4]
launch = sys.argv[sys.argv.index("--") + 1:]
WINDOW = f"{worktree}/.claude/skills/run-ircx/window.mjs"
CAPS = ("message-tags", "server-time", "echo-message", "account-tag", "batch")

os.makedirs(shots, exist_ok=True)
log = open(logpath, "a", buffering=1)


def note(text):
    log.write(f"{time.time():.3f} {text}\n")


win = subprocess.Popen(["node", WINDOW] + launch, cwd=worktree,
                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
note(f"window: {win.stdout.readline().strip()}")

clients = {}


def send_window(command):
    win.stdin.write(command + "\n")
    win.stdin.flush()
    return win.stdout.readline().strip()


for command in sys.stdin:
    verb, _, rest = command.strip().partition(" ")
    if not verb or verb.startswith("#"):
        continue
    note(f"-- {command.strip()}")
    if verb == "win":
        note(f"   window: {send_window(rest)}")
    elif verb == "shot":
        note(f"   window: {send_window(f'ss {shots}/{rest}.png')}")
    elif verb == "pair":
        first, second = f"{shots}/{rest}-a.png", f"{shots}/{rest}-b.png"
        note(f"   window: {send_window('ss ' + first)}")
        time.sleep(1.5)
        note(f"   window: {send_window('ss ' + second)}")
    elif verb == "spawn":
        who, _, chan = rest.partition(" ")
        client = Client(who, port=int(os.environ["WALK_PORT"]))
        _, line = register(client, who, caps=CAPS)
        note(f"   {who} registered: {line}")
        if chan:
            client.send(f"JOIN {chan}")
            client.wait(" 366 ", timeout=10)
            note(f"   {who} joined {chan}")
        clients[who] = client
    elif verb == "say":
        who, _, rest = rest.partition(" ")
        target, _, text = rest.partition(" ")
        client = clients[who]
        at = len(client.lines)
        client.send(f"PRIVMSG {target} :{text}")
        _, line = client.wait(f"PRIVMSG {target} :{text}", timeout=10, after=at)
        note(f"   echoed: {line}")
    elif verb == "kill":
        clients.pop(rest).close()
        note(f"   {rest} closed")
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
        break

note(f"window: {send_window('quit')}")
for client in clients.values():
    client.close()
note("closed")
