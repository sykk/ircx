"""What each pane's anchor did on the commit a page landed in.

    landing.py <probe log>

Run 30's `landing.py` reading two panes: `probe.ts` writes the pane's left edge
into every record, which is the only term a screenshot and a record share, and
the walk knows its panes as the left one and the right one.

Per pane, three things.

**The write.** The anchor holds a message and a `delta` — where that message's
row sat below the top of the scroller — and puts the pane at `drawn - delta`.
Printed with the arithmetic beside it, because a write that matches its own
inputs and a reader who still moved is a different defect from a write that does
not.

**Who the anchor names afterwards.** `record()` runs at the end of the same
commit, and `messageAtOffset` answers with the *first message of the row* under
the top of the scroller. Where that is no longer the message the write was made
against, the row the reader was held by has taken in messages above them — the
page merging into the group at the top, which `scrollAnchor.ts` names as the
reason the anchor works in messages. It is detected in messages and corrected in
rows, and this line is where the two part company.

**The settling.** Every commit after the landing. What is followed is the
reader's own line — `delta` is where their *row* starts and `within` is how far
into it their line is drawn, and a row that takes in the messages a page brought
trades one against the other without moving anybody (#535). Where the line moves
and nobody scrolled, the pane moved under them.
"""

import json
import sys
from collections import defaultdict

commits = defaultdict(list)
with open(sys.argv[1]) as lines:
    for line in lines:
        record = json.loads(line)
        if record.get("kind") == "commit":
            commits[record["x"]].append(record)

def line(anchor):
    """Where the reader's own line sits below the top of the scroller: their
    row's place plus how far into it the line is drawn. `within` is absent on a
    build from before #535 and null where the row was not on the screen to
    measure, and both are read as the row's own top."""
    return anchor["delta"] + (anchor.get("within") or 0)


for x in sorted(commits):
    pane = commits[x]
    where = "left" if x < 600 else "right"
    print(f"{where} pane, at x {x}: {len(pane)} commits")
    landings = [
        (before, after)
        for before, after in zip(pane, pane[1:])
        if after["msgs"] - before["msgs"] >= 50
    ]
    if not landings:
        print("  no commit in this pane gained a page")
        continue
    if len(landings) > 1:
        print(f"  note: {len(landings)} landings; the last one is read below")
    before, landing = landings[-1]
    held, drawn, now = landing.get("held"), landing.get("drawn"), landing.get("now")
    print(f"  before the page  msgs {before['msgs']:>4}  top {before['top']:>6}  "
          f"branch {before['branch']}")
    print(f"  the landing      msgs {landing['msgs']:>4}  top {landing['top']:>6}  "
          f"branch {landing['branch']}")
    if held is not None and drawn is not None:
        # `tookIn` is a build with #535's fix in it saying what the reader's row
        # took in above their line, and 0 or absent is a row that took nothing.
        took = landing.get("tookIn") or 0
        print(f"    the write      drawn {drawn} + tookIn {took} - delta {held['delta']} = "
              f"{drawn + took - held['delta']}, and the pane went to {landing['top']}")
    print(f"    the head       headPx {landing['headPx']} against margin {landing['margin']}, "
          f"lag {landing['headPx'] - landing['margin']}")
    if held is not None and now is not None and held["id"] != now["id"]:
        print(f"    THE ROW TOOK IN MESSAGES: held {held['id']} at {line(held)}, and the row "
              f"under the reader now starts at {now['id']} at {line(now)}")

    # The reader's own line, which is what the anchor is for, followed by the id
    # it was recorded against rather than by whatever is at the top of the
    # scroller: a merge re-names the row and `now` is a different message on the
    # commit after it.
    reader = held if held is not None else now
    if reader is None:
        print("    the settling   nothing was anchored on the landing commit")
        continue
    was = line(reader)
    seen = [
        commit["now"]
        for commit in pane
        if commit["n"] > landing["n"] and (commit.get("now") or {}).get("id") == reader["id"]
    ]
    after = [c for c in pane if c["n"] > landing["n"]]
    if not seen:
        print(f"    the settling   {len(after)} commits, and the reader was never recorded again")
        continue
    ended = line(seen[-1])
    print(f"    the settling   {len(after)} commits: the reader's line {was} to {ended}, "
          f"{ended - was:+d}px under them")
