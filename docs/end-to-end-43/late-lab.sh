#!/usr/bin/env bash
# #608's third conjecture, asked of the engine that ships.
#
#     TREE=<checkout> late-lab.sh <output directory>
#
# `fill-lab.sh` with the stimulus changed, and one thing done to the window
# first. Here the reader has paged nothing back: they have scrolled up in a
# channel that is still talking, and a line arrives stamped behind what is
# already held — a relay, a bridge, or a server whose clock moved.
# `insertionPoint` puts it at its own time, which is inside the run they are
# sitting in.
#
# **The window is made live before the line arrives.** The lab's seed answers
# `load_history`, so everything in it is `serverHistory`, and `rows.ts` closes
# the open run where `source` changes — a live line landing in that window would
# open a row of its own and this arrangement would not exist. Rewriting the held
# messages is the shortest way to the channel this is about: a reader scrolled
# up in a conversation they are living through rather than one they paged back.
#
# **Before the parking, not after it.** The rewrite rebuilds every row — the
# first run of this parked the pane, made the window live under it and found the
# row it had been parked in was gone, with the reader's line and the anchor's
# now the same message. A pane is parked against rows, so the rows have to be
# the ones the walk is going to measure.
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
js (() => { const st = window.__store; const held = st.getState().timelines; const key = Object.keys(held).find((k) => held[k].messages.some((m) => m.id === "g823")); window.__key = key; st.setState({ timelines: { ...held, [key]: { ...held[key], messages: held[key].messages.map((m) => ({ ...m, source: "live" })) } } }); return { rewritten: st.getState().timelines[key].messages.length, key: key }; })()
wait 1500
js (() => { const s = lab.scroller(0); const rows = [...s.querySelectorAll("[data-index]")]; const row = rows.find((r) => r.querySelectorAll("[data-msgid]").length >= 20); if (!row) return "no row is a run of twenty"; const box = s.getBoundingClientRect(); const top = row.getBoundingClientRect().top - box.top + s.scrollTop; window.__row = row.dataset.index; s.scrollTop = top + row.offsetHeight - 100; return { parkedAt: Math.round(s.scrollTop), row: row.dataset.index, holds: row.querySelectorAll("[data-msgid]").length }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const num = (el) => { const m = /line (\d{4})/.exec(el.textContent || ""); return m ? +m[1] : null; }; const at = (el) => Math.round(el.getBoundingClientRect().top - box.top); const drawn = [...s.querySelectorAll("[data-msgid]")]; const fold = drawn.find((el) => at(el) >= 34); const row = s.querySelector('[data-index="' + window.__row + '"]'); const first = row.querySelector("[data-msgid]"); window.__fold = fold.dataset.msgid; window.__anchor = first.dataset.msgid; return { scrollTop: Math.round(s.scrollTop), fold: { line: num(fold), y: at(fold) }, anchor: { line: num(first), y: at(first) } }; })()
ss OUT/before.png
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const row = s.querySelector('[data-index="' + window.__row + '"]'); const above = [...row.querySelectorAll("[data-msgid]")].filter((el) => el.getBoundingClientRect().bottom - box.top < 34); const target = above[Math.floor(above.length / 2)]; if (!target) return "nothing in this row is above the fold"; const id = target.dataset.msgid; const st = window.__store.getState(); const was = st.timelines[window.__key].messages.find((m) => m.id === id); const late = { ...was, id: "late", source: "live", text: "a line said a moment ago and stamped a while back", timestamp: new Date(Date.parse(was.timestamp) + 1).toISOString() }; window.__late = "late"; st.applyEvent({ type: "messagesAppended", answers: null, network: was.network, target: was.target, messages: [late] }); return { behind: id, line: /line (\d{4})/.exec(was.text)[1], stamped: was.timestamp }; })()
wait 1500
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? Math.round(el.getBoundingClientRect().top - box.top) : null; }; const rowOf = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? el.closest("[data-index]").dataset.index : null; }; return { scrollTop: Math.round(s.scrollTop), fold: at(window.__fold), anchor: at(window.__anchor), late: at(window.__late), merged: rowOf(window.__late) === rowOf(window.__anchor) }; })()
ss OUT/after.png
wait 2000
js (() => { const s = lab.scroller(0); const box = s.getBoundingClientRect(); const at = (id) => { const el = [...s.querySelectorAll("[data-msgid]")].find((e) => e.dataset.msgid === id); return el ? Math.round(el.getBoundingClientRect().top - box.top) : null; }; return { settled: true, scrollTop: Math.round(s.scrollTop), fold: at(window.__fold), anchor: at(window.__anchor) }; })()
ss OUT/settled.png
quit
LAB
