"""Reads the stack records a walk wrote and says which of the three it is.

    stack.py <probe.log> [...]

#602 leaves three answers open and the records separate them:

  short row     the row's own height is wrong for the messages it holds
  wrong offset  the height is right and the row below is not placed at it
  paint         every row starts where the one above it ends, and the screen
                still has a gap

`says` is how many messages the row actually drew, which is the fourth answer
the frames raised: ten messages absent from the flow rather than covered by
anything.
"""

import json
import sys

for path in sys.argv[1:]:
    print(f"\n===== {path} =====")
    records = []
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("kind") == "stack":
                records.append(record)

    if not records:
        print("no stack records")
        continue

    landings = [i for i, r in enumerate(records) if r.get("landed")]
    print(f"{len(records)} stack records, {len(landings)} landings")

    for i in landings:
        run = records[i : i + 8]
        pane = run[0].get("x")
        print(f"\n-- landing at record {i}, pane x={pane} --")
        for n, record in enumerate(run):
            if record.get("x") != pane:
                continue
            rows = record.get("rows") or []
            gaps = []
            stacks = None
            for row in rows:
                if stacks is not None and abs(row["top"] - stacks) > 1:
                    gaps.append(f"i{row['i']}{row['top'] - stacks:+d}")
                stacks = row["top"] + row["h"]
            # The block the page merges into, by the message that opens it.
            merged = [r for r in rows if r.get("first") and "0600" in str(r["first"])]
            note = ""
            if merged:
                row = merged[0]
                note = (
                    f" merged i{row['i']} top={row['top']} h={row['h']} "
                    f"says={row['says']} {row['first']}..{row['last']}"
                )
            print(
                f"  +{n} top={record.get('top')} rows={len(rows)} "
                f"offsets_wrong={len(gaps)} {' '.join(gaps[:6])}{note}"
            )
