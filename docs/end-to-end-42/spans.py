"""What a row measured, against what its own messages take up.

    spans.py <probe.log>

`stack.py` answers "is every row placed where the one above it ends". This
answers the question under it: whether the messages inside a row take up the
height the row measured. A row 4099px tall whose sixty messages span 3400 is a
row with 700px of messages laid out nowhere, and that is the app's fault rather
than the engine's; a row whose messages span what it measured leaves the paint.
"""

import json
import sys

for path in sys.argv[1:]:
    print(f"===== {path} =====")
    landings = 0
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("kind") != "stack":
            continue
        if record.get("landed"):
            landings += 1
            print(f"-- landing {landings}, pane x={record['x']} --")
        short = [
            row
            for row in record["rows"]
            if row.get("says", 0) > 1 and abs(row["h"] - row.get("spanned", row["h"])) > 24
        ]
        zeroed = [row for row in record["rows"] if row.get("zero", 0)]
        if not short and not zeroed:
            continue
        for row in short:
            print(
                f"   i{row['i']} h={row['h']} spanned={row.get('spanned')} "
                f"says={row['says']} zero={row.get('zero')}"
            )
        for row in zeroed:
            print(f"   i{row['i']} has {row['zero']} messages of no height")
    print("no row disagrees with its messages" if landings else "no landing in this log")
