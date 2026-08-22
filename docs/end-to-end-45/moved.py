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

paid, unpaid = [], []
was = None
for record in records:
    if was is not None and record["sh"] - was["sh"] == CHIP:
        grew = record["sh"] - was["sh"]
        by = record["top"] - was["top"]
        before, after = was.get("fold") or {}, record.get("fold") or {}
        held = before.get("id") == after.get("id")
        (paid if by == grew else unpaid).append((record["n"], grew, by, held, before, after))
    was = record

print(f"{len(records)} commits, {len(paid) + len(unpaid)} of them a row of chips going in above the reader")
for n, grew, by, held, before, after in sorted(paid + unpaid):
    if held:
        print(f"  commit {n}: content +{grew}, pane +{by} — the reader held on {before.get('id')} at y {after.get('y')}")
    else:
        print(
            f"  commit {n}: content +{grew}, pane +{by} — the reader went from "
            f"{before.get('id')} at y {before.get('y')} to {after.get('id')} at y {after.get('y')}"
        )
print(f"  {len(paid)} paid for, {len(unpaid)} not, {sum(grew for _, grew, _, _, _, _ in unpaid)}px owed")
