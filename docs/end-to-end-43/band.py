"""Whether a parked pane is in the band this run's arrangement needs.

    band.py <probe.log>             where the panes ended the walk
    band.py --parked <probe.log>    where they were when the page landed

The band is two conditions and both are read off one commit — the last of the
walk while a parking is being calibrated, and the one before the landing in a
walk that has one, since by the end of that the page has already arrived:

  past LOAD_OLDER_PX  the pane's own `top` is over 400, so it is not the pane
                      that asks for the page
  inside the row      the reader's line is inside the row the window opens
                      with, so a page merging into that row reaches them

`rowtop` is what says which row it is: the window's first row sits at or near
zero, and a reader whose row starts thousands of pixels down is below anything
an arriving page can redraw.
"""

import json
import sys

LOAD_OLDER_PX = 400

args = [a for a in sys.argv[1:] if not a.startswith("--")]
parked = "--parked" in sys.argv[1:]

records = [json.loads(line) for line in open(args[0])]
carry = [r for r in records if r["kind"] in ("commit", "stack")]
for x in sorted({r["x"] for r in carry}):
    mine = [r for r in carry if r["x"] == x]
    landings = [i for i, r in enumerate(mine) if r["kind"] == "stack" and r["landed"]]
    # Two records back: the landing commit writes the commit record first and
    # the stack record after it, and the rendered window on that commit is the
    # one the old scroll offset asked for.
    upto = landings[-1] - 1 if parked and landings else len(mine)
    commits = [r for r in mine[:upto] if r["kind"] == "commit"]
    if not commits:
        print(f"  pane at x={x}: no commit to read the band off")
        continue
    last = commits[-1]
    where = "left" if x < 600 else "right"
    line = last.get("line")
    if not line:
        print(f"  {where:>5} pane at x={x}: top {last['top']}, no reader drawn")
        continue
    asks = last["top"] <= LOAD_OLDER_PX
    verdict = "ASKS FOR THE PAGE ITSELF" if asks else "past LOAD_OLDER_PX"
    print(
        f"  {where:>5} pane at x={x}: top {last['top']}, sh {last['sh']}, msgs {last['msgs']} — "
        f"{verdict}; the reader's row starts at {line['top']} and their line is "
        f"{line['within']} into it, {line['y']} from the top of the pane"
    )
