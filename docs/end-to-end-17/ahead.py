"""Whether the client asked from the oldest row it holds, which is #494's question.

    ahead.py <tap log>

Run 16 read the *day* the asked-from message was said and called an ask stamped
today the inversion. That worked while `#scrollback` held yesterday's 900 lines
and nothing else. It does not now: every walk joins and quits, ergo replays both
as `HistServ` messages, and after run 16's twenty-eight sessions the newest 200
the server holds are mostly today's join and quit noise. The oldest row a
*correct* head names is drifting into today on its own, so the date test is on
its way to reporting the defect in a build that does not have it.

The question was never about a date. It is whether the head the client asks from
is the oldest thing it holds, and the wire says that without one:

  - **ahead** — the ask names a message newer than the oldest the server has
    delivered **and had time to be filed** in this session. Rows were filed in
    front of older ones, which is #494. The walk starts on a fresh profile, so
    everything the window holds came over this wire and the oldest delivered *is*
    the oldest it can hold.
  - **unresolved** — the ask names a msgid the server never sent. The head is
    one of the pane's own locally-stamped rows: the join digest and the
    `created on` line are exactly what run 15 photographed above the history.
  - **repeat** — two asks naming one msgid, which is the `#487` guard not
    firing and the shape #496 predicted.

No walk here gets close to `TIMELINE_CAP`, so a window that trimmed its own
oldest row cannot be what puts an ask ahead.

The comparison is against what had been delivered **when the ask went out**,
and getting that wrong is not a subtle error. Resolving each ask against the
session's finished minimum instead reported 19 of run 16's 20 clean walks as
inversions: a walk pages back more than once, so the second ask names the oldest
of a page that arrived after the first ask, and every earlier ask is "ahead" of
it by construction. The first reading of this instrument was that both builds
were broken.

**A tap reads the socket, not the client's list**, and that is the second thing
this got wrong. The bytes cross the tap some milliseconds before the client has
parsed, stored and re-rendered them, so an ask that goes out while a page is
arriving looks like an ask from the wrong end of a list the client had not yet
been given. Without a settle window, 80 walks flagged 16 asks — eight on each
build, which reads as a fix that changes nothing. Every one of the sixteen named
its row between **1 and 13 milliseconds** after the older rows hit the tap: a
request and a response crossing, not an inversion. With any window wider than
that, all sixteen go away and both builds report zero.

`SETTLE` is a second, which is orders of magnitude above the gap that produced
the false positives and far below the ten-odd seconds between a walk's asks.
"""

import re
import sys
from collections import defaultdict

STAMP = re.compile(r"time=([\d-]+T[\d:.]+Z)")
MSGID = re.compile(r"msgid=([^;\s]+)")
BEFORE = re.compile(r"CHATHISTORY BEFORE (\S+) msgid=(\S+) (\d+)")

SETTLE = 1.0

session = 0
said = {}
oldest = {}
oldest_at = {}
asks = defaultdict(list)
crossed = []

for line in open(sys.argv[1]):
    if "session opened" in line:
        session += 1
        continue
    if len(line) < 12:
        continue
    at, arrow, body = float(line[:8]), line[9], line[11:].rstrip()
    if arrow == "<":
        stamp, msgid = STAMP.search(body), MSGID.search(body)
        if stamp and msgid:
            said[msgid.group(1)] = stamp.group(1)
            # Oldest *delivered*, not oldest sent last: a history page arrives
            # after the live rows it is behind, so this is a running minimum
            # rather than the tail of the batch.
            if session not in oldest or stamp.group(1) < oldest[session]:
                oldest[session] = stamp.group(1)
                oldest_at[session] = at
        continue
    hit = BEFORE.search(body)
    if hit:
        # The running minimum is read here rather than after the file, because
        # the page this ask brings back moves it. The arrival time comes with it:
        # a minimum set milliseconds ago is one the client has not been given.
        held = oldest.get(session)
        if held is not None and at - oldest_at[session] < SETTLE:
            crossed.append((session, at - oldest_at[session]))
            held = None
        asks[session].append((hit.group(2), said.get(hit.group(2)), held))

print(f"{'walk':>4}  {'asks':>4}  {'ahead':>5}  {'unres':>5}  {'repeat':>6}   oldest delivered")
totals = [0, 0, 0]
for walk in range(1, session + 1):
    seen, ahead, unres, repeat = set(), 0, 0, 0
    for msgid, when, held in asks[walk]:
        if msgid in seen:
            repeat += 1
        seen.add(msgid)
        if when is None:
            unres += 1
        elif held is not None and when > held:
            ahead += 1
    totals = [totals[0] + ahead, totals[1] + unres, totals[2] + repeat]
    print(
        f"{walk:>4}  {len(asks[walk]):>4}  {ahead:>5}  {unres:>5}  {repeat:>6}"
        f"   {oldest.get(walk, '—')}"
    )

print()
print(f"sessions      {session}")
print(f"asks          {sum(len(w) for w in asks.values())}")
print(f"ahead         {totals[0]}")
print(f"unresolved    {totals[1]}")
print(f"repeated      {totals[2]}")
# Reported rather than dropped quietly: a run where this is large and `ahead` is
# zero has not shown the client is ordered, it has shown the walk asks while
# pages are landing. Silence here would read as coverage.
if crossed:
    gaps = sorted(gap for _, gap in crossed)
    print(
        f"not settled   {len(crossed)}  (ask crossed a page in flight; "
        f"gap {gaps[0]:.3f}-{gaps[-1]:.3f}s, under SETTLE={SETTLE}s)"
    )
