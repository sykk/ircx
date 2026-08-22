"""Whether the pane was paid for the content that went in above the reader.

    moved.py <probe.log>

Run 43 read a displacement as a subtraction on one message between two commits
the pane was at rest on. Nothing here is at rest: #611 only exists while the
reader is scrolling, and the reader is scrolling for the whole of the gesture.

So the reading is the transaction rather than the distance. A commit where the
content grew is a commit where the pane owes the reader the same number of
pixels — the growth is above them, which the reactor's own log asserts by
naming a line a hundred above the fold. Paid, and the message at the fold is
still there when the commit is over. Unpaid, and it is a different message: the
conversation came down and the reader did not.

**The message at the fold changing is why nothing simpler works.** A subtraction
on one message cannot read a displacement whose whole effect is to put another
message where that one was.

Growths of a thousand pixels and more are the rows above being measured for the
first time as the reader scrolls into them, which the virtualiser pays for going
either way. What #611 is about is the small ones — one row of reaction chips —
and they are told apart by size here rather than by guesswork: `--chip` is what
a first reaction on a message adds.

**Paid is read off the reader and not off the arithmetic.** The release app lays
out at fractional pixels, so a growth of 28 paid in full reads as 26 there and a
rule comparing those two numbers calls it a debt. What settles it is the reader:
the same message at the fold, drawn where it was.

How far they moved is read the same way, and which way depends on what the
record can say. The same message somewhere else is the distance between the two
drawings of it. A *different* message at the fold is a displacement whose size
that subtraction cannot reach — it is the growth, which is what put the other
message there.

**And a commit the reader wheeled in cannot be read at all.** The pane moving by
neither nothing nor the growth is a notch landing in the same commit as a row of
chips, and then the message at the fold changed because the reader went looking
for it. Those are counted apart rather than called either thing: on the debug
build they do not happen — the gesture is a notch every 120ms and the commits
fall between — and on the release build they happen once or twice a walk.
"""

import json
import sys

CHIP = int(sys.argv[sys.argv.index("--chip") + 1]) if "--chip" in sys.argv else 28

records = []
for line in open(sys.argv[1]):
    try:
        record = json.loads(line)
    except ValueError:
        continue
    if record.get("kind") == "commit" and record.get("top") is not None:
        records.append(record)

# The release app lays out at fractional pixels, so a payment and a hold are
# both a couple of pixels loose there and exact on the debug build.
SLACK = 2

paid, unpaid, wheeled = [], [], []
was = None
for record in records:
    if was is not None and record["sh"] - was["sh"] == CHIP:
        grew = record["sh"] - was["sh"]
        by = record["top"] - was["top"]
        before, after = was.get("fold") or {}, record.get("fold") or {}
        same = before.get("id") == after.get("id")
        slid = abs(after.get("y", 0) - before.get("y", 0)) if same else grew
        row = (record["n"], grew, by, slid, same, before, after)
        if abs(by) > SLACK and abs(by - grew) > SLACK:
            wheeled.append(row)
        elif same and slid <= SLACK:
            paid.append(row)
        else:
            unpaid.append(row)
    was = record

print(
    f"{len(records)} commits, {len(paid) + len(unpaid) + len(wheeled)} of them "
    "a row of chips going in above the reader"
)
for row in sorted(paid + unpaid + wheeled):
    n, grew, by, slid, _, before, after = row
    if row in paid:
        print(f"  commit {n}: content +{grew}, pane {by:+d} — the reader held on {before.get('id')} at y {after.get('y')}")
    elif row in wheeled:
        print(f"  commit {n}: content +{grew}, pane {by:+d} — the reader wheeled in this commit, so it says nothing")
    else:
        print(
            f"  commit {n}: content +{grew}, pane {by:+d} — the reader moved {slid}px, from "
            f"{before.get('id')} at y {before.get('y')} to {after.get('id')} at y {after.get('y')}"
        )
print(
    f"  {len(paid)} paid for, {len(unpaid)} not, "
    f"{sum(slid for _, _, _, slid, _, _, _ in unpaid)}px of reader moved"
    + (f", {len(wheeled)} unreadable" if wheeled else "")
)
