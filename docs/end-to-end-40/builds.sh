#!/usr/bin/env bash
# The three binaries run 40 walks.
#
#     builds.sh <tree> <where to keep them>
#
#   ircx-ship     what anybody gets from `npm run tauri build -- --no-bundle`
#   ircx-probe    the same, with `VITE_PROBE=1`, so the commits write records
#   ircx-control  that build with #539's term taken out of the hold's exit
#
# The control is one boolean. `scrollAnchor.ts` ends the hold when the container
# has stopped growing *and* the reader's own row is a height the virtualiser
# knows; #539 is the second half, and taking it out is the build the drop was
# reported on. The measurement stays in either arm, so both compute the reader's
# line the same way and the only difference between them is the fix.
#
# Every build goes through the tree, so the tree is put back afterwards — and the
# fix being in `HEAD` is what makes `git checkout` the way back rather than the
# way to lose it.
set -euo pipefail

TREE=${1:?tree}
KEEP=${2:?where to keep them}
ANCHOR="$TREE/src/components/timeline/scrollAnchor.ts"
HELD='el.scrollHeight === previous?.sh && !offsets.rowUnmeasured(held.id)'
UNHELD='el.scrollHeight === previous?.sh'

mkdir -p "$KEEP"

build() {
  echo "building $1"
  ( cd "$TREE" && env "${@:2}" npm run tauri build -- --no-bundle > "$KEEP/$1.log" 2>&1 ) \
    || { echo "$1 did not build; see $KEEP/$1.log" >&2; exit 1; }
  cp "$TREE/target/release/ircx" "$KEEP/ircx-$1"
}

build ship
build probe VITE_PROBE=1

grep -qF "$HELD" "$ANCHOR" || { echo "the term to take out is not in $ANCHOR" >&2; exit 1; }
python3 - "$ANCHOR" "$HELD" "$UNHELD" <<'PY'
import sys
path, held, unheld = sys.argv[1:4]
text = open(path).read()
open(path, "w").write(text.replace(held, unheld, 1))
PY
build control VITE_PROBE=1
( cd "$TREE" && git checkout src/components/timeline/scrollAnchor.ts )
grep -qF "$HELD" "$ANCHOR" || { echo "the tree was not put back" >&2; exit 1; }

ls -l "$KEEP"/ircx-*
