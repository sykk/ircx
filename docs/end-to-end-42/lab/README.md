# The lab: the frontend in a WebKitGTK view, with selectors

`window.mjs` drives the assembled app and is blind — no selectors, a screenshot
and a coordinate. `driver.mjs` has selectors and drives Chrome, which is not the
engine anything ships on. This is the third corner: **the real frontend, in
`webkit2gtk-4.1` — the library Tauri links — with `evaluate_javascript` behind
it.**

    npx vite --config docs/end-to-end-42/lab/vite.lab.config.mjs   # prints a URL
    printf 'wait 2200\njs lab.open("#merge")\nwait 2500\nss /tmp/shot.png\nquit\n' \
      | python3 docs/end-to-end-42/lab/lab.py http://localhost:5173/ --zoom 1.0

`lab.py` takes the same kind of script `window.mjs` does — `js`, `ss`, `wait`,
`quit` — plus real XTEST input (`wheel`, `click`, `key`, `type`) through the
harness's own `xsend.c`, compiled beside it:

    gcc -O2 -o docs/end-to-end-42/lab/xsend .claude/skills/run-ircx/xsend.c -lX11 -lXtst

`merge-seed.mjs` puts run 40's channel — 1009 lines, runs of sixty, a
declaration every hundredth and an address every thirteenth — on the driver's
own seed, and adds `window.lab`: `open`, `top`, `scrollTop`, `column`, `paint`,
and a `hold` that makes a page-back land on a pane at rest the way the proxy
does. `wheel-walk.sh` is run 40's arrangement in it; `screen.py` compares what
the engine painted against what the DOM says is there.

**What it is for, and what it is not.** It reproduces layout, scrolling and
paging in the shipping engine, and it answers questions no screenshot can. It
did **not** reproduce #602 — the panes painted every message the DOM held over
jumps of 5.7k, 7.2k and 13.9k pixels — because #602 was never in the engine.
That is worth knowing before reaching for it: a defect the assembled app has and
this does not is a defect in what the app hands the frontend, not in what the
frontend hands WebKit.

Two things it needs that are not obvious. The view is **ephemeral** — WebKit
keeps local storage per data directory and the app keeps its pane layout there,
so a shared one hands the next run the panes the last one split. And the display
is set **before `gi` is imported**: GDK reads `WAYLAND_DISPLAY` when it
initialises and prefers it, so a window that should be on `Xvfb` opens on the
operator's screen instead.
