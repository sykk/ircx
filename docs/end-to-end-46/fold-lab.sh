#!/usr/bin/env bash
# Which message the anchor holds when a pane is narrowed under a parked reader,
# and where it and the one after it end up.
#
#     TREE=<checkout> [WIDTH=340] fold-lab.sh <output directory>
#
# `resize-lab.sh` beside this measures the first message drawn at or below the
# fold. That is not the message the fold cuts through — the one it cuts starts
# *above* the top of the window and continues into it, and it is the one
# `messageAtOffset` names as the reader. Reading one for the other is what #613
# was opened on: the anchor held its own message to the pixel at every width,
# and the 46px was the growth of that message's own text, drawn between the fold
# and everything the reader was reading.
#
# So both are measured here, and the widths are swept: the debt was never
# `ESTIMATED_ROW_PX` but one line of prose per line the cut message gained —
# nothing at 600, 23px at 500, 46px at 340.
set -euo pipefail
TREE=${TREE:?the checkout to walk}
WIDTH=${WIDTH:-340}
DIR=${1:?output directory}
mkdir -p "$DIR"

npx vite --config "$TREE/docs/end-to-end-42/lab/vite.lab.config.mjs" > "$DIR/vite.log" 2>&1 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT
URL=""
for _ in $(seq 60); do
  URL=$(grep -oE 'http://localhost:[0-9]+/' "$DIR/vite.log" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "vite never printed a URL" >&2; exit 1; }
echo "the lab is at $URL, narrowing to $WIDTH"

sed -e "s|OUT/|$DIR/|g" -e "s|__WIDTH__|$WIDTH|g" <<'LAB' | python3 "$TREE/docs/end-to-end-42/lab/lab.py" "$URL" --zoom 1.0
wait 2200
js lab.open("#merge")
wait 3000
js (() => { const s = lab.scroller(0); const rows = [...s.querySelectorAll("[data-index]")]; const row = rows.find((r) => r.querySelectorAll("[data-msgid]").length >= 20); if (!row) return "no row is a run of twenty"; const box = s.getBoundingClientRect(); const top = row.getBoundingClientRect().top - box.top + s.scrollTop; window.__row = row.dataset.index; s.scrollTop = top + Math.round(row.offsetHeight / 2); return { parkedAt: Math.round(s.scrollTop), row: row.dataset.index, holds: row.querySelectorAll("[data-msgid]").length }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (el) => Math.round(el.getBoundingClientRect().top - box.top); let spans = null, first = null; for (const el of s.querySelectorAll("[data-msgid]")) { if (at(el) > 0) { first = el; break; } spans = el; } if (!spans || !first) return "nothing is drawn across the fold"; window.__spans = spans.dataset.msgid; window.__first = first.dataset.msgid; window.__shot = () => { const b = s.getBoundingClientRect(); const el = (id) => [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); const one = (id) => { const e = el(id); return e ? { id, y: Math.round(e.getBoundingClientRect().top - b.top), px: e.offsetHeight } : null; }; return { width: Math.round(b.width), scrollTop: Math.round(s.scrollTop), spansTheFold: one(window.__spans), firstWhole: one(window.__first) }; }; return window.__shot(); })()
ss OUT/before.png
js (() => { lab.scroller(0).style.width = "__WIDTH__px"; return { narrowedTo: __WIDTH__ }; })()
wait 3000
js window.__shot()
ss OUT/narrow.png
js (() => { lab.scroller(0).style.width = "824px"; return { widenedBack: 824 }; })()
wait 3000
js window.__shot()
ss OUT/back.png
quit
LAB
