"""What each pane did between two frames.

    reading.py <before.png> <after.png>

Run 31's `pick.py` reduced to the pair it is handed, because the provocation
this reads is one the walk controls. A page-back lands whenever the server lets
it and has to be found among frames afterwards; a line said by a second client
lands within a second of `say` returning, and the two frames either side of it
are the two the plan took.

The three readings are `pick.py`'s and mean what they mean there: the distance
over the message column, whether that column is pixel for pixel the same, and
whether the whole pane is. A pane at the live edge is expected to fail the last
two — a line arriving is a row drawn — and what says it followed the tail is the
frame, not this.
"""

import os
import sys

# Run 31's measurement, imported rather than copied: the strips, the columns and
# the majority it takes them on are that script's argument, and a second copy of
# it is a second thing to keep true.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "end-to-end-31"))
from paneshift import COLUMNS, measure, same  # noqa: E402

PANES = {"left": "340x620+245+80", "right": "340x620+725+80"}
Y0, HEIGHT = 80, 620

first, second = sys.argv[1], sys.argv[2]
for pane in ("left", "right"):
    x0, width = COLUMNS[pane]
    column = f"{width}x{HEIGHT}+{x0}+{Y0}"
    rows = "rows still" if same(column, first, second) else "rows differ"
    whole = "pane still" if same(PANES[pane], first, second) else "pane differs"
    print(f"    {pane:>5} {measure(pane, first, second):<44} {rows}, {whole}")
