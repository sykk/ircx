"""The frames either side of the release, and what each pane did across them.

    pick.py <walk directory>

Run 30's `pick.py`, reading both panes off the same frames. The choice of frames
is that script's and so is the reason for it: `parked.sh` photographs on a timer
without knowing which pair the page will land between, and the pair is chosen
afterwards against the epoch `latepage.py` stamps on the release.

Three pairs per pane, and the first and last are what make the middle one mean
anything:

    still    two frames before the landing, neither of which contains it
    landing  the pair the release falls between
    after    two frames past it, once the page is in

Three readings per pair, because a pane that did not move is not the same claim
as a pane that did not change:

    the distance   `paneshift.py`, over the message column
    rows           `still.py`, pixel for pixel over that same column
    pane           pixel for pixel over the whole pane, spine and scrollbar in

**The third is the landing's witness and this walk needs one.** Both panes here
read `+0px` with their rows identical, which is also what a walk that missed the
landing entirely would print. The scrollbar is what cannot stay still: two
hundred messages arriving above the reader shorten the thumb in every pane on
the conversation, whether or not a row moves. A landing pair that reads `rows
still, pane differs` is a page that arrived and moved nobody; one that reads
`pane still` on all three pairs is a walk that photographed the wrong minute.
"""

import glob
import os
import re
import subprocess
import sys

DIR = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))
RUN23 = os.path.join(os.path.dirname(HERE), "end-to-end-23")
# The whole of a pane, which `paneshift.py`'s columns deliberately are not: the
# spine on one side of the message column and the scrollbar on the other are
# where a landing shows itself without anything moving.
PANES = {"left": "340x620+245+80", "right": "340x620+725+80"}

released = None
for line in open(os.path.join(DIR, "wire.log")):
    stamped = re.search(r"~~ released .* at (\d+\.\d+)", line)
    if stamped:
        released = float(stamped.group(1))
if released is None:
    sys.exit("nothing was released in this walk")

frames = sorted(glob.glob(os.path.join(DIR, "frame-*.png")))
before = [f for f in frames if os.path.getmtime(f) < released]
after = [f for f in frames if os.path.getmtime(f) > released]
if len(before) < 3 or len(after) < 3:
    sys.exit(
        f"the burst does not straddle the release: {len(before)} frames before it "
        f"and {len(after)} after"
    )

PAIRS = [
    ("still", before[-3], before[-2]),
    ("landing", before[-1], after[0]),
    ("after", after[1], after[2]),
]


def ran(script, *arguments):
    out = subprocess.run(["python3", script, *arguments], capture_output=True, text=True)
    return out.stdout.strip()


def identical(box, first, second):
    """`compare` exits 1 when the images differ, which is an answer rather than a
    failure, so the return code is read instead of checked."""
    out = subprocess.run(
        ["magick", "compare", "-metric", "AE", "-crop", box, first, second, "null:"],
        capture_output=True,
        text=True,
    )
    if out.returncode > 1:
        sys.exit(f"compare failed: {out.stderr.strip()}")
    return float(out.stderr.strip().split()[0]) == 0


for pane in ("left", "right"):
    for name, first, second in PAIRS:
        distance = ran(os.path.join(HERE, "paneshift.py"), pane, first, second)
        rows = ran(os.path.join(RUN23, "still.py"), pane, first, second)
        whole = "pane still" if identical(PANES[pane], first, second) else "pane differs"
        print(f"    {pane:>5} {name:<9} {distance:<48} rows {rows}, {whole}")

print(
    f"    (the landing is between {os.path.basename(before[-1])} and "
    f"{os.path.basename(after[0])}, {os.path.getmtime(after[0]) - released:.1f}s of slack)"
)
