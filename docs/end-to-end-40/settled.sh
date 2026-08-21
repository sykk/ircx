#!/usr/bin/env bash
# The top of the parked pane before the page, just after it, and once the walk
# has run out.
#
#     settled.sh <output png> <left|right> <walk directory>...
#
# `topline.sh` reads the pair `pick.py` chose, which straddles the landing by a
# second — and a second is not the end of it. The rows the page brought go on
# being measured for several, and every one of those measurements is a
# correction the virtualiser applies to a scroller it has already moved. So a
# reader who is somewhere else in the frame after the landing has not been shown
# to have been left there, and the last frame of the walk — thirty seconds on,
# nothing else happening — is what says whether it stuck.
set -euo pipefail

OUT=${1:?output png}
PANE=${2:?left or right}
shift 2
case $PANE in
  left) CROP=340x150+245+80 ;;
  right) CROP=340x150+725+80 ;;
  *) echo "which pane: left or right" >&2; exit 1 ;;
esac

parts=()
for DIR in "$@"; do
  landing=$(python3 "$(dirname "$0")/pick.py" "$DIR" 2>/dev/null |
    grep -o "the landing is frame-[0-9]*\.png" | tail -1 | grep -o "frame-[0-9]*" || true)
  [ -n "$landing" ] || { echo "$DIR: pick.py found no landing" >&2; continue; }
  index=${landing#frame-}
  name=$(basename "$(dirname "$DIR")")/$(basename "$DIR")
  last=$(ls "$DIR"/frame-*.png | tail -1)
  for stage in before after settled; do
    case $stage in
      before) frame=$(printf "%s/frame-%02d.png" "$DIR" $((10#$index - 1))) ;;
      after) frame="$DIR/$landing.png" ;;
      settled) frame=$last ;;
    esac
    file=$(mktemp --suffix=.png)
    magick "$frame" -crop "$CROP" +repage \
      -background black -fill white -pointsize 14 label:"$name $PANE $stage" +swap \
      -gravity west -append "$file"
    parts+=("$file")
  done
done

magick "${parts[@]}" -append "$OUT"
rm -f "${parts[@]}"
echo "$OUT"
