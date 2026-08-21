#!/usr/bin/env bash
# #608's second conjecture, asked of the engine that ships.
#
#     TREE=<checkout> fill-lab.sh <output directory>
#
# `grow-lab.sh` with the stimulus changed, which is the whole difference. There
# a line already in the reader's row got taller; here four lines the reader
# never saw arrive stamped between two they have read past — a gap fill, which
# is history sorting into the *middle* of what is held rather than in front of
# it. A page-back answers before the window; a fill answers inside it.
#
# **Both sides have to be history for the arrangement to exist at all.**
# `rows.ts` closes the open run where `source` changes, so a fill landing in a
# window of live messages opens a row of its own instead of joining theirs —
# run 40's finding about a restored window, from the other side. The lab's seed
# answers `load_history`, so its window is `serverHistory` throughout and a fill
# merges into the run the way it would for a reader paged back into history.
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
js import("/src/store/index.ts").then((m) => { window.__store = m.useAppStore; window.__ready = 1; })
wait 800
js window.__ready === 1 ? "the store is in hand" : "no store"
js lab.open("#merge")
wait 3000
js (() => { const s = lab.scroller(0); const rows = [...s.querySelectorAll("[data-index]")]; const row = rows.find((r) => r.querySelectorAll("[data-msgid]").length >= 20); if (!row) return "no row is a run of twenty"; const box = s.getBoundingClientRect(); const top = row.getBoundingClientRect().top - box.top + s.scrollTop; window.__row = row.dataset.index; s.scrollTop = top + row.offsetHeight - 100; return { parkedAt: Math.round(s.scrollTop), row: row.dataset.index, holds: row.querySelectorAll("[data-msgid]").length }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const num = (el) => { const m = /line (\d{4})/.exec(el.textContent || ""); return m ? +m[1] : null; }; const at = (el) => Math.round(el.getBoundingClientRect().top - box.top); const drawn = [...s.querySelectorAll("[data-msgid]")]; const fold = drawn.find((el) => at(el) >= 34); const row = s.querySelector('[data-index="' + window.__row + '"]'); const first = row.querySelector("[data-msgid]"); window.__fold = fold.dataset.msgid; window.__anchor = first.dataset.msgid; return { scrollTop: Math.round(s.scrollTop), fold: { line: num(fold), y: at(fold) }, anchor: { line: num(first), y: at(first) } }; })()
ss OUT/before.png
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const row = s.querySelector('[data-index="' + window.__row + '"]'); const above = [...row.querySelectorAll("[data-msgid]")].filter((el) => el.getBoundingClientRect().bottom - box.top < 34); const target = above[Math.floor(above.length / 2)]; if (!target) return "nothing in this row is above the fold"; const id = target.dataset.msgid; const st = window.__store.getState(); const key = Object.keys(st.timelines).find((k) => st.timelines[k].messages.some((m) => m.id === id)); const was = st.timelines[key].messages.find((m) => m.id === id); const at = Date.parse(was.timestamp); const fill = [0, 1, 2, 3].map((i) => ({ ...was, id: "fill" + i, text: "the fill " + i + ", behind what the reader has read", timestamp: new Date(at + i + 1).toISOString() })); window.__fill = "fill0"; st.applyEvent({ type: "messagesAppended", answers: null, network: was.network, target: was.target, messages: fill }); return { behind: id, line: /line (\d{4})/.exec(was.text)[1], stamped: was.timestamp }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? Math.round(el.getBoundingClientRect().top - box.top) : null; }; const rowOf = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? el.closest("[data-index]").dataset.index : null; }; return { scrollTop: Math.round(s.scrollTop), fold: at(window.__fold), anchor: at(window.__anchor), fill: at(window.__fill), merged: rowOf(window.__fill) === rowOf(window.__anchor) }; })()
ss OUT/after.png
wait 2000
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? Math.round(el.getBoundingClientRect().top - box.top) : null; }; return { settled: true, scrollTop: Math.round(s.scrollTop), fold: at(window.__fold), anchor: at(window.__anchor) }; })()
ss OUT/settled.png
quit
LAB
