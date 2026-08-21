"""How far the reader moved across the landing, on one message.

    held.py <probe.log> [...]

The walk holds two pages — the one a freshly split pane asks for and the one it
is about — and the last of them is the landing being read.

For each pane: the reader's own message on the last commit before that landing,
and the same message on the last record that names it. `y` is where its line
lands against the top of the pane, so the difference is the displacement, and it
is a subtraction on one message rather than a distance between two pictures of
rows that are no longer the same rows.

`within` beside it is what says the walk was in the arrangement at all: the page
merges into the reader's own row, so their line ends up that much further into
it. A `within` that does not move is a page that landed somewhere else, and the
walk measured a reader nothing reached.

**The landing commit is skipped, and its own `commit` record with it.** The
rendered window on that commit is the one the old scroll offset asked for —
`scrollAnchor.ts` says so, and its `rowtop` gives it away by being a screen or
more from where the commit after puts the same row. The two records are written
by one effect, the commit's first, so the reading before a landing starts two
records back rather than one.
"""

import json
import sys

for path in sys.argv[1:]:
    print(f"  ===== {path} =====")
    records = [json.loads(line) for line in open(path)]
    carry = [r for r in records if r["kind"] in ("commit", "stack")]
    for x in sorted({r["x"] for r in carry}):
        mine = [r for r in carry if r["x"] == x]
        where = "left" if x < 600 else "right"
        landings = [i for i, r in enumerate(mine) if r["kind"] == "stack" and r["landed"]]
        if not landings:
            print(f"  {where:>5} pane at x={x}: nothing landed")
            continue
        at = landings[-1]
        before = next((r for r in reversed(mine[: at - 1]) if r.get("line")), None)
        if before is None:
            print(f"  {where:>5} pane at x={x}: no reader on any commit before the landing")
            continue
        held = before["line"]["id"]
        after = next((r for r in reversed(mine[at + 1 :]) if (r.get("line") or {}).get("id") == held), None)
        if after is None:
            print(f"  {where:>5} pane at x={x}: {held[:8]} is named on no record after the landing")
            continue
        moved = after["line"]["y"] - before["line"]["y"]
        took = after["line"]["within"] - before["line"]["within"]
        print(
            f"  {where:>5} pane at x={x}: {held[:8]} y {before['line']['y']} -> {after['line']['y']} "
            f"({moved:+d}px), within {before['line']['within']} -> {after['line']['within']} ({took:+d}px), "
            f"n={before['n']} -> n={after['n']}"
        )
