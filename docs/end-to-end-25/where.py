"""Where in the parked pane a landing that measured 0px differs.

    where.py <output directory> <runs>

`measure.sh` splits a landing three ways and its comment reads the middle one —
differing, measuring 0px — as the head that says a page is loading being drawn
in a pane that asked for nothing. That was #475, and #516 was supposed to end
it.

It did not end the row, so the row has a second cause, and the two are told
apart by which column moves. The head is a row of the scroller and spans the
message column. The spine is the six pixels at the pane's left edge, and run
23's seed was built so that a page landing above the window regroups it: a
mounted row gains or loses the topic that names its group, and the spine beside
it appears, goes, or changes hue without anything moving. That is #512's
property, it is what the channel was seeded for, and it is the same in any
build.

So: the spine band alone, against the message column beside it.
"""

import subprocess
import sys

# still.py's crop, split at the spine. The pane's message block starts at 740
# and the spine is the rule down its left edge.
SPINE = (740, 748)
TEXT = (748, 1050)
Y0, Y1 = 80, 700

OUT, RUNS = sys.argv[1], int(sys.argv[2])


def differs(before, after, band):
    x0, x1 = band
    result = subprocess.run(
        [
            "magick", "compare", "-metric", "AE",
            "-crop", f"{x1 - x0}x{Y1 - Y0}+{x0}+{Y0}",
            before, after, "null:",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode > 1:
        sys.exit(f"compare failed: {result.stderr.strip()}")
    return float(result.stderr.strip().split()[0]) > 0


for arm in ("control", "fixed"):
    spine_only = both = text_only = 0
    for run in range(1, RUNS + 1):
        for first, second in (("a-parked", "b-one-page"), ("b-one-page", "c-two-pages")):
            before = f"{OUT}/{arm}/run{run}/{first}.png"
            after = f"{OUT}/{arm}/run{run}/{second}.png"
            try:
                in_spine = differs(before, after, SPINE)
                in_text = differs(before, after, TEXT)
            except FileNotFoundError:
                continue
            if in_spine and in_text:
                both += 1
            elif in_spine:
                spine_only += 1
            elif in_text:
                text_only += 1
    print(f"{arm:>8}: {spine_only} spine only, {text_only} message column only, {both} both")
