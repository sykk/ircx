"""A long-lived socket client driven from a FIFO, so a walk can interleave what
the second session does with what the window is doing.

    session.py <name> <logfile> [--account A:P] [--nick N] [--caps a,b] [--join #c]

Commands on stdin, one per line:

    say <target> <text>        PRIVMSG
    raw <line>                 as written
    mark <target> <stamp>      MARKREAD <target> timestamp=<stamp>
    ask <target>               MARKREAD <target>, the query form
    stamps <needle>            print the server-time of every line holding it
    grep <needle>              print every line holding it
    since <n>                  print every line after index n
    count                      print how many lines have arrived
    quit
"""
import sys, time
from irc import Client, register


def main():
    name, logpath = sys.argv[1], sys.argv[2]
    def opt(flag, fallback=None):
        return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else fallback

    account = opt("--account")
    nick = opt("--nick", name)
    caps = (opt("--caps") or "").split(",") if opt("--caps") else []
    log = open(logpath, "a", buffering=1)

    acct, password = (account.split(":") + [None])[:2] if account else (None, None)
    c = Client(name)
    i, line = register(c, nick, caps, acct, password)
    log.write(f"registered={bool(line)} {line}\n")
    for channel in [a for f, a in zip(sys.argv, sys.argv[1:]) if f == "--join"]:
        c.send(f"JOIN {channel}")
        c.wait(" 366 ", timeout=10)
        log.write(f"joined {channel}\n")
    print("ready", flush=True)

    for command in sys.stdin:
        verb, _, rest = command.strip().partition(" ")
        log.write(f"-- {command.strip()}\n")
        if verb == "say":
            target, _, text = rest.partition(" ")
            c.send(f"PRIVMSG {target} :{text}")
        elif verb == "raw":
            c.send(rest)
        elif verb == "mark":
            target, _, stamp = rest.partition(" ")
            c.send(f"MARKREAD {target} timestamp={stamp}")
        elif verb == "ask":
            c.send(f"MARKREAD {rest}")
        elif verb == "stamps":
            for _, l in c.lines:
                if rest in l and "time=" in l:
                    log.write(f"   stamp {l.split('time=')[1].split(';')[0].split(' ')[0]}  {l[-60:]}\n")
        elif verb == "grep":
            for at, (_, l) in enumerate(c.lines):
                if rest in l:
                    log.write(f"   [{at}] {l}\n")
        elif verb == "since":
            for at in range(int(rest), len(c.lines)):
                log.write(f"   [{at}] {c.lines[at][1]}\n")
        elif verb == "count":
            log.write(f"   count {len(c.lines)}\n")
        elif verb == "quit":
            break
        time.sleep(0.3)
    c.close()
    log.write("closed\n")


main()
