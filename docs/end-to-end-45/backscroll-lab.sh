#!/usr/bin/env bash
# A row entirely above the fold growing while the virtualiser's scrollDirection
# is <direction>, asked of the engine that ships.
#
#     TREE=<checkout> backscroll-lab.sh <output directory> <forward|backward>
#
# Run 43's grow-lab.sh with two changes: the growth is in a row the reader is
# not inside, and it is fired from a scroll listener so it lands while the
# virtualiser still calls the scroll a backward one — `isScrollingResetDelay` is
# 150ms and a round trip through lab.py is not inside it.
set -euo pipefail
TREE=${TREE:?the checkout to walk}
DIR=${1:?output directory}
WAY=${2:?forward or backward}
if [ "$WAY" = backward ]; then STEP=-60; else STEP=60; fi
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
echo "the lab is at $URL, arm $WAY"

sed -e "s|OUT/|$DIR/|g" -e "s|STEP|$STEP|g" <<'LAB' | python3 "$TREE/docs/end-to-end-42/lab/lab.py" "$URL" --zoom 1.0
wait 2200
js import("/src/store/index.ts").then((m) => { window.__store = m.useAppStore; window.__ready = 1; })
wait 800
js window.__ready === 1 ? "the store is in hand" : "no store"
js lab.open("#merge")
wait 3000
js (() => { const s = lab.scroller(0); s.scrollTop = Math.round(s.scrollHeight * 0.6); return { parkedAt: Math.round(s.scrollTop), rows: s.querySelectorAll("[data-index]").length }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (el) => Math.round(el.getBoundingClientRect().top - box.top); const num = (el) => { const m = /line (\d{4})/.exec(el.textContent || ""); return m ? +m[1] : null; }; const drawn = [...s.querySelectorAll("[data-msgid]")]; const fold = drawn.find((el) => at(el) >= 34); const foldRow = fold.closest("[data-index]"); const above = drawn.filter((el) => { const r = el.closest("[data-index]"); return r !== foldRow && r.getBoundingClientRect().bottom - box.top < 34; }); const target = above[above.length - 2]; if (!target) return "no row is entirely above the fold"; window.__fold = fold.dataset.msgid; window.__grown = target.dataset.msgid; return { scrollTop: Math.round(s.scrollTop), fold: { line: num(fold), y: at(fold) }, target: { line: num(target), y: at(target) }, entirelyAbove: above.length }; })()
ss OUT/before.png
js (() => { const s = lab.scroller(0); const id = window.__grown; const st = window.__store.getState(); const key = Object.keys(st.timelines).find((k) => st.timelines[k].messages.some((m) => m.id === id)); const was = st.timelines[key].messages.find((m) => m.id === id); s.addEventListener("scroll", () => { window.__store.getState().applyEvent({ type: "messageUpdated", message: { ...was, text: was.text + " " + "and then it was said again ".repeat(6) } }); window.__fired = Math.round(s.scrollTop); }, { once: true }); s.scrollTop += STEP; return { asked: Math.round(s.scrollTop), grew: id }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? Math.round(el.getBoundingClientRect().top - box.top) : null; }; return { firedAt: window.__fired ?? null, scrollTop: Math.round(s.scrollTop), fold: at(window.__fold), grown: at(window.__grown) }; })()
ss OUT/after.png
wait 2000
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? Math.round(el.getBoundingClientRect().top - box.top) : null; }; return { settled: true, scrollTop: Math.round(s.scrollTop), fold: at(window.__fold) }; })()
ss OUT/settled.png
quit
LAB
