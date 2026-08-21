"""What each row holds, in the order it holds it.

    order.py <probe.log>

`jumps` is how many places a row's messages are not consecutive at. The seed
sends `line 0001` upwards and nothing reorders them, so every row of one run
should read `jumps=0`. A row that reads more is the app putting messages in an
order the wire did not, and #602 is then ours rather than the engine's.
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
        if record.get("kind") != "stack" or not record["rows"]:
            continue
        if record.get("landed"):
            landings += 1
            print(f"-- landing {landings}, pane x={record['x']} --")
        bad = [row for row in record["rows"] if row.get("jumps")]
        if not bad:
            continue
        print(f"   n={record['n']} top={record['top']}")
        for row in bad:
            print(
                f"     i{row['i']} lines {row.get('from')}..{row.get('to')} "
                f"says={row['says']} jumps={row['jumps']}\n       run: {row.get('run')}"
            )
