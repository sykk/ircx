"""Does ergo relay MARKREAD between two sessions of one account, and does it
keep the marker for a session that arrives later?  ircx is not involved."""
from irc import Client, register
import time, sys

ACCOUNT, PASSWORD, CHAN = "walkacct", "walkpassword33", "#markwalk"
CAPS = ["server-time", "message-tags", "batch", "draft/read-marker", "echo-message"]

# 1. the account, made from the socket the way any client would
reg = Client("reg")
i, line = register(reg, ACCOUNT)
if not line:
    print("registrar never reached 001"); sys.exit(1)
reg.send(f"REGISTER {ACCOUNT} * {PASSWORD}")
i, line = reg.wait("REGISTER", timeout=5)
print("register:", line)
reg.close()
time.sleep(0.5)

# 2. two sessions of that account
a = Client("A")
i, line = register(a, ACCOUNT, CAPS, ACCOUNT, PASSWORD)
print("A 001:", bool(line))
print("A caps:", [l for _, l in a.lines if " CAP " in l and " ACK " in l])
a.send(f"JOIN {CHAN}")
a.wait(" 366 ")

b = Client("B")
i, line = register(b, ACCOUNT, CAPS, ACCOUNT, PASSWORD)
print("B 001:", bool(line))
time.sleep(0.5)
print("B sees itself in:", [l for _, l in b.lines if " JOIN " in l][:3])

# 3. somebody talks
t = Client("T")
register(t, "talker33", ["server-time", "message-tags"])
t.send(f"JOIN {CHAN}")
t.wait(" 366 ")
stamps = []
for n in range(1, 6):
    t.send(f"PRIVMSG {CHAN} :line {n}")
    i, line = a.wait(f"line {n}", timeout=5)
    stamps.append(line.split("time=")[1].split(";")[0].split(" ")[0])
    time.sleep(0.15)
print("stamps:", stamps)

# 4. A marks the third line read.  Does B hear about it?
mark = stamps[2]
before = len(b.lines)
a.send(f"MARKREAD {CHAN} timestamp={mark}")
i, relayed = b.wait("MARKREAD", timeout=5, after=before)
print("A's own answer:", a.wait('MARKREAD', timeout=3, after=0)[1])
print("relayed to B  :", relayed)

# 5. a session that arrives afterwards asks for the marker
c = Client("C")
register(c, ACCOUNT, CAPS, ACCOUNT, PASSWORD)
before = len(c.lines)
c.send(f"MARKREAD {CHAN}")
i, answer = c.wait("MARKREAD", timeout=5, after=before)
print("asked by a new session:", answer)

for client in (a, b, t, c):
    client.close()
