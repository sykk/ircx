"""What one pane's head did between two frames, apart from what its rows did.

    head.py <left|right> before.png after.png

Prints two words: what the head line did, then what the messages under it did.
Either is `still` or `differs`.

The two bands are asked separately for run 25's reason. A landing page can
change a row without moving one — the spine arriving, a topic's name leaving —
so a difference anywhere in a pane says nothing about where it is. Here the
question is narrower than that: whether the sentence at the top of a pane
answered a request the pane beside it made, which is a difference in the head
band and stillness everywhere below it.

The columns are `docs/end-to-end-23/still.py`'s, so a pane means the same thing
in both. The head's own band is the strip between the channel header and the
first row: `Timeline.tsx` draws it `px-4 py-1 text-[11px]`, and it is the first
thing in the scroller, so it is there or the rows start where it would have
been.
"""

import subprocess
import sys

COLUMNS = {"left": (262, 570), "right": (740, 1050)}
HEAD = (86, 112)
ROWS = (120, 700)

WHICH = sys.argv[1]
BEFORE, AFTER = sys.argv[2], sys.argv[3]
X0, X1 = COLUMNS[WHICH]


def compare(y0, y1):
    """`AE` is read for zero or not zero, which is `still.py`'s finding: the
    count itself does not behave like a pixel count and is not reported."""
    result = subprocess.run(
        [
            "magick", "compare", "-metric", "AE",
            "-crop", f"{X1 - X0}x{y1 - y0}+{X0}+{y0}",
            BEFORE, AFTER, "null:",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode > 1:
        sys.exit(f"compare failed: {result.stderr.strip()}")
    return "still" if float(result.stderr.strip().split()[0]) == 0 else "differs"


print(compare(*HEAD), compare(*ROWS))
