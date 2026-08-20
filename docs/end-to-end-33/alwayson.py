from irc import Client, register
import time
c = Client("ns")
register(c, "walkacct", ["server-time"], "walkacct", "walkpassword33")
c.send("PRIVMSG NickServ :SET always-on true")
time.sleep(1.5)
for _, l in c.lines[-4:]:
    print("<<", l)
c.close()
