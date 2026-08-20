"""Does a server echo your own TAGMSG back to you under echo-message, with no
second session of the account involved?  That decides whether the typing row
ircx draws for itself needs an account to reproduce."""
from irc import Client, register
import time
c = Client("E")
register(c, "echotest33", ["server-time", "message-tags", "echo-message"])
c.send("JOIN #echotag")
c.wait(" 366 ")
before = len(c.lines)
c.send("@+typing=active TAGMSG #echotag")
time.sleep(1.5)
back = [l for _, l in c.lines[before:] if "TAGMSG" in l]
print("echoed back to sender:", bool(back))
for l in back:
    print("  <<", l)
c.close()
