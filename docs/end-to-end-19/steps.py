"""How far back each page-back moved, which is what a wasted one would not.

    steps.py <tap log> [<tap log> ...]

The control arm's first ask names the newest end of what the pane had just been
given, and the reading that suggests is #496's own shape: an ask computed from
`older[0]` when the page is not behind the window re-requests the page the
client already holds.

A wasted ask is visible without knowing anything about the archive. The seeded
channel is 200 messages to a page and the seeder wrote about four a second, so
one page is fifty seconds of history: **an ask that fetches a page the client
already has moves the head by much less than a page, and the next ask closes the
gap.** A uniform run of full steps is a walk where every ask paid for itself.

Prints the step between consecutive asks, in seconds, per session.
"""

import re
import sys
from datetime import datetime

STAMP = re.compile(r"time=([\d-]+T[\d:.]+Z)")
MSGID = re.compile(r"msgid=([^;\s]+)")
BEFORE = re.compile(r"CHATHISTORY BEFORE (\S+) msgid=(\S+) (\d+)")


def when(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ")


for path in sys.argv[1:]:
    said = {}
    asks = []
    session = 0
    for line in open(path):
        if "session opened" in line:
            session += 1
            continue
        if len(line) < 12:
            continue
        arrow, body = line[9], line[11:].rstrip()
        if arrow == "<":
            stamp, msgid = STAMP.search(body), MSGID.search(body)
            if stamp and msgid:
                said[msgid.group(1)] = stamp.group(1)
            continue
        hit = BEFORE.search(body)
        if hit and session == 2:
            asks.append(hit.group(2))

    stamps = [said.get(a) for a in asks]
    if len(stamps) < 2 or any(s is None for s in stamps):
        print(f"{path[-30:]:>30}  {len(asks)} asks, unresolved")
        continue
    steps = [
        (when(stamps[i]) - when(stamps[i + 1])).total_seconds()
        for i in range(len(stamps) - 1)
    ]
    shown = " ".join(f"{s:5.1f}" for s in steps)
    print(f"{path[-30:]:>30}  {len(asks):2d} asks  steps: {shown}")
