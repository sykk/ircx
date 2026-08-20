"""The frames either side of the landing, and what each pane did across them.

    pick.py <walk directory>

Run 31's, with the pane that parks and the pane that asks made the same one.

Everything below the docstring is that script except for the sentence it prints
when the parking itself asked, and the reason is the arrangement: run 31 parked
the right pane and paged the left, so an ask ahead of `parked.png` came out of
the pane that was supposed to be sitting still. Here the left pane does both —
it is parked in the archive and then walked to the top of it — and the right pane
is at the live edge with nothing done to it at all. An ask ahead of `parked.png`
is then the parking wheel having gone far enough to reach the top, which leaves
the hold running against a burst that has not happened yet.

**The live lines of the `both` arm are not the landing**, and nothing was added
to keep them out: frames written before the release are skipped already, and the
plan says them inside the first seconds of a forty-second hold.
"""

import glob
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "end-to-end-31"))
from paneshift import COLUMNS, measure, same  # noqa: E402

DIR = sys.argv[1]
# The whole of a pane, which the message column deliberately is not.
PANES = {"left": "340x620+245+80", "right": "340x620+725+80"}
Y0, HEIGHT = 80, 620

released = None
release_at = None
asked = None
for line in open(os.path.join(DIR, "wire.log")):
    stamped = re.search(r"^\s*([\d.]+) ~~ released .* at (\d+\.\d+)", line)
    if stamped:
        release_at, released = float(stamped.group(1)), float(stamped.group(2))
    ask = re.search(r"^\s*([\d.]+) >> .*CHATHISTORY BEFORE", line)
    if ask and asked is None:
        asked = float(ask.group(1))
if released is None:
    sys.exit("nothing was released in this walk")

frames = sorted(glob.glob(os.path.join(DIR, "frame-*.png")))

# **Whether the parking wheel asked is read rather than assumed, and a walk got
# it wrong before this line existed in run 31.** `parked.png` is taken after the
# parking wheel and before the one that pages, so an ask stamped ahead of it came
# out of the parking — which happens when it overshoots to within `LOAD_OLDER_PX`
# of the top of its content, 400px in `Timeline.tsx`. The hold is then running
# against a page the paging burst has not asked for. The proxy stamps its log in
# seconds since it started and the release line carries a wall clock as well,
# which is what puts the two on one timeline.
parking = os.path.getmtime(os.path.join(DIR, "parked.png"))
who = "the paging burst asked"
if asked is not None and released - release_at + asked < parking:
    who = "THE PARKING ASKED: this walk paged before it was parked"


def unchanged(first, second):
    return all(same(box, first, second) for box in PANES.values())


landing = None
for index in range(1, len(frames)):
    if os.path.getmtime(frames[index]) < released:
        continue
    if not unchanged(frames[index - 1], frames[index]):
        landing = index
        break

if landing is None:
    sys.exit(f"no frame after the release differs from the one before it, of {len(frames)}")
if landing < 3 or landing + 2 >= len(frames):
    sys.exit(f"the landing is at frame {landing} of {len(frames)}, too near an end to read")

PAIRS = [
    ("still", frames[landing - 3], frames[landing - 2]),
    ("landing", frames[landing - 1], frames[landing]),
    ("after", frames[landing + 1], frames[landing + 2]),
]

for pane in ("left", "right"):
    x0, width = COLUMNS[pane]
    column = f"{width}x{HEIGHT}+{x0}+{Y0}"
    for name, first, second in PAIRS:
        rows = "rows still" if same(column, first, second) else "rows differ"
        whole = "pane still" if same(PANES[pane], first, second) else "pane differs"
        print(f"    {pane:>5} {name:<9} {measure(pane, first, second):<44} {rows}, {whole}")

print(
    f"    ({who}; the landing is {os.path.basename(frames[landing])}, "
    f"{os.path.getmtime(frames[landing]) - released:.1f}s after the release, "
    # How long the wheel burst went on after the ask, which is what decides
    # where the window has to start and is different every walk. `frame-000` is
    # taken a second and a half after the burst ends, so this is the release
    # measured from there: the shorter it is, the earlier in its burst the pane
    # asked.
    f"{released - os.path.getmtime(frames[0]):.0f}s after the burst)"
)
