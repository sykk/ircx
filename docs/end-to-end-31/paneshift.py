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

**The columns start clear of the spine, and a probe walk is why.** The page this
run lands declares a topic on its last line, which opens a group that reaches
forward into the rows already on the screen: every one of them gains a
continuous coloured spine where each had a grey stub of its own. Nothing moves —
the text is drawn at the same heights either side of it — but a strip that
includes those four pixels is a strip that cannot be found afterwards, and the
first walk to park a pane where the regrouping reaches it lost all fourteen. The
change is real and `pick.py` reports it; what it must not do is take away the
marks the distance is measured against.
"""

import re
import subprocess
import sys
import tempfile
from collections import Counter

# One pane's message column: the spine on the left of it and the scrollbar on
# the right of it are both outside.
COLUMNS = {"left": (266, 300), "right": (750, 300)}
# Tall enough to cross a row's second line, which is where the number is. A
# strip inside one line catches a nick and a clock the seed repeats, and half of
# them then match somewhere they did not come from.
#
# Run 30's 26 was two lines of this seed's prose and left six strips of fourteen
# locked somewhere they did not come from, on frames that were pixel for pixel
# identical: a strip has to be found *somewhere*, and a tie between rows is
# broken by whichever comes first. 52 crosses a row boundary as well, so the
# nick and the number of the row below are in it — 12 of 14 agreeing on the same
# frames, against 8.
STRIP_PX = 52
FROM_Y, TO_Y, EVERY = 240, 660, 30


def crop(path, box):
    out = subprocess.run(
        ["magick", path, "-crop", box, "+repage", "png:-"], capture_output=True, check=True
    )
    return out.stdout


def same(box, first, second):
    """Whether two frames are pixel for pixel the same over a region.

    Cropping both and comparing the bytes does not answer this: ImageMagick
    writes a PNG that differs between two crops of frames `compare` scores at
    zero. `compare` exits 1 when the images differ, which is an answer rather
    than a failure, so the return code is read instead of checked.
    """
    out = subprocess.run(
        ["magick", "compare", "-metric", "AE", "-crop", box, first, second, "null:"],
        capture_output=True,
        text=True,
    )
    if out.returncode > 1:
        sys.exit(f"compare failed: {out.stderr.strip()}")
    return float(out.stderr.strip().split()[0]) == 0


def find(haystack, needle):
    """`compare -subimage-search` prints `<metric> (<normalised>) @ <x>,<y>`."""
    result = subprocess.run(
        ["magick", "compare", "-subimage-search", "-metric", "AE", haystack, "-", "null:"],
        input=needle,
        capture_output=True,
    )
    text = (result.stderr or b"").decode() + (result.stdout or b"").decode()
    found = re.search(r"^(\d+(?:\.\d+)?)\D.*@ (\d+),(\d+)", text.strip())
    if not found:
        return None
    metric, _, y = found.groups()
    return None if float(metric) != 0 else int(y)


def measure(which, before, after):
    x0, width = COLUMNS[which]
    with tempfile.NamedTemporaryFile(suffix=".png") as haystack:
        haystack.write(crop(after, f"{width}x0+{x0}+0"))
        haystack.flush()
        offsets = []
        missing = 0
        for y in range(FROM_Y, TO_Y, EVERY):
            landed = find(haystack.name, crop(before, f"{width}x{STRIP_PX}+{x0}+{y}"))
            if landed is None:
                missing += 1
            else:
                offsets.append(landed - y)

    if not offsets:
        return f"no strip of {missing} was found in the second frame, pixel for pixel"

    agreed, count = Counter(offsets).most_common(1)[0]
    spread = max(offsets) - min(offsets)
    evidence = f"{count} of {len(offsets)} agree, spread {spread}px, {missing} redrawn"
    # A mode that is not a majority is a mislock with company rather than a
    # measurement, and saying so is the whole of what run 25 asks of this.
    if count * 2 <= len(offsets):
        return f"the strips do not agree on a distance ({evidence})"
    return f"{agreed:+d}px  ({evidence})"


if __name__ == "__main__":
    print(measure(sys.argv[1], sys.argv[2], sys.argv[3]))
