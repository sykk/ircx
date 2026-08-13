"""What the parked pane did between two frames, out of the window's own records.

    read.py <probe.log> <before.png> <after.png>

Prints a ledger of the pane nobody is scrolling, one line per commit, and a
verdict. Exits 0 whatever it finds: this reports, it does not judge a run.

**The question it exists for.** A band of text sitting 24px lower in the second
frame is one of two different defects and a photograph cannot tell them apart:

  - `scrollTop` was written to the wrong place, or
  - `scrollTop` is where it was and the content above the reader grew under it.

Every commit record carries both halves. `held` is the message the reader was on
and `delta` is where it was drawn on the screen, both measured on the commit
before; `drawn` is where that same message is drawn now and `top` is `scrollTop`
now. So

    moved = (drawn - top) - held.delta

is how far the message under the reader's eyes travelled during that commit,
positive being down the screen, and `before` against `top` says whether anything
wrote to the scroller to make it happen.

**Which pane is which** is `x`, the scroller's own left edge, because a view id
is arbitrary and the frames are photographs. The parked pane is the right one.

**The frames are timed by their mtime**, which is when ImageMagick finished
writing the file rather than when the screen was read — a couple of hundred
milliseconds later. The window opens half a second early for it, and every line
is stamped so a record near an edge can be seen to be near one.
"""

import json
import os
import sys

# The right pane's scroller starts past the middle of a 1200px window. The left
# one starts at the sidebar's edge, a couple of hundred pixels in, so anything
# in between would be a window this walk did not lay out.
PARKED_FROM_X = 600
# What a frame's mtime is allowed to be late by.
LEAD_MS = 500

LOG, BEFORE, AFTER = sys.argv[1], sys.argv[2], sys.argv[3]

records = []
with open(LOG) as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))
records.sort(key=lambda r: r["n"])

commits = [r for r in records if r["kind"] == "commit"]
if not commits:
    sys.exit(f"{LOG}: no commit records — was the build made with VITE_PROBE=1?")

parked = {r["view"] for r in commits if r["x"] >= PARKED_FROM_X}
if len(parked) != 1:
    sys.exit(f"{LOG}: {len(parked)} panes to the right of x={PARKED_FROM_X}, expected one")
view = parked.pop()
x = next(r["x"] for r in commits if r["view"] == view)

start = os.path.getmtime(BEFORE) * 1000 - LEAD_MS
end = os.path.getmtime(AFTER) * 1000
window = [r for r in records if r["view"] == view and start <= r["at"] <= end]

print(f"the parked pane is {view}, at x={x}")
print(f"{len(window)} of its records between the frames, of {sum(1 for r in records if r['view'] == view)}")
print()
print(f"{'ms':>7}  {'kind':7} {'branch':7} {'msgs':>5} {'before':>7} {'top':>7} {'held':>6} {'moved':>6}")

moved_total = 0
outside = 0
last_top = None
for r in window:
    ms = round(r["at"] - start - LEAD_MS)
    if r["kind"] != "commit":
        top = r.get("top")
        print(f"{ms:>7}  {r['kind']:7} {'':7} {'':>5} {'':>7} {top:>7} {'':>6} {'':>6}")
        last_top = top
        continue
    held, drawn = r["held"], r["drawn"]
    moved = None if held is None or drawn is None else (drawn - r["top"]) - held["delta"]
    if moved:
        moved_total += moved
    # A write nobody committed: the virtualiser corrects the scroller from its
    # own measurement callbacks, which is between two of these.
    if last_top is not None and r["before"] != last_top:
        outside += r["before"] - last_top
    last_top = r["top"]
    # The id is a local one and 26 characters of it; the leading six tell one
    # message from another, which is all a ledger needs of it.
    print(
        f"{ms:>7}  {r['kind']:7} {r['branch']:7} {r['msgs']:>5} {r['before']:>7} {r['top']:>7} "
        f"{(held['id'][:6] if held else '—'):>6} {('—' if moved is None else moved):>6}"
    )

print()
if moved_total == 0:
    print("verdict: the message under the reader did not move")
    sys.exit(0)

writes = sum(1 for r in window if r["kind"] == "commit" and r["before"] != r["top"])
print(f"verdict: the reader's message moved {moved_total:+d}px down the screen")
print(f"         {writes} of the commits wrote to scrollTop; {outside:+d}px was written outside one")
print(
    "         "
    + (
        "with the scroller written to, so where it was put is the question"
        if writes or outside
        else "with nothing written to the scroller at all, so the content above it grew"
    )
)
