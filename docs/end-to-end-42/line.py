"""Reads where each pane's reader was, commit by commit.

    line.py <probe.log> [...]           every commit
    line.py --landings <probe.log>      the commits around a landing only

Both kinds of record carry the reader's own line by message id — `within` is how
far into its row it is drawn, `top` is the transform the virtualiser wrote for
that row, and `y` is where the line lands against the top of the pane. The stack
records latch one id for the whole of a landing's window, so the rows being
renamed and re-ordered under it changes none of the three.

What to read: `y` on the last commit before a landing against `y` once the pane
has settled. **Not the landing commit itself** — the rendered window there is the
one the old scroll offset asked for, and its `top` gives it away by being a
screen or more from where the commit after puts the same row.
"""

import json
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
landings_only = "--landings" in sys.argv[1:]

for path in args:
    print(f"\n===== {path} =====")
    records = [json.loads(line) for line in open(path)]
    carry = [r for r in records if r["kind"] in ("commit", "stack")]
    for x in sorted({r["x"] for r in carry}):
        print(f"\n-- pane at x={x} --")
        mine = [r for r in carry if r["x"] == x]
        # A landing is the stack record that says so; the commits either side of
        # it are what the reading is made of.
        near = set()
        for i, r in enumerate(mine):
            if r["kind"] == "stack" and r["landed"]:
                near.update(range(max(0, i - 4), min(len(mine), i + 12)))
        for i, r in enumerate(mine):
            if landings_only and i not in near:
                continue
            line = r.get("line")
            where = (
                "reader not drawn"
                if not line
                else "id=%s i=%-3d within=%-4d rowtop=%-6d y=%d"
                % (line["id"][:8], line["i"], line["within"], line["top"], line["y"])
            )
            what = "LANDED" if r["kind"] == "stack" and r["landed"] else r.get("branch", r["kind"])
            print("n=%-4d %-8s top=%-6d %s" % (r["n"], what, r["top"], where))
