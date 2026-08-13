"""Vertical offset between two screenshots, measured over one pane.

    paneshift.py <left|right> before.png after.png

`.claude/skills/run-ircx/shift.py` matches over x 262 to 1060, which is the
timeline of a window holding one pane. This walk splits the window, so that band
spans both panes and a shift measured over it is the two of them averaged. The
columns here are one pane's own: what is being asked is whether the pane nobody
scrolled moved while the other one paged.

Everything else is that script's — an 80-row band slid over the first image and
scored by absolute difference, every third pixel across.
"""

import array
import subprocess
import sys

WIDTH = 1200
# Inside each pane's message column, clear of the divider and of the roster.
COLUMNS = {"left": (262, 570), "right": (740, 1050)}
Y0, Y1 = 80, 700

BAND = 80
STRIDE = 3

WHICH = sys.argv[1]
X0, X1 = COLUMNS[WHICH]


def rows(path):
    grey = subprocess.run(
        ["magick", path, "-colorspace", "Gray", "-depth", "8", "gray:-"],
        capture_output=True,
        check=True,
    ).stdout
    pixels = array.array("B", grey)
    return [pixels[y * WIDTH + X0 : y * WIDTH + X1] for y in range(Y0, Y1)]


before, after = rows(sys.argv[2]), rows(sys.argv[3])
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

name = sys.argv[2].rsplit("/", 1)[-1] + " -> " + sys.argv[3].rsplit("/", 1)[-1]
print(f"{WHICH:>5} pane  {name}: shift {best_shift:+d}px (residual {best_score:.2f})")
