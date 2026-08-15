"""How far one pane of a split moved under the reader.

    paneshift.py <left|right> <before.png> <after.png>

Run 30's `shift.py` with the message column chosen per pane instead of fixed at
the one pane a window then held. Everything else is that script's: strips cropped
at several heights in the "before" frame, each found again in the "after" one by
exact pixel match, and the answer taken from what a majority of them agree on.

**Not run 23's `paneshift.py`, which slid a band and scored it by difference.**
That always answers with an offset, and over a channel that repeats itself every
couple of rows it can tie with an offset two rows away and lose the tie —
`still.py`'s docstring records it reporting −202px at residual 0.00 on a pane
that was byte-for-byte identical. Strips that must match exactly cannot mislock
that way; they can only fail to be found, which is counted and printed.

Run 23's columns, because they are the columns that walk's frames were read over
and this walk draws the same two panes in the same 1200x800 window. What they
have to clear is the divider on one side and the pane's own roster on the other.
"""

import re
import subprocess
import sys
import tempfile
from collections import Counter

WHICH, BEFORE, AFTER = sys.argv[1], sys.argv[2], sys.argv[3]
COLUMNS = {"left": (262, 308), "right": (740, 310)}
# Tall enough to cross a row's second line, which is where the number is. A
# strip inside one line catches a nick and a clock the seed repeats, and half of
# them then match somewhere they did not come from.
STRIP_PX = 26
FROM_Y, TO_Y, EVERY = 240, 660, 30
X0, WIDTH = COLUMNS[WHICH]


def crop(path, y):
    out = subprocess.run(
        ["magick", path, "-crop", f"{WIDTH}x{STRIP_PX}+{X0}+{y}", "+repage", "png:-"],
        capture_output=True,
        check=True,
    )
    return out.stdout


def column(path):
    out = subprocess.run(
        ["magick", path, "-crop", f"{WIDTH}x0+{X0}+0", "+repage", "png:-"],
        capture_output=True,
        check=True,
    )
    return out.stdout


def find(needle):
    """`compare -subimage-search` prints `<metric> (<normalised>) @ <x>,<y>`."""
    result = subprocess.run(
        ["magick", "compare", "-subimage-search", "-metric", "AE", HAYSTACK.name, "-", "null:"],
        input=needle,
        capture_output=True,
    )
    text = (result.stderr or b"").decode() + (result.stdout or b"").decode()
    found = re.search(r"^(\d+(?:\.\d+)?)\D.*@ (\d+),(\d+)", text.strip())
    if not found:
        return None
    metric, _, y = found.groups()
    return None if float(metric) != 0 else int(y)


HAYSTACK = tempfile.NamedTemporaryFile(suffix=".png")
HAYSTACK.write(column(AFTER))
HAYSTACK.flush()

offsets = []
missing = 0
for y in range(FROM_Y, TO_Y, EVERY):
    landed = find(crop(BEFORE, y))
    if landed is None:
        missing += 1
    else:
        offsets.append(landed - y)

if not offsets:
    print(f"no strip of {missing} was found in the second frame, pixel for pixel")
    sys.exit()

agreed, count = Counter(offsets).most_common(1)[0]
spread = max(offsets) - min(offsets)
evidence = f"{count} of {len(offsets)} strips agree, spread {spread}px, {missing} redrawn"
if count * 2 <= len(offsets):
    print(f"the strips do not agree on a distance ({evidence})")
else:
    print(f"{agreed:+d}px  ({evidence})")
