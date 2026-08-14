"""How many pages the walking pane fetched, per run, per arm.

    pages.py <output directory> <runs>

The table `tally.py` prints counts landings, and a landing is a page arriving.
So the two arms are only comparable if the walk fetched the same number of
pages in each — three notches of wheel are a fixed input, but how many pages
they draw out of the server is the client's answer to it, and both fixes touch
what a pane believes it is owed.

`BEFORE` in the second session of a tap log is the count: the first session is
the launch that seeds the profile, and `TARGETS` and `AFTER` are the startup
gap-fill rather than a page-back.
"""

import re
import sys
from collections import Counter

BEFORE = re.compile(r"CHATHISTORY BEFORE ")

OUT, RUNS = sys.argv[1], int(sys.argv[2])


def pages(path):
    session = 0
    counted = 0
    for line in open(path):
        if "session opened" in line:
            session += 1
        elif session == 2 and len(line) > 11 and line[9] == ">" and BEFORE.search(line):
            counted += 1
    return counted


for arm in ("control", "fixed"):
    spread = Counter()
    missing = 0
    for run in range(1, RUNS + 1):
        try:
            spread[pages(f"{OUT}/{arm}/run{run}/wire.log")] += 1
        except FileNotFoundError:
            missing += 1
    total = sum(count * pages for pages, count in spread.items())
    shape = ", ".join(f"{count} runs asked {pages}" for pages, count in sorted(spread.items()))
    print(f"{arm:>8}: {total} pages over {sum(spread.values())} runs — {shape}")
    if missing:
        print(f"{'':>8}  {missing} runs left no wire log")
