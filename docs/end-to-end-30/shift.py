"""How far the pane moved under the reader when the page landed.

    shift.py <before.png> <after.png>

Crops a strip of the message column at several heights in the "before" frame and
finds each one again in the "after" one. Prints the offset the strips agree on,
down being positive, with the spread beside it.

**One strip is not enough, and run 25 is why.** `paneshift.py` reported a
confident −202px for a pane whose message column was byte-for-byte identical.
The seed writes `line NNNN the reader is somewhere above this line and should
stay there` on most of its lines and stamps them all in the same minute, so a
strip that catches a nick and a clock — or prose without its number — matches a
hundred rows equally well. A strip that catches a number matches in one place or
nowhere, and the number is only in the first line of a row, which a fixed height
cannot be relied on to land in.

So the answer is taken from agreement rather than from a lucky crop. Strips that
are not found, pixel for pixel, are dropped and counted: run 23's channel is
seeded so that a landing page changes what some rows draw — a group's name
arriving, a spine — and a row that changed is no longer a mark this can measure
a distance against. What is left has to agree, and the spread says whether it
did.

`AE 0` throughout: an exact match or none.
"""

import re
import subprocess
import sys
import tempfile
from collections import Counter

BEFORE, AFTER = sys.argv[1], sys.argv[2]
# The message column of a single pane. The strips start below the head and the
# two separators, which are what the landing takes away.
COLUMN = (288, 300)
# Tall enough to cross a row's second line, which is where the number is. A
# strip inside one line catches a nick and a clock the seed repeats, and half of
# them then match somewhere they did not come from.
STRIP_PX = 26
FROM_Y, TO_Y, EVERY = 240, 660, 30


def crop(path, y):
    out = subprocess.run(
        ["magick", path, "-crop", f"{COLUMN[1]}x{STRIP_PX}+{COLUMN[0]}+{y}", "+repage", "png:-"],
        capture_output=True,
        check=True,
    )
    return out.stdout


def column(path):
    """The haystack is the message column and the whole height of it. Searching
    the window instead costs a minute a frame and can only find the strip
    somewhere it did not come from."""
    out = subprocess.run(
        ["magick", path, "-crop", f"{COLUMN[1]}x0+{COLUMN[0]}+0", "+repage", "png:-"],
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
# A mode that is not a majority is a mislock with company rather than a
# measurement, and saying so is the whole of what run 25 asks of this.
if count * 2 <= len(offsets):
    print(f"the strips do not agree on a distance ({evidence})")
else:
    print(f"{agreed:+d}px  ({evidence})")
