"""What the client asked the server for, per session.

    asks.py <tap log> [<tap log> ...]

Runs 16 to 20 counted `CHATHISTORY` asks to decide whether a page was fetched
twice. This counts them to decide something else: whether the build that ships
asks for the same things as the build every walk before run 18 was driven
against. `main.tsx` wraps the tree in `StrictMode`, so a debug run mounts every
effect twice and the priming loop in `Timeline.tsx` is entered twice per pane.
Whether that changes what reaches the socket is the question, and the socket is
where it has to be answered — the timeline's own raw log records the queue.

A session is one `session opened` line from `tap.py`, which is one launch of the
app. Prints per session: the asks in order, and any one of them made twice,
which is #487's duplicate.

**Every verb, not the two the paging runs counted.** The first version of this
counted `LATEST` and `BEFORE`, which is what runs 16 to 19 measured, and
reported that a restored launch asks for no history at all. It asks for plenty:
`CHATHISTORY TARGETS` for what changed while the app was down, then
`CHATHISTORY AFTER` per conversation to close the gap. Neither verb appears in
a first launch, and no walk before this one had a second launch's startup on a
tapped socket without scrolling it first.
"""

import re
import sys
from collections import Counter

ASK = re.compile(r"CHATHISTORY (\w+) (\S+) (\S+)")


def sessions(path):
    """Splits a tap log into one list of client lines per launch."""
    out = []
    for line in open(path):
        if "session opened" in line:
            out.append([])
            continue
        if len(line) < 12 or not out:
            continue
        if line[9] == ">":
            out[-1].append(line[11:].rstrip())
    return out


for path in sys.argv[1:]:
    print(path)
    for n, lines in enumerate(sessions(path), start=1):
        asks = [
            (hit.group(1), hit.group(2), hit.group(3))
            for body in lines
            if (hit := ASK.search(body))
        ]

        repeated = [
            f"{verb} {point}"
            for (verb, _, point), count in Counter(asks).items()
            if count > 1
        ]
        shown = " ".join(
            f"{verb}:{point.removeprefix('msgid=').removeprefix('timestamp=')[:8]}"
            for verb, _, point in asks
        )
        print(f"  session {n}: {len(asks):2d} asks  {shown}")
        if repeated:
            print(f"             repeated: {', '.join(repeated)}")
