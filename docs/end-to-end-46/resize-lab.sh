#!/usr/bin/env bash
# A pane narrowed under a reader parked inside a run, asked of the engine that
# ships.
#
#     TREE=<checkout> resize-lab.sh <output directory>
#
# `Timeline.layout.test.tsx` says the line the fold cuts through holds to the
# pixel across a rewrap, and #599 is what a model saying so alone is worth.
# `docs/end-to-end-42/lab` is the third corner: the real frontend in
# `webkit2gtk-4.1`, wrapping real prose at a width the script changes.
#
# A rewrap is the one thing a reader can do that changes the height of every row
# at once, and the three kinds are answered by three different things — rows
# above the fold by the virtualiser, the row the reader is inside by the anchor's
# `grown` branch, and rows below by nobody. So it is worth asking the engine
# whether they agree with each other, which no model can be asked.
#
# **`cut` below is not the message the fold cuts through.** It is the first one
# drawn at or below the fold, and the one the fold cuts is the message above it
# — which is the one the anchor holds. #613 was written off this script reading
# one for the other; `fold-lab.sh` beside it measures both.
set -euo pipefail
TREE=${TREE:?the checkout to walk}
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
echo "the lab is at $URL"

sed "s|OUT/|$DIR/|g" <<'LAB' | python3 "$TREE/docs/end-to-end-42/lab/lab.py" "$URL" --zoom 1.0
wait 2200
js lab.open("#merge")
wait 3000
js (() => { const s = lab.scroller(0); const rows = [...s.querySelectorAll("[data-index]")]; const row = rows.find((r) => r.querySelectorAll("[data-msgid]").length >= 20); if (!row) return "no row is a run of twenty"; const box = s.getBoundingClientRect(); const top = row.getBoundingClientRect().top - box.top + s.scrollTop; window.__row = row.dataset.index; s.scrollTop = top + Math.round(row.offsetHeight / 2); return { parkedAt: Math.round(s.scrollTop), row: row.dataset.index, holds: row.querySelectorAll("[data-msgid]").length }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (el) => Math.round(el.getBoundingClientRect().top - box.top); const num = (el) => { const m = /line (\d{4})/.exec(el.textContent || ""); return m ? +m[1] : null; }; const drawn = [...s.querySelectorAll("[data-msgid]")]; let cut = null, next = null; for (const el of drawn) { if (at(el) > 34) { next = el; break; } cut = el; } if (!cut) return "nothing is drawn above the fold"; window.__cut = cut.dataset.msgid; window.__next = next.dataset.msgid; const row = s.querySelector('[data-index="' + window.__row + '"]'); return { scrollTop: Math.round(s.scrollTop), width: Math.round(box.width), rowPx: row.offsetHeight, within: Math.round(cut.getBoundingClientRect().top - row.getBoundingClientRect().top), cut: { line: num(cut), y: at(cut) }, next: { line: num(next), y: at(next) } }; })()
ss OUT/before.png
js (() => { const s = lab.scroller(0); s.style.width = "340px"; return { narrowedTo: 340 }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const el = (id) => [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); const at = (id) => { const e = el(id); return e ? Math.round(e.getBoundingClientRect().top - box.top) : null; }; const row = s.querySelector('[data-index="' + window.__row + '"]'); const within = (id) => { const e = el(id); return e && row ? Math.round(e.getBoundingClientRect().top - row.getBoundingClientRect().top) : null; }; return { scrollTop: Math.round(s.scrollTop), width: Math.round(box.width), rowPx: row ? row.offsetHeight : null, cut: at(window.__cut), next: at(window.__next), within: within(window.__cut) }; })()
ss OUT/after.png
wait 2000
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? Math.round(el.getBoundingClientRect().top - box.top) : null; }; return { settled: true, scrollTop: Math.round(s.scrollTop), cut: at(window.__cut), next: at(window.__next) }; })()
ss OUT/settled.png
quit
LAB
