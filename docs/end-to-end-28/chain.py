"""The chain of page-backs a walk made, and what each one was answered with.

    chain.py <wire log>

Reads `docs/end-to-end-27/replaypage.py`'s log. Every earlier run counted asks,
because the question was always whether one ask became two. This one asks
whether ten asks became ten pages: a reader walking to the start of a channel
with real depth behind it makes a chain, and a chain has two ways to fail that
a count does not see — a link asked twice (`#487`) and a link that stops early
(the reader left short of their own history).

So each ask is printed with the msgid it named, the size of the batch that
answered it, and the round trip. A msgid asked twice is marked; the last line
is the verdict.

Walks share one log, and a walk is a launch: the label counter starts at one
again, which is what the sections are split on. The labels are worth reading
rather than counting — one missing from the sequence would be a page-back the
client composed, took a label for, and never sent.

**Most holes in that sequence are keepalives.** `session.rs` mints a PING token
out of the same counter the labels come from (`ircx8`, no hyphen, against
`label=ircx-8`), so a walk quiet enough to be pinged has a gap for every ping.
The first read of the first walk here spent a while on that hole before the
`PING ircx8` five lines above it explained it. So the pings are collected and
subtracted, and what is left over is a hole worth the next person's time.
"""

import sys
from collections import Counter

LOG = sys.argv[1]


def tags_of(line):
    if not line.startswith("@"):
        return {}
    out = {}
    for item in line[1:].split(" ", 1)[0].split(";"):
        key, _, value = item.partition("=")
        out[key] = value
    return out


def words_of(line):
    """The command and its arguments, past the tags and the source."""
    rest = line
    if rest.startswith("@"):
        rest = rest.split(" ", 1)[1] if " " in rest else ""
    if rest.startswith(":"):
        rest = rest.split(" ", 1)[1] if " " in rest else ""
    return rest.split(" ")


asks = []
batches = {}
pinged = set()
for raw in open(LOG):
    stamp, direction, line = raw[:9].strip(), raw[10:13].strip(), raw[14:].rstrip("\n")
    at = float(stamp)
    if direction == "-->":
        words = words_of(line)
        if words[0].upper() == "PING" and words[1:2] and words[1].startswith("ircx"):
            pinged.add(int(words[1].removeprefix("ircx")))
        continue
    if direction == "ask":
        selector = next((w for w in words_of(line) if w.startswith("msgid=")), "—")
        asks.append(
            {
                "at": at,
                "label": tags_of(line).get("label", "—"),
                "msgid": selector.removeprefix("msgid="),
                "size": 0,
                "answered": None,
            }
        )
        continue
    if direction != "<--":
        continue
    words = words_of(line)
    if words[0].upper() == "BATCH" and words[1:2] and words[1].startswith("+"):
        # A page-back's batch carries the label of the ask it answers. The
        # join's own `LATEST` carries none, and is not part of any chain.
        batches[words[1][1:]] = tags_of(line).get("label")
        continue
    if words[0].upper() == "BATCH" and words[1:2] and words[1].startswith("-"):
        label = batches.pop(words[1][1:], None)
        for ask in asks:
            if ask["label"] == label and ask["answered"] is None:
                ask["answered"] = at
        continue
    reference = tags_of(line).get("batch")
    if reference in batches and " PRIVMSG " in line:
        label = batches[reference]
        for ask in asks:
            if ask["label"] == label and ask["answered"] is None:
                ask["size"] += 1

def numbered(label):
    return int(label.removeprefix("ircx-")) if label.startswith("ircx-") else 0


walks = []
for ask in asks:
    if not walks or numbered(ask["label"]) <= numbered(walks[-1][-1]["label"]):
        walks.append([])
    walks[-1].append(ask)

for n, walk in enumerate(walks, 1):
    seen = Counter(ask["msgid"] for ask in walk)
    print(f"\n=== walk {n}")
    print(f"{'#':>3}  {'label':<9} {'msgid':<28} {'page':>5}  {'ms':>6}")
    for at, ask in enumerate(walk, 1):
        trip = "—" if ask["answered"] is None else f"{(ask['answered'] - ask['at']) * 1000:.0f}"
        marks = "  ← asked again" if seen[ask["msgid"]] > 1 else ""
        print(f"{at:3d}  {ask['label']:<9} {ask['msgid']:<28} {ask['size']:5d}  {trip:>6}{marks}")
    repeated = sum(count - 1 for count in seen.values() if count > 1)
    unanswered = sum(1 for ask in walk if ask["answered"] is None)
    holes = (
        set(range(1, numbered(walk[-1]["label"]) + 1))
        - {numbered(ask["label"]) for ask in walk}
        - pinged
    )
    print(
        f"{len(walk)} asks, {len(seen)} distinct, {repeated} repeated, "
        f"{unanswered} unanswered, labels neither sent nor pinged: "
        + (", ".join(f"ircx-{n}" for n in sorted(holes)) if holes else "none")
    )
