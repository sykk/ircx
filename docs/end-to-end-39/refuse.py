"""A seeded channel that will not take the reader's message.

    refuse.py <host:port> <#channel> <how many> <seed.py path>

The `sendfail` arm needs a channel with an archive to park in and a server that
refuses what the reader sends into it, and the order the two are arranged in is
the whole of this script. `warden` joins the empty channel first, which is what
ergo gives `+o` to; run 23's seeder then fills it while anybody may speak; and
`+m` goes on last, so the history is there and the next line typed into it comes
back `404`.

Moderating it any earlier would refuse the seed as well, and the reader would
park in an empty channel.

Stays connected, because `+m` lasts as long as the channel does and a channel
lasts as long as somebody is in it.
"""

import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "end-to-end-38"))
from irc import Client, register  # noqa: E402

where, channel, total, seeder = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
host, port = where.split(":")

warden = Client("warden", host=host, port=int(port))
register(warden, "warden")
warden.send(f"JOIN {channel}")
warden.wait(" 366 ", timeout=10)
print(f"warden holds {channel}", flush=True)

# The seeder never returns — it holds its speakers on the socket so the channel
# keeps its members — so it is watched for the line it prints rather than waited
# on, which is what `run.sh` does with it too.
filling = subprocess.Popen(["python3", seeder, where, channel, total],
                           stdout=subprocess.PIPE, text=True, bufsize=1)
while True:
    line = filling.stdout.readline()
    if not line:
        sys.exit("the seeder stopped before it had seeded anything")
    print(line.strip(), flush=True)
    if line.startswith("seeded "):
        break

warden.send(f"MODE {channel} +m")
index, line = warden.wait(f"MODE {channel} +m", timeout=10)
if line is None:
    sys.exit(f"{channel} was never moderated")
print(f"moderated: {line}", flush=True)

while True:
    time.sleep(30)
