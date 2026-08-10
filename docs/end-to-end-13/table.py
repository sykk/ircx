#!/usr/bin/env python3
"""Renders the frames `anchor.sh` collected, and says what the reader did.

Reads the driver's transcript on stdin and picks the one `ok "[...]"` line the
final eval printed.
"""

import json
import sys

frames = None
for line in sys.stdin:
    if line.startswith('ok "['):
        frames = json.loads(json.loads(line.strip()[3:]))
if frames is None:
    sys.exit("no frames in the transcript: did the walk reach the last eval?")

print(f'{"t":>6} {"scrollTop":>10} {"scrollH":>8} {"sizer":>7} {"head":>5} {"markY":>8}  moved')
previous = None
for f in frames:
    moved = "" if previous is None or f["y"] is None else f'{f["y"] - previous:+.1f}'
    print(
        f'{f["t"]:6} {f["st"]:10} {f["sh"]:8} {f["sz"]:7} {f["hd"]:5} {str(f["y"]):>8}  {moved}'
    )
    if f["y"] is not None:
        previous = f["y"]
