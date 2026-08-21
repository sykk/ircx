"""How far the reader moved across the landing, on two messages.

    held.py <probe.log> [...]

The walk holds two pages — the one a freshly split pane asks for and the one it
is about — and the last of them is the landing being read.

Two readings per pane, because a pane holds one message and a reader looks at
another:

    anchor  the message the anchor is holding, which is the first of the row
            under the scroll offset. In this arrangement that row is a run of
            sixty and starts a screen or more above the fold.
    fold    the message that was at the top of the pane when the page arrived,
            which is what the reader was reading.

`y` is where a line lands against the top of the pane, so the difference is the
displacement — a subtraction on one message rather than a distance between two
pictures of rows that are no longer the same rows.

**The two do not answer together, and that is #601.** A page merging into the
anchor's row below the anchor's own message and above the fold moves everything
the reader can see while every term the anchor computes reads held: `anchor +0`
and `fold +582` in the same walk is a pane doing exactly what it was told and a
reader who was moved anyway.

`within` beside the anchor says whether the walk was in the arrangement at all:
the page merges into the reader's own row, so their line ends up that much
further into it. A `within` that barely moves is a page that went in somewhere
else, and this walk measured a reader it never reached.

**The landing commit is skipped, and its own `commit` record with it.** The
rendered window on that commit is the one the old scroll offset asked for —
`scrollAnchor.ts` says so, and its `rowtop` gives it away by being a screen or
more from where the commit after puts the same row. The two records are written
by one effect, the commit's first, so a reading before a landing starts two
records back rather than one.
"""

import json
import sys


def last_naming(records, kind, id):
    return next((r for r in reversed(records) if (r.get(kind) or {}).get("id") == id), None)


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
        for kind in ("line", "fold"):
            was = before.get(kind)
            name = "anchor" if kind == "line" else "fold"
            if not was:
                print(f"  {where:>5} pane at x={x}: {name} — nothing named before the landing")
                continue
            now = last_naming(mine[at + 1 :], kind, was["id"])
            if now is None:
                print(f"  {where:>5} pane at x={x}: {name} {was['id'][:8]} is named on no record after it")
                continue
            print(
                f"  {where:>5} pane at x={x}: {name:<6} {was['id'][:8]} "
                f"y {was['y']} -> {now[kind]['y']} ({now[kind]['y'] - was['y']:+d}px), "
                f"within {was['within']} -> {now[kind]['within']} "
                f"({now[kind]['within'] - was['within']:+d}px), n={before['n']} -> n={now['n']}"
            )
