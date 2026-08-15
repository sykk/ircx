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

**The settling.** Every commit after the landing. Where the id stays the same and
its `delta` changes, the pane moved under a reader nobody scrolled.
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
        print(f"    the write      drawn {drawn} - delta {held['delta']} = {drawn - held['delta']}, "
              f"and the pane went to {landing['top']}")
    print(f"    the head       headPx {landing['headPx']} against margin {landing['margin']}, "
          f"lag {landing['headPx'] - landing['margin']}")
    if held is not None and now is not None:
        if held["id"] == now["id"]:
            print(f"    the reader     still {now['id']}, delta {held['delta']} to {now['delta']}")
        else:
            print(f"    THE ROW TOOK IN MESSAGES: held {held['id']} at delta {held['delta']}, "
                  f"and the row under the reader now starts at {now['id']}, delta {now['delta']}")

    after = [c for c in pane if c["n"] > landing["n"]]
    print(f"    the settling   {len(after)} commits", end="")
    if now is None:
        print(", and nothing was anchored on the landing commit")
        continue
    last = now["delta"]
    for commit in after:
        current = commit.get("now")
        if current is None or current["id"] != now["id"]:
            print(", and the anchor changed hands part way", end="")
            break
        last = current["delta"]
    print(f": delta {now['delta']:+d} to {last:+d}, {last - now['delta']:+d}px under the reader")
