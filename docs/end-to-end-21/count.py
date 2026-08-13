#!/usr/bin/env python3
"""Counts what each segment of a walk raised.

    count.py <notifications.jsonl> [walk]

The log is append-only across every walk of the run, and the markers are what
separate them. `walk` picks one by its `walk-start` marker, counting from 1;
without it every segment in the file is printed.

The order column is the part worth having: `notifyForEvents` does not await
`sendNotification`, so a batch's calls race, and whether twenty arrived is a
different question from whether they arrived in the order they were sent.
"""

import json
import re
import sys


def segments(path, want):
    walk = 0
    current = None
    for line in open(path):
        row = json.loads(line)
        if row["call"] == "mark":
            what = row["what"]
            if what.startswith("walk-start"):
                walk += 1
            if current:
                yield current
            current = {"walk": walk, "name": what, "rows": []}
        elif row["call"] == "notify" and current:
            current["rows"].append(row)
    if current:
        yield current


def ordered(rows):
    numbers = [int(m.group(1)) for r in rows if (m := re.search(r"burst (\d+)", r["body"]))]
    if len(numbers) < 2:
        return ""
    return "in order" if numbers == sorted(numbers) else f"out of order {numbers}"


def main():
    path = sys.argv[1]
    want = int(sys.argv[2]) if len(sys.argv) > 2 else None
    print(f"{'walk':>4}  {'segment':<28} {'raised':>6}  detail")
    for segment in segments(path, want):
        if want is not None and segment["walk"] != want:
            continue
        rows = segment["rows"]
        titles = sorted({r["summary"] for r in rows})
        detail = ", ".join(titles)
        note = ordered(rows)
        if note:
            detail = f"{detail} — {note}"
        print(f"{segment['walk']:>4}  {segment['name'][:28]:<28} {len(rows):>6}  {detail}")


if __name__ == "__main__":
    main()
