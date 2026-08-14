"""What each page-back asked from, and how far back the reader got.

    reach.py <wire log>

`chain.py` counts the chain and reads its two failures off the labels. This
reads the other half of the same log: the row each ask *named*, resolved through
the `msgid` the server put on it when it sent it.

That resolution is what #496 was found by, by hand, in run 16 — "a
`CHATHISTORY BEFORE` whose msgid resolves to a `time=` from today asks the
server again for the page it has just sent". The client is supposed to ask from
the oldest row it holds, so an ask naming anything newer is the defect on the
wire rather than in the store, and run 17's unexplained count is the question of
whether that is what its old build was doing.

So every ask is printed with the row it named and how far that row is from the
oldest one the connection had delivered by then. The last line per connection is
how far back the reader actually got, which against `depth.py`'s oldest is the
whole of "stopped short of history the server still holds".
"""

import sys
from datetime import datetime

LOG = sys.argv[1]


def tags_of(line):
    if not line.startswith("@"):
        return {}
    out = {}
    for item in line[1:].split(" ", 1)[0].split(";"):
        key, _, value = item.partition("=")
        out[key] = value
    return out


def stamp_of(tags):
    """The `time=` tag as a datetime. A row without one cannot be placed."""
    raw = tags.get("time")
    if not raw:
        return None
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def body(line):
    """A tagged line opens `@tags :prefix PRIVMSG #chan :text`, so the text is
    after the last ` :` rather than the first."""
    return line.split(" :")[-1][:44]


class Connection:
    def __init__(self, at):
        self.at = at
        self.asks = []
        self.oldest = None
        self.oldest_text = None

    def saw(self, when, text):
        if when is None:
            return
        if self.oldest is None or when < self.oldest:
            self.oldest, self.oldest_text = when, text

    def report(self, n):
        print(f"\n=== connection {n}, opened at {self.at:.3f}, {len(self.asks)} asks")
        if not self.asks:
            print("    no page-back")
        for at, ask in enumerate(self.asks, 1):
            when, text, behind = ask["when"], ask["text"], ask["behind"]
            named = f"{when:%H:%M:%S} {text!r}" if when else f"{ask['msgid']} — never sent here"
            gap = ""
            if behind is not None and behind.total_seconds() > 0:
                gap = f"  ← newer than the oldest it held, by {behind}"
            print(f"{at:3d}  {named}{gap}")
        if self.oldest:
            print(f"    reached {self.oldest:%Y-%m-%d %H:%M:%S} {self.oldest_text!r}")


rows = {}
connections = []
current = None
for raw in open(LOG):
    at, direction, line = float(raw[:9]), raw[10:13].strip(), raw[14:].rstrip("\n")
    tags = tags_of(line)
    if direction == "<--" and " PRIVMSG " in line and "msgid" in tags:
        when = stamp_of(tags)
        rows[tags["msgid"]] = (when, body(line))
        if current is None:
            current = Connection(at)
        current.saw(when, body(line))
        continue
    if direction == "ask":
        selector = next((w for w in line.split(" ") if w.startswith("msgid=")), "msgid=—")
        msgid = selector.removeprefix("msgid=")
        when, text = rows.get(msgid, (None, None))
        if current is None:
            current = Connection(at)
        behind = None
        if when and current.oldest:
            behind = when - current.oldest
        current.asks.append({"msgid": msgid, "when": when, "text": text, "behind": behind})
        continue
    if direction == "end":
        if current is not None:
            connections.append(current)
            current = None

if current is not None:
    connections.append(current)

for n, connection in enumerate(connections, 1):
    connection.report(n)
