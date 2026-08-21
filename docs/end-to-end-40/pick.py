"""The frames either side of the landing, and what each pane did across them.

    pick.py <walk directory>

`parked.sh` photographs every two seconds across a window wide enough to hold
the release however the wheel burst went, and this chooses the pair afterwards.

**Chosen by the change rather than by the clock, which is where run 30's
`pick.py` is departed from.** That script took the last frame written before the
epoch `latepage.py` stamps on the release and the first written after it. The
release is when the batch went on the wire, and what a frame can show is the
page being drawn — two hundred rows later. A pair straddling the wire by a tenth
of a second is a pair taken before the client has finished with it: one walk here
read `pane still` on every pane and every pair, which is a landing photographed
twice from in front.

So the release is what says the page is on its way, and the first frame that
differs from the one before it — at or after that instant — is what says it
arrived. Nothing else changes this window: the seeders stop talking once the
channel is filled, so a pane that differs is a pane the page reached.

Three pairs, and the first and last are what make the middle one mean anything:

    still    two frames before the landing, neither of which contains it
    landing  the pair the change falls between
    after    two frames past it, once the page is in

Three readings per pair, because a pane that did not move is not the same claim
as a pane that did not change:

    the distance   `paneshift.py`, over the message column
    rows           that same column, pixel for pixel
    pane           the whole pane, spine and scrollbar in

**The third is what a landing shows itself in when it moves nobody.** Two hundred
messages arriving above the reader shorten the scrollbar's thumb in every pane on
the conversation, and a topic declared on the page's last line re-opens a group
that runs forward into rows already drawn, which changes the spine beside every
one of them. Neither is a displacement. Both are outside the column the distance
is measured over, and inside this.
"""

import glob
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from paneshift import COLUMNS, measure, same  # noqa: E402

DIR = sys.argv[1]
# The whole of a pane, which the message column deliberately is not.
PANES = {"left": "340x620+245+80", "right": "340x620+725+80"}
Y0, HEIGHT = 80, 620

released = None
release_at = None
asks = []
# Every release, because this walk holds two pages: the one a freshly split pane
# asks for on its own, and the one the walk asks for. The last of them is the
# landing being read, and the first is over long before the parking.
for line in open(os.path.join(DIR, "wire.log")):
    stamped = re.search(r"^\s*([\d.]+) ~~ released .* at (\d+\.\d+)", line)
    if stamped:
        release_at, released = float(stamped.group(1)), float(stamped.group(2))
    ask = re.search(r"^\s*([\d.]+) >> .*CHATHISTORY BEFORE", line)
    if ask:
        asks.append(float(ask.group(1)))
if released is None:
    sys.exit("nothing was released in this walk")

frames = sorted(glob.glob(os.path.join(DIR, "frame-*.png")))

# **Which pane asked is read rather than assumed, and a walk got it wrong before
# this line existed.** The parking is bracketed by two frames — `at-live.png`
# before the wheel and `parked.png` after it — and an ask stamped between them
# came out of the right pane, which happens when the parking overshoots to
# within `LOAD_OLDER_PX` of the top of its content, 400px in `Timeline.tsx`. The
# pane is then the asker and there is no parked pane in the walk at all.
#
# Bracketed rather than "before `parked.png`", which is run 31's rule and cannot
# be this walk's: the split makes an ask of its own here, twenty seconds before
# anything is parked, and every walk would read as an overshoot.
#
# The proxy stamps its log in seconds since it started and the release line
# carries a wall clock as well, which is what puts the two on one timeline.
before = os.path.getmtime(os.path.join(DIR, "at-live.png"))
parking = os.path.getmtime(os.path.join(DIR, "parked.png"))
who = "the left pane asked"
if any(before <= released - release_at + at <= parking for at in asks):
    who = "THE RIGHT PANE ASKED, while parking: this walk has no parked pane"


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
