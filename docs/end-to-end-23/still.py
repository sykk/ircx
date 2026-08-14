"""Whether one pane is pixel-for-pixel what it was, over the columns it owns.

    still.py <left|right> before.png after.png

Prints `still` or `differs`.

**Zero or not zero is the whole of what `AE` is read for here.** The name says
absolute error count and the number does not behave like one — 1200x800 of this
app's own frames scores 5.5e8, which is 569 per pixel — so the magnitude is
uninterpretable and reporting it as pixels would be inventing a figure. It is
zero for identical images, which is the question.

This is the guard `paneshift.py` needs and cannot be. It slides an 80px band and
takes the best-scoring offset, so it always answers with an offset — and over a
channel that repeats itself every couple of rows, a pane that did not move can
tie with an offset two rows away and lose the tie. #510's control caught it
reporting **-202px at residual 0.00** on two landings where the pane was
byte-for-byte identical, and a residual of zero is exactly what a real
translation looks like.

So stillness is decided here, and `paneshift.py` is asked only to name the size
of a difference already known to exist. Run 23's channel repeats itself less
than run 22's did — three speakers, topics, addresses — which lowers the odds of
that tie without removing it.

The columns are `paneshift.py`'s own, so both are answering about one pane.
"""

import subprocess
import sys

# Kept in step with paneshift.py: one pane's message column, clear of the
# divider and of the roster.
COLUMNS = {"left": (262, 570), "right": (740, 1050)}
Y0, Y1 = 80, 700

WHICH = sys.argv[1]
BEFORE, AFTER = sys.argv[2], sys.argv[3]
X0, X1 = COLUMNS[WHICH]
CROP = f"{X1 - X0}x{Y1 - Y0}+{X0}+{Y0}"

# `compare` exits 1 when the images differ, which is an answer rather than a
# failure, so the return code is read instead of checked.
result = subprocess.run(
    ["magick", "compare", "-metric", "AE", "-crop", CROP, BEFORE, AFTER, "null:"],
    capture_output=True,
    text=True,
)
if result.returncode > 1:
    sys.exit(f"compare failed: {result.stderr.strip()}")

score = result.stderr.strip().split()[0]
print("still" if float(score) == 0 else "differs")
