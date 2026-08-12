"""What the client asked the server for, and when the message it asked from was said.

    asked.py <tap log>

`pageBack` sends the oldest message the window holds, so every
`CHATHISTORY BEFORE` on the wire names the frontend's own head. That is the
reading of the store's list that runs 14 and 15 both wanted and neither got: a
head stamped today, in a window that also holds yesterday, is #494's inversion,
and it says so without anybody having to read a screenshot.

The msgid is resolved against the server's own lines earlier in the same log,
which is why the tap records both directions. A request carries a `@label` tag,
so the verb is not at the head of the line — matching on the start of one is how
the first version of this counted twenty requests as none.
"""

import re
import sys
from collections import defaultdict

STAMP = re.compile(r"time=([\d-]+T[\d:.]+Z)")
MSGID = re.compile(r"msgid=([^;\s]+)")
BEFORE = re.compile(r"CHATHISTORY BEFORE (\S+) msgid=(\S+) (\d+)")

session = 0
said = {}
asks = defaultdict(list)
latest = defaultdict(int)

for line in open(sys.argv[1]):
    if "session opened" in line:
        session += 1
        continue
    arrow, body = line[9], line[11:].rstrip()
    if arrow == "<":
        stamp, msgid = STAMP.search(body), MSGID.search(body)
        if stamp and msgid:
            said[msgid.group(1)] = stamp.group(1)
        continue
    if "CHATHISTORY LATEST" in body:
        latest[session] += 1
    hit = BEFORE.search(body)
    if hit:
        asks[session].append(said.get(hit.group(2), "unresolved"))

width = max(len(w) for walk in asks.values() for w in walk)
print(f"{'walk':>4}  {'LATEST':>6}  {'BEFORE':>6}   asked from")
for walk in range(1, session + 1):
    when = "   ".join(f"{w:>{width}}" for w in asks[walk])
    print(f"{walk:>4}  {latest[walk]:>6}  {len(asks[walk]):>6}   {when}")

days = sorted({w[:10] for walk in asks.values() for w in walk})
print()
print(f"sessions                {session}")
print(f"LATEST per walk         {sorted(set(latest.values()))}")
print(f"BEFORE per walk         {sorted({len(w) for w in asks.values()})}")
print(f"days asked from         {days}")
print(f"asks from today         {sum(w.startswith('2026-08-12') for walk in asks.values() for w in walk)}")
print(f"unresolved              {sum(w == 'unresolved' for walk in asks.values() for w in walk)}")
