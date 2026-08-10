#!/usr/bin/env bash
# The thirteenth run: what a landing page does to the reader.
#
# Parks #long above the trigger, scrolls it into the trigger, and keeps every
# frame where anything moved. Run from a checkout:
#
#     bash docs/end-to-end-13/anchor.sh | docs/end-to-end-13/table.py
#
# markY is the marked row's top relative to the scroller's viewport, which is
# where the reader sees it. Holding it still across a prepend is the anchor's
# whole job, so a markY that moves on the landing frame is the defect.
set -euo pipefail
cd "$(dirname "$0")/../.."

# `load_history` is delayed so the page lands on a commit of its own rather than
# inside the burst that opens the channel, and `page_back` is answered because
# the seed has no handler for it: a second page is short of PAGE_SIZE, which is
# exactly when Timeline asks the server whether anything is behind it.
INSTALL='(()=>{const inv=window.__TAURI_INTERNALS__.invoke;window.__TAURI_INTERNALS__.invoke=(c,a)=>{const bare=c.replace(/^plugin:[^|]*\|/,"");if(bare==="page_back")return Promise.resolve(false);if(bare==="load_history")return new Promise(r=>setTimeout(()=>r(inv(c,a)),1500));return inv(c,a);};return "installed";})()'

# Above LOAD_OLDER_PX, so nothing is asked for yet.
PARK='(()=>{const el=document.querySelector("[data-testid=timeline-scroller]");el.scrollTop=700;return [el.scrollTop,el.scrollHeight,el.clientHeight];})()'

# The mark is whichever row is nearest the middle of the viewport, so it is one
# that stays mounted across the landing.
MARK='(()=>{const el=document.querySelector("[data-testid=timeline-scroller]");const sizer=document.querySelector("[data-testid=timeline-sizer]");const base=()=>el.getBoundingClientRect().top;const at=n=>n.getBoundingClientRect().top-base();const cands=[...el.querySelectorAll("[data-msgid]")];const mid=el.clientHeight/2;const mark=cands.reduce((a,b)=>Math.abs(at(b)-mid)<Math.abs(at(a)-mid)?b:a);const id=mark.getAttribute("data-msgid");const y=()=>{const m=[...el.querySelectorAll("[data-msgid]")].find(n=>n.getAttribute("data-msgid")===id);return m?Math.round(at(m)*10)/10:null;};window.__W={id,t0:performance.now(),frames:[]};const tick=()=>{const h=document.querySelector("[data-testid=timeline-head]");const f={t:Math.round(performance.now()-window.__W.t0),st:Math.round(el.scrollTop),sh:el.scrollHeight,sz:sizer.offsetHeight,hd:h?h.offsetHeight:0,y:y()};const p=window.__W.frames[window.__W.frames.length-1];if(!p||p.st!==f.st||p.sh!==f.sh||p.y!==f.y||p.hd!==f.hd)window.__W.frames.push(f);requestAnimationFrame(tick);};tick();return id;})()'

# Inside LOAD_OLDER_PX, which is what asks for the page.
TRIGGER='(()=>{const el=document.querySelector("[data-testid=timeline-scroller]");el.scrollTop=300;return el.scrollTop;})()'

printf 'goto /
wait 1500
eval %s
click [aria-label="#long"]
wait 2500
eval %s
wait 800
eval %s
wait 200
eval %s
wait 4000
eval JSON.stringify(window.__W.frames)
quit
' "$INSTALL" "$PARK" "$MARK" "$TRIGGER" \
  | node .claude/skills/run-ircx/driver.mjs --seeded
