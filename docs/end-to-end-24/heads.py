"""What happened to the parked pane each time the head arrived above it.

    heads.py <parked output directory> <runs>

One line per arrival: the commit that answered it, and the commit after. Prints
a table and then the cross-tabulation against nothing at all — the pixel verdict
lives in `shifts.txt` and the report is what puts the two side by side.

**The claim this is here to test.** The anchor answers the head arriving by
adding its height to `scrollTop`, on the commit the head lands in. The commit
after is where `scrollMargin` catches up to it, and between those two the
virtualiser can write to the scroller itself — it corrects for rows it has
measured above the viewport, in callbacks of its own. Where it does, the write
lands on top of the anchor's and nothing puts the reader back: the second pass
arms on the branch that answers a message moving, and the head is not one.

So the discriminator is `before` on the second commit against `top` on the
first. Equal is a landing nobody else touched. Different is the race, and the
size of the difference plus whatever the virtualiser re-measured is what the
reader ends up out by.

`screen` is where the reader's own message is drawn relative to the top of the
viewport, which is the number a photograph of the pane would agree with.
"""

import json
import sys

OUT, RUNS = sys.argv[1], int(sys.argv[2])
PARKED_FROM_X = 600

print(f"{'run':>6} {'msgs':>5} {'headPx':>6} {'top':>7} {'before':>7} {'outside':>7} {'screen':>7} {'moved':>6}")
for run in range(1, RUNS + 1):
    path = f"{OUT}/run{run}/probe.log"
    try:
        records = [json.loads(line) for line in open(path)]
    except OSError:
        print(f"{f'run{run}':>6}   no probe.log")
        continue
    records.sort(key=lambda r: r["n"])
    commits = [r for r in records if r["kind"] == "commit"]
    parked = {r["view"] for r in commits if r["x"] >= PARKED_FROM_X}
    if len(parked) != 1:
        print(f"{f'run{run}':>6}   {len(parked)} panes to the right, expected one")
        continue
    view = parked.pop()
    pane = [r for r in commits if r["view"] == view]
    for i, r in enumerate(pane[:-1]):
        if r["branch"] != "head" or r["headPx"] == 0:
            continue
        after = pane[i + 1]
        held = r["held"]
        if held is None or r["drawn"] is None or after["drawn"] is None:
            continue
        outside = after["before"] - r["top"]
        screen = after["drawn"] - after["top"]
        print(
            f"{f'run{run}':>6} {r['msgs']:>5} {r['headPx']:>6} {r['top']:>7} {after['before']:>7} "
            f"{outside:>+7} {screen:>+7} {screen - held['delta']:>+6}"
        )
