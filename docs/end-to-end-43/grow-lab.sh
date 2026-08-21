#!/usr/bin/env bash
# #608's first conjecture, asked of the engine that ships.
#
#     TREE=<checkout> grow-lab.sh <output directory>
#
# `Timeline.layout.test.tsx` says a line getting taller inside the reader's own
# row, above their eyes, moves them by exactly what it gained — and #599 is what
# a model saying so alone is worth. `docs/end-to-end-42/lab` is the third corner
# of the harness: the real frontend in `webkit2gtk-4.1`, the library Tauri
# links, with selectors behind it.
#
# No page lands, nothing is prepended and nothing changes place in the list.
# One pane, parked inside a run of sixty, and one message above the fold made
# two lines longer through the store the app's own event pump writes to.
#
# The parking is `scrollTop` rather than a wheel. #602 needed a real one because
# a wheel a script dispatches skips the engine's own scrolling path; nothing
# here is on the far side of it, and the app answers a programmatic scroll with
# the same `record` it answers a wheel with.
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

# The store the app renders from, reached through Vite's own module graph so it
# is the instance the app is using rather than a second copy of it.
# The script is quoted so the JS reaches the engine as written — `\d` in a
# regex does not survive a heredoc the shell is expanding — and the screenshot
# paths are put in afterwards.
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
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const row = s.querySelector('[data-index="' + window.__row + '"]'); const above = [...row.querySelectorAll("[data-msgid]")].filter((el) => el.getBoundingClientRect().bottom - box.top < 34); const target = above[Math.floor(above.length / 2)]; if (!target) return "nothing in this row is above the fold"; const id = target.dataset.msgid; const st = window.__store.getState(); const key = Object.keys(st.timelines).find((k) => st.timelines[k].messages.some((m) => m.id === id)); const was = st.timelines[key].messages.find((m) => m.id === id); window.__grown = id; st.applyEvent({ type: "messageUpdated", message: { ...was, text: was.text + " " + "and then it was said again ".repeat(6) } }); return { grew: id, line: /line (\d{4})/.exec(was.text)[1], above: above.length }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? Math.round(el.getBoundingClientRect().top - box.top) : null; }; return { scrollTop: Math.round(s.scrollTop), fold: at(window.__fold), anchor: at(window.__anchor), grown: at(window.__grown) }; })()
ss OUT/after.png
wait 2000
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? Math.round(el.getBoundingClientRect().top - box.top) : null; }; return { settled: true, scrollTop: Math.round(s.scrollTop), fold: at(window.__fold), anchor: at(window.__anchor) }; })()
ss OUT/settled.png
quit
LAB
