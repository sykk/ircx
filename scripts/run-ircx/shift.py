"""Vertical offset between two screenshots of the timeline, in pixels.

    python3 shift.py before.png after.png

Takes a band of rows out of the second image and slides it over the first,
scoring by absolute difference. The answer is where the content now at y in the
second image sat in the first, so 0 means nothing moved and the residual says
how well it matched — a residual near zero with a nonzero shift is the pane
having moved rather than redrawn.

`md5sum` answers "did anything change at all" for nothing, and a still pane is
byte-identical. Reach for this only on the pairs that differ.
"""

import array
import subprocess
import sys

# The window window.mjs opens, and the timeline inside it.
WIDTH = 1200
X0, X1, Y0, Y1 = 262, 1060, 80, 700

BAND = 80
"""Rows of the second image to match. Tall enough to hold a message and its
name, so a band of blank pane cannot match anywhere it likes."""

STRIDE = 3
"""Every third pixel across. Text at this size leaves no run of three that is
all background, and the whole-band score settles at the same offset either way."""


def rows(path):
    grey = subprocess.run(
        ["magick", path, "-colorspace", "Gray", "-depth", "8", "gray:-"],
        capture_output=True,
        check=True,
    ).stdout
    pixels = array.array("B", grey)
    return [pixels[y * WIDTH + X0 : y * WIDTH + X1] for y in range(Y0, Y1)]


before, after = rows(sys.argv[1]), rows(sys.argv[2])
band_top = (Y1 - Y0) // 2 - BAND // 2
band = after[band_top : band_top + BAND]

best_score, best_shift = None, None
for shift in range(-300, 301):
    top = band_top + shift
    if top < 0 or top + BAND > len(before):
        continue
    total = sum(
        abs(before[top + i][j] - band[i][j])
        for i in range(BAND)
        for j in range(0, len(band[i]), STRIDE)
    )
    score = total / (BAND * len(band[0]) / STRIDE)
    if best_score is None or score < best_score:
        best_score, best_shift = score, shift

name = lambda path: path.rsplit("/", 1)[-1]
print(f"{name(sys.argv[1])} -> {name(sys.argv[2])}: shift {best_shift:+d}px (residual {best_score:.2f})")
