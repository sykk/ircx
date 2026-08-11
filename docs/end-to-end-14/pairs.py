"""Which of the walk's frame pairs differ, and by how much.

    python3 pairs.py <walk output directory>

`md5sum` answers "did anything change at all", and a still pane is
byte-identical, so most pairs are settled without measuring anything. Only the
ones that differ are handed to the harness's `shift.py`, which slides a band of
the second frame over the first and answers in pixels. A positive shift is
content that moved up the window — the reader losing lines off the top.

Each row carries the wall-clock time `import` wrote the two frames, which is
what a CHATHISTORY line in ergo's log is matched against: a page landing between
t0 and t1 is the only thing that could have moved a pane nobody touched.
"""

import hashlib
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SHIFT = Path(__file__).resolve().parents[2] / ".claude/skills/run-ircx/shift.py"


def digest(path):
    return hashlib.md5(path.read_bytes()).hexdigest()


def stamp(path):
    return datetime.fromtimestamp(path.stat().st_mtime).strftime("%H:%M:%S.%f")[:-3]


out = Path(sys.argv[1])
pairs = sorted(out.glob("p*-t0.png"))
if not pairs:
    sys.exit(f"no frame pairs in {out}")

moved = []
for t0 in pairs:
    t1 = t0.with_name(t0.name.replace("-t0", "-t1"))
    if digest(t0) == digest(t1):
        continue
    measured = subprocess.run(
        [sys.executable, str(SHIFT), str(t0), str(t1)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    moved.append((t0, t1, measured.split(": ", 1)[1]))

print(f"{len(pairs)} pairs, {len(pairs) - len(moved)} byte-identical")
for t0, t1, measured in moved:
    print(f"  {t0.stem[:4]}  {stamp(t0)}  {stamp(t1)}  {measured}")
