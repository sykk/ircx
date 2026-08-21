"""Which line the parked reader is on, either side of the landing.

    drift.py <walk directory>...

**The reading cannot be pixels here and it cannot be `paneshift.py`.** The page
merges into the row the reader is inside, so every row in that pane draws
something different afterwards — a name over the run that was not there, a spine
where there was a stub — and strips that must match exactly cannot be found. Run
30 and run 31 both name this confound; run 31 answered it by reading the anchor's
own records instead, and twelve of fourteen strips are redrawn here.

**Nor can it be the anchor's message either side of the landing, which is what a
first version of this tried.** `messageAtOffset` answers with the first message
of the row under the top of the scroller, and the whole arrangement is a row
whose first message changes: the anchor names line 0610 going in and line 0600
coming out, and the difference between two of those is not a distance anybody
moved.

So the reading is the message the *viewport* opens with, in the line numbers the
seeder wrote into every body. The wire log carries both — `msgid=` and `line
NNNN` in the same line — so an id out of a record becomes a line number, and
"the reader was on 0634 and is on 0623" is a sentence a screenshot can be held
against. The pixels are printed beside it for scale.
"""

import json
import os
import re
import sys

LINE = re.compile(r"msgid=([a-z0-9]+).*PRIVMSG [^:]*:(?:\[[a-z]+\] )?(?:\w+: )?line (\d+)")


def numbering(path):
    """Every message the walk saw, by the number the seeder wrote into it."""
    out = {}
    for raw in open(path, errors="replace"):
        found = LINE.search(raw)
        if found:
            out[found.group(1)] = int(found.group(2))
    return out


def commits(path, side):
    out = []
    for raw in open(path):
        record = json.loads(raw)
        if record.get("kind") == "commit" and (record["x"] > 600) == (side == "right"):
            out.append(record)
    return out


def where(anchor, lines):
    if anchor is None:
        return "nothing recorded"
    number = lines.get(anchor["id"])
    at = anchor["delta"] + (anchor.get("within") or 0)
    return f"line {number:04d} at {at:>6}px" if number else f"{anchor['id'][:8]} at {at:>6}px"


for directory in sys.argv[1:]:
    probe = os.path.join(directory, "probe.log")
    print(os.path.basename(os.path.dirname(directory)) + "/" + os.path.basename(directory))
    if not os.path.exists(probe) or os.path.getsize(probe) == 0:
        print("  no records — a build without VITE_PROBE=1 writes none, and the frames are the reading")
        continue
    lines = numbering(os.path.join(directory, "wire.log"))
    for side in ("left", "right"):
        pane = commits(probe, side)
        landings = [
            index
            for index, (before, after) in enumerate(zip(pane, pane[1:]))
            if after["msgs"] - before["msgs"] >= 50
        ]
        if not landings:
            print(f"  {side}: no commit in this pane gained a page")
            continue
        at = landings[-1]
        before, after = pane[at], pane[-1]
        print(f"  {side:<5} parked at {before['top']:>6}  "
              f"{where(before.get('now'), lines)} → {where(after.get('now'), lines)}  "
              f"over {len(pane) - at - 1} commits")
