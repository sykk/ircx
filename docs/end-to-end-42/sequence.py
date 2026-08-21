"""The messages a pane actually painted, top to bottom, and whether they follow.

    sequence.py <frame.png> [left|right]

Reads the stripes `VITE_SWATCH=1` paints — `rgb(n >> 8, n & 255, 128)` down the
left of every message — so a screenshot names the messages the engine drew
rather than the ones the DOM has. The seed sends `line 0001` to `line 1009` in
order and nothing in this walk reorders them, so **a pane painted right reads as
a run of consecutive numbers**. #602 is a step: 0601 to 0611 with nothing
between, or a stretch out of order.

The column is found rather than given: a stripe is the only thing in the window
whose blue channel is exactly 128.
"""

import sys
from collections import Counter

from PIL import Image

path = sys.argv[1]
side = sys.argv[2] if len(sys.argv) > 2 else "left"
image = Image.open(path).convert("RGB")
pixels = image.load()
# The panes of a split window at 1200x800, from `paneshift.py`'s columns.
FROM_X, TO_X = (245, 720) if side == "left" else (725, 1200)
TOP, BOTTOM = 80, 706


def stripe(x, y):
    r, g, b = pixels[x, y]
    return r * 256 + g if b == 128 else None


columns = Counter()
for x in range(FROM_X, TO_X):
    for y in range(TOP, BOTTOM, 4):
        if stripe(x, y) is not None:
            columns[x] += 1
if not columns:
    sys.exit("no stripes in this pane — was the build made with VITE_SWATCH=1?")
at = columns.most_common(1)[0][0]

drawn = []
for y in range(TOP, BOTTOM):
    found = stripe(at, y)
    if found is not None and (not drawn or drawn[-1][0] != found):
        drawn.append((found, y))

print(f"stripes at x={at}, {len(drawn)} messages painted")
steps = []
for (message, y), (before, _) in zip(drawn[1:], drawn):
    if message != before + 1:
        steps.append((before, message, y))
for before, message, y in steps:
    print(f"y {y}: {before} is followed by {message}")
print(
    f"{drawn[0][0]}..{drawn[-1][0]} painted, {len(steps)} steps"
    if drawn
    else "nothing painted"
)
