"""What the engine painted, against what the DOM says is there.

    screen.py <png> <file holding lab.column()'s answer> [zoom]

Every message carries a swatch in a colour that names it — `rgb(n >> 8, n & 255,
128)`, painted by `lab.paint()`. The DOM says which message covers which band of
the pane; the screenshot says which one the engine drew there. #602 is the two
disagreeing, and this prints every band they disagree over.

A `y` from the page is CSS pixels and a screenshot is device pixels, so the zoom
the view runs at is how one becomes the other.

Five samples down a band rather than one. A message's swatch can be crossed by
anything the pane draws over it — the jump-to-latest chip, a divider, the
scrollbar — and one sample landing on that reads as a message painted nowhere,
which is the defect's own signature and would be a false one.
"""

import json
import sys
from collections import Counter

from PIL import Image

png, column = sys.argv[1], sys.argv[2]
zoom = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
image = Image.open(png).convert("RGB")
pixels = image.load()
rows = json.loads(open(column).read())


def decoded(pixel):
    r, g, b = pixel
    return r * 256 + g if b == 128 else None


def painted(x, top, bottom):
    """The message the engine drew over that band, by majority of five."""
    seen = Counter()
    for i in range(1, 6):
        at_x = round(x * zoom)
        at_y = round((top + (bottom - top) * i / 6) * zoom)
        if at_y >= image.height or at_x >= image.width:
            continue
        found = decoded(pixels[at_x, at_y])
        if found is not None:
            seen[found] += 1
    return seen.most_common(1)[0][0] if seen else None


bad = []
for message, x, top, bottom in rows:
    drawn = painted(x, top, bottom)
    if drawn != message:
        bad.append((message, drawn, top, bottom))

for message, drawn, top, bottom in bad:
    print(f"y {top}..{bottom}: dom says {message}, painted {drawn}")
print(f"{len(bad)} of {len(rows)} messages are painted as something else")
