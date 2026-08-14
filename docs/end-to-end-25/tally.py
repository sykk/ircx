"""The three states a parked pane is in, counted over two arms.

    tally.py control-shifts.txt fixed-shifts.txt <output directory>

`measure.sh` writes one line per landing and answers in two steps: `still.py`
first, and only a pane already known to have changed is handed to
`paneshift.py`. So a landing is in exactly one of three states:

  - pixel-identical, which is the parked pane doing nothing at all;
  - differing without moving, which run 23 photographed and named — the group's
    spine and the topic over a run, changing where the landing page regrouped
    the window;
  - moved, which is #508.

**The third state is not `paneshift.py` answering nonzero**, and run 25 is where
that cost something. It slides an 80px band over a channel that repeats itself
and takes the best offset, so it can lock onto a wrong one and report it with a
residual of zero — `still.py`'s docstring records −202px at residual 0.00 from
#510's control, and this run drew the same −202px again, on a landing whose
message column was byte-for-byte identical. Counting it would have made the
control 5 moves rather than 4.

So a move is read off the message column instead. A pane that translated draws
different text at every row; a pane that regrouped draws the same text with a
spine or a topic changed beside it, and a pane whose column is identical did
not move whatever offset was named for it. `paneshift.py` is still what says how
far, and it is asked only about landings this has already called moves.

The p-values are Fisher's exact, two-sided, computed here rather than taken from
scipy — the sum over tables at most as probable as the observed one is six lines
and the walk already needs python3.
"""

import math
import re
import subprocess
import sys

LANDING = re.compile(r"^(run\d+) (\S+)->(\S+)\b")
# still.py's crop, less the spine at the pane's left edge: what a translation
# has to disturb and a regrouping need not.
TEXT = (748, 1050)
Y0, Y1 = 80, 700


def translated(directory, before, after):
    x0, x1 = TEXT
    result = subprocess.run(
        [
            "magick", "compare", "-metric", "AE",
            "-crop", f"{x1 - x0}x{Y1 - Y0}+{x0}+{Y0}",
            f"{directory}/{before}.png", f"{directory}/{after}.png", "null:",
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode > 1:
        sys.exit(f"compare failed: {result.stderr.strip()}")
    score = float(result.stderr.strip().split()[0])
    # A translation of this pane scores around 5e8 and a topic label arriving
    # scores 2.9e5, so the gap is three orders of magnitude rather than a
    # threshold anybody has to choose. Both ends are checked in run 25's report.
    return score > 1e7


def states(path, arm):
    identical = regrouped = moved = 0
    for line in open(path):
        if not line.strip():
            continue
        found = LANDING.match(line)
        if not found:
            sys.exit(f"{path}: cannot read a landing from {line.rstrip()!r}")
        if "differs" not in line:
            identical += 1
        elif translated(f"{arm}/{found.group(1)}", found.group(2), found.group(3)):
            moved += 1
        else:
            regrouped += 1
    return identical, regrouped, moved


def fisher(a, b, c, d):
    """Two-sided, over the 2x2 [[a, b], [c, d]]."""
    rows, cols, n = (a + b, c + d), (a + c, b + d), a + b + c + d

    def probability(x):
        return (
            math.comb(rows[0], x)
            * math.comb(rows[1], cols[0] - x)
            / math.comb(n, cols[0])
        )

    observed = probability(a)
    low, high = max(0, cols[0] - rows[1]), min(rows[0], cols[0])
    # 1e-9 rather than <=: two arrangements of one table can differ in the last
    # bit of a float and drop half the tail.
    return sum(p for x in range(low, high + 1) if (p := probability(x)) <= observed * (1 + 1e-9))


OUT = sys.argv[3]
control = states(sys.argv[1], f"{OUT}/control")
fixed = states(sys.argv[2], f"{OUT}/fixed")
landings = (sum(control), sum(fixed))

print(f"{'the parked pane':<28}{'control':>10}{'with the fixes':>16}")
for name, at in (("pixel-identical", 0), ("differed, did not move", 1), ("moved", 2)):
    print(f"{name:<28}{control[at]:>10}{fixed[at]:>16}")
print(f"{'landings':<28}{landings[0]:>10}{landings[1]:>16}")
print()
for name, at in (("moved", 2), ("not pixel-identical", None)):
    if at is None:
        hit = (landings[0] - control[0], landings[1] - fixed[0])
    else:
        hit = (control[at], fixed[at])
    p = fisher(hit[0], landings[0] - hit[0], hit[1], landings[1] - hit[1])
    print(f"{name}: {hit[0]}/{landings[0]} against {hit[1]}/{landings[1]}, Fisher p = {p:.3f}")
