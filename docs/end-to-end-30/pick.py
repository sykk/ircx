"""The frames either side of the release, and what the pane did across them.

    pick.py <walk directory>

`straddle.sh` takes a frame every two seconds without knowing which of them the
page will land between. This chooses, against the epoch `latepage.py` stamps on
the release: the last frame written before it and the first written after.

Prints three distances, and the first two are what make the third mean anything:

    still    two frames before the landing, neither of which contains it
    landing  the pair the release falls between
    after    two frames past it, once the page is in

A pane that drifts on its own would show it in the first line, and a pane still
settling would show it in the third. The claim this run makes is about the
middle one, and it is only a claim if the other two are zero.

The release is read out of `wire.log` rather than out of the probe, so the same
reading works on a build with no probe in it — which is the build the frames
have to come from.
"""

import glob
import os
import re
import subprocess
import sys

DIR = sys.argv[1]
HERE = os.path.dirname(os.path.abspath(__file__))

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


def shift(first, second):
    out = subprocess.run(
        ["python3", os.path.join(HERE, "shift.py"), first, second],
        capture_output=True,
        text=True,
    )
    return out.stdout.strip()


print(f"    still     {shift(before[-3], before[-2])}")
print(f"    landing   {shift(before[-1], after[0])}")
print(f"    after     {shift(after[1], after[2])}")
print(
    f"    (the landing is between {os.path.basename(before[-1])} and "
    f"{os.path.basename(after[0])}, {os.path.getmtime(after[0]) - released:.1f}s of slack)"
)
