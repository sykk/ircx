"""What the anchor did on the commit a page landed in, and what happened after.

    landing.py <probe log>

`shift.py` reads the reader's line off two frames and says how far it moved. It
cannot say why, and the two candidates leave the same photograph: a `scrollTop`
written to the wrong place, or written to the right one and then the content
above the reader re-measured under it. That is `probe.ts`'s own distinction and
this is where it is drawn.

Three things are printed.

**The write.** On the landing commit the anchor holds a message and a `delta` —
where that message sat below the top of the scroller — and puts the pane at
`drawn - delta`. Printed with the arithmetic beside it, because a write that
matches its own inputs and a reader who still moved is the whole of what the
settling costs.

**`headPx` against `margin`.** The head leaves on this commit and the
virtualiser's `scrollMargin` is a commit behind it, which is the difference
`scrollAnchor.ts` calls `lag` and claims carries the head's departure with no
term of its own. On the landing commit the two disagree by exactly one head.

**The settling.** Every commit after it, until the records stop. `record()` runs
at the end of each, so the anchor is re-taken against whatever is at the top of
the scroller — and where the id stays the same and its `delta` changes, the pane
moved under a reader nobody scrolled. The last line is that drift totalled.
"""

import json
import sys

LOG = sys.argv[1]

commits = []
with open(LOG) as lines:
    for line in lines:
        record = json.loads(line)
        if record.get("kind") == "commit":
            commits.append(record)

landings = [
    (before, after)
    for before, after in zip(commits, commits[1:])
    if after["msgs"] - before["msgs"] >= 50
]
if not landings:
    sys.exit("no commit in this log gained a page")
if len(landings) > 1:
    print(f"note: {len(landings)} landings; the last one is read below")
before, landing = landings[-1]

held = landing.get("held")
drawn = landing.get("drawn")
print(f"before the page   msgs {before['msgs']:>4}  top {before['top']:>6}  branch {before['branch']}")
print(f"the landing       msgs {landing['msgs']:>4}  top {landing['top']:>6}  branch {landing['branch']}")
if held is not None and drawn is not None:
    print(f"  the write       drawn {drawn} - delta {held['delta']} = {drawn - held['delta']}, "
          f"and the pane went to {landing['top']}")
print(f"  the head        headPx {landing['headPx']} against margin {landing['margin']}, "
      f"lag {landing['headPx'] - landing['margin']}")

after = [c for c in commits if c["n"] > landing["n"]]
print(f"\nthe settling, {len(after)} commits")
anchored = landing.get("now")
if anchored is None:
    sys.exit("nothing was anchored on the landing commit")
first = anchored["delta"]
last = first
for commit in after:
    now = commit.get("now")
    if now is None or now["id"] != anchored["id"]:
        print(f"  n {commit['n']:>5}  the anchor changed hands; the rest is not this reader")
        break
    last = now["delta"]
print(f"  the same message, delta {first:+d} at the landing and {last:+d} at the end: "
      f"{last - first:+d}px under the reader")
