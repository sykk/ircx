"""What one walk asked, when the held answer was let go, and whether it asked again.

    read.py <walk directory>

The reading is on the wire rather than in a frame, and that is the whole reason
this run can say anything. #540 ends a conversation's history behind a message
the server was never asked about, and what "ended" means is that no page-back
ever goes out again — a claim about a request that is absent, which no
photograph of a pane can make. The proxy's own log has every ask on it.

Four lines out:

    asks      how many page-backs went out, and how far apart the first two are.
              Under sixty seconds means the client had not given up when the
              second went, which is a walk of something else.
    release   when the first ask's answer was let go, and how long after the
              third ask that was. The third's own answer has to have landed
              inside that gap, which on a local socket is milliseconds.
    again     whether an ask went out after the release. This is the reading.
    frames    the pair either side of the release, for a look at the pane.

A walk without three asks before the release is refused rather than read. The
sequence is what the run measures, and a walk that took a different one is not
evidence about it either way.
"""

import glob
import os
import re
import sys

DIR = sys.argv[1]

asks = {}
released = None
lines = 0
base = None
for line in open(os.path.join(DIR, "wire.log")):
    offset = float(line[:9])
    out = re.search(r"\*\* ask (\d+) out under label", line)
    if out:
        asks[int(out.group(1))] = offset
    let_go = re.search(r"~~ released ask 1, (\d+) lines, at (\d+\.\d+)", line)
    if let_go:
        released, lines = offset, int(let_go.group(1))
        base = float(let_go.group(2)) - offset

before_release = [at for at in asks.values() if released is not None and at < released]
if released is None or len(before_release) < 3:
    print(
        f"    refused   {len(asks)} asks and {0 if released is None else 1} releases: "
        "this walk did not take the sequence"
    )
    sys.exit(1)

gap = asks[2] - asks[1]
print(
    f"    asks      {len(asks)} out, the second {gap:.0f}s after the first"
    f"{' — inside the timeout, so nothing was given up on' if gap < 60 else ''}"
)
print(
    f"    release   ask 1 let go at {released:.0f}s, {lines} lines, "
    f"{released - asks[3]:.0f}s after the third ask"
)

after = sorted(at for at in asks.values() if at > released)
print(
    f"    again     yes, {after[0] - released:.0f}s after the answer landed"
    if after
    else "    again     no: nothing was asked after the answer landed"
)

# The frames are the illustration rather than the reading, and they are chosen
# the way run 30 chooses them: against the epoch the proxy stamps on the release
# itself, because a walk cannot time a frame from the wheel that provoked it.
frames = sorted(glob.glob(os.path.join(DIR, "frame-*.png")))
at = base + released
straddling = [f for f in frames if os.path.getmtime(f) < at], [
    f for f in frames if os.path.getmtime(f) > at
]
print(
    f"    frames    the answer landed between {os.path.basename(straddling[0][-1])} "
    f"and {os.path.basename(straddling[1][0])}"
    if all(straddling)
    else "    frames    the answer landed outside the burst"
)
