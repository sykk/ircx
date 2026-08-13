"""Where the reader's own head was, each time the client asked for a page.

    heads.py <tap log> [<tap log> ...]

`CHATHISTORY BEFORE #restore msgid=X 200` names the oldest message the pane
holds, so the sequence of asks is a readout of the frontend's head without
asking the frontend anything — run 16's finding, and the reason a tap answers
questions a screenshot cannot.

The seeded lines are numbered, so every msgid the server has already sent
resolves to a `line NNNN`. What that turns each session into is a walk: the head
at each ask, in the order the reader moved it. Two builds that page identically
print identical walks; two that do not print the line where they parted.

A msgid the log never carried prints as `?`, which is a page that came from the
archive rather than from this session's socket.
"""

import re
import sys

OPENED = re.compile(r"session opened")
MSGID = re.compile(r"msgid=([^;\s]+)")
LINE = re.compile(r"PRIVMSG \S+ :(line \d+)")
BEFORE = re.compile(r"CHATHISTORY BEFORE \S+ msgid=(\S+)")


def walk(path):
    """Per session, the `line NNNN` each BEFORE named."""
    said = {}
    out = []
    for raw in open(path):
        if OPENED.search(raw):
            out.append([])
            continue
        if len(raw) < 12 or not out:
            continue
        arrow, body = raw[9], raw[11:].rstrip()
        if arrow == "<":
            msgid, line = MSGID.search(body), LINE.search(body)
            if msgid and line:
                said[msgid.group(1)] = line.group(1)
            continue
        hit = BEFORE.search(body)
        if hit:
            out[-1].append(said.get(hit.group(1), "?"))
    return out


for path in sys.argv[1:]:
    for n, heads in enumerate(walk(path), start=1):
        if not heads:
            continue
        print(f"{path.split('/')[-2]:>8} session {n}: {' -> '.join(heads)}")
