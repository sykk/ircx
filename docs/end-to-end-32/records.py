"""The instrumented walk's own account of the guard a stale page is read against.

    records.py <walk directory>

A frame cannot show `askedBehind`, and the wire cannot either — it is a value in
the store, written by the pane when a page-back returns and taken off by the
batch that answers it. The build this reads carries two records of its own:

    asked   a page-back returned. `armed` is whether the pane put the guard up.
    landed  a server-history batch reached the store. `guard` is what was up
            when it did, `fresh` how much of it the window did not already hold.

Two lines together are what the run turns on. A `landed` with `fresh 0` against
a guard is the store concluding the history ends there — #540. The same landing
against `guard null`, or with any `fresh` at all, concludes nothing.

The order of the pair around one page-back is not fixed and is the whole story:
the batch crosses on the event channel, which the pump holds for its 8ms window
(`WINDOW`, `src-tauri/src/events.rs`), while the command's answer does not wait
for it. Whichever arrives second decides how long the guard stays up.
"""

import json
import os
import sys

DIR = sys.argv[1]

for line in open(os.path.join(DIR, "probe.log")):
    record = json.loads(line)
    at = f"{record['t'] / 1000:8.3f}s"
    if record["kind"] == "asked":
        # `armed` is the old build's alone: there the pane decides after the
        # answer whether to put the guard up, and here it went up before the
        # request. Both builds say which message the ask was behind.
        armed = f"armed {str(record['armed']):<5} " if "armed" in record else ""
        print(
            f"{at}  asked    outcome {record['outcome']:<9} "
            f"{armed}behind {record['behind'][:8]}"
        )
    elif record["kind"] == "landed":
        # What the batch says it answers is #541's build alone. A landing
        # whose `answers` is not the `guard` is the one #541 exists for.
        answers = (
            f"answers {str(record['answers'])[:8]:<9} " if "answers" in record else ""
        )
        print(
            f"{at}  landed   arrived {record['arrived']:<4} fresh {record['fresh']:<4} "
            f"{answers}guard {str(record['guard'])[:8]:<9} hasMore {record['hasMore']}"
        )
