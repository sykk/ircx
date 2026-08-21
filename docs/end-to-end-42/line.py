"""Reads where each pane's reader was, landing by landing.

    line.py <probe.log> [...]

The stack records carry the reader's own line by message id — `within` is how
far into its row it is drawn, `top` is the transform the virtualiser wrote for
that row, and `y` is where the line lands against the top of the pane. One id
names the whole of a landing's window, so the rows being renamed and re-ordered
under it changes none of the three.

What to read: `y` on the commits after a landing against `y` on the commits
before the next one. **Not the landing commit itself** — the rendered window
there is the one the old scroll offset asked for, and its `top` gives it away by
being a screen or more from where the commit after puts the same row.
"""

import json
import sys

for path in sys.argv[1:]:
    print(f"\n===== {path} =====")
    records = [json.loads(line) for line in open(path)]
    stack = [r for r in records if r["kind"] == "stack"]
    for x in sorted({r["x"] for r in stack}):
        print(f"\n-- pane at x={x} --")
        for r in (r for r in stack if r["x"] == x):
            line = r.get("line")
            where = (
                "reader not drawn"
                if not line
                else "id=%s i=%-3d within=%-4d rowtop=%-6d y=%d"
                % (line["id"][:8], line["i"], line["within"], line["top"], line["y"])
            )
            print("n=%-4d landed=%-5s top=%-6d %s" % (r["n"], r["landed"], r["top"], where))
