#!/usr/bin/env bash
# The top of the parked pane, either side of the landing, as one picture.
#
#     topline.sh <output png> <walk directory>...
#
# What the reader is looking at is the line at the top of their pane, and neither
# instrument this run has can read it: `paneshift.py` cannot cross the landing —
# the page merges into the reader's row and takes the whole block into a declared
# group, so every row in that pane draws a spine and a tint it did not have and
# twelve of fourteen strips are not found — and the records name the *row's* first
# message, which is the message the merge changes.
#
# So the line is read off the frames, and this is what puts them side by side:
# the top 150px of the right pane out of the frame before the landing and the
# frame after it, stacked and labelled per walk. `pick.py` chose those two frames
# and prints which; this takes them from the same rule.
set -euo pipefail

OUT=${1:?output png}
shift

crop=()
for DIR in "$@"; do
  landing=$(python3 "$(dirname "$0")/pick.py" "$DIR" 2>/dev/null |
    grep -o "the landing is frame-[0-9]*\.png" | tail -1 | grep -o "frame-[0-9]*" || true)
  if [ -z "$landing" ]; then
    echo "$DIR: pick.py found no landing" >&2
    continue
  fi
  index=${landing#frame-}
  before=$(printf "%s/frame-%02d.png" "$DIR" $((10#$index - 1)))
  after="$DIR/$landing.png"
  name=$(basename "$(dirname "$DIR")")/$(basename "$DIR")
  for frame in "$before" "$after"; do
    tag=$([ "$frame" = "$before" ] && echo "before" || echo "after")
    file=$(mktemp --suffix=.png)
    convert "$frame" -crop 340x150+725+80 +repage \
      -background black -fill white -pointsize 14 label:"$name $tag" +swap -gravity west -append \
      "$file"
    crop+=("$file")
  done
done

convert "${crop[@]}" -append "$OUT"
rm -f "${crop[@]}"
echo "$OUT"
