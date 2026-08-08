# The sixth run: a theme off the disk, seen

Run on 2026-08-03 against a local `ergo` on `127.0.0.1:6667`, in the assembled
app on `Xvfb :90`.

`docs/manual-verification.md` listed five things about an installed theme that
nothing had exercised, and gave the reason for one of them: *"Headless Chrome
does not draw either, so nobody has seen it take effect."* The window harness
draws in WebKitGTK against a real app data directory, which is the whole of what
was missing.

Four of the five hold. The fifth is #364.

## What holds

**A theme copied in while the app is running appears without a relaunch.**
`src/styles/themes/ircx-light` copied to `<profile>/themes/harbour` with a name
of its own, and four seconds later it is in the palette —
`01-installed-appears.png` — reading `light · the themes walk · 1.0.0`. The
two-second poll in `src-tauri/src/themes.rs` finds it, and the sheet's own line
("copy one in and it appears here without a relaunch") turns out to be true.

**It draws.** `02-drawn.png`: the whole window in the theme's light palette,
from two files the backend read off the disk.

**An edit to its stylesheet lands within the poll.** `--surface-sidebar` changed
from `#f6f8fa` to `#ffe0b2` in the installed `theme.css`, and the sidebar, title
bar and status bar all follow — `03-hot-reload.png` — with nothing restarted.

**Deleting the theme in force falls back cleanly.** `rm -rf` on the directory
while it was the theme in use, and the window is the built-in dark one five
seconds later — `04-deleted-falls-back.png`, not a half-styled window, which is
what the entry was written to check.

**An edit to a token survives a restart.** `--surface-base` set to `#10233b`
through the appearance editor — "1 of the author's 63 tokens changed" — and it
is still there after a relaunch on the same profile
(`05-edit-survives-relaunch.png`). The overrides are keyed by theme id and
`applyOpeningTheme` reads them before the first paint, which is exactly what
that was built for.

## What does not: the opening paint

The same relaunch answers the question the entry actually asked — *the window
should not flash the theme's own value first* — and the answer is worse than the
question. It does not flash the theme's own value. It flashes **the built-in
dark theme**.

`ffmpeg` on the Xvfb display at 30fps through a cold start, sampling the mean
colour of the conversation area:

```text
installed theme, one token edited to #10233b
  t=1.27s  rgb(255,253,255)   nothing painted yet
  t=1.50s  rgb(10,13,18)      <- ircx-dark, ~130ms
  t=1.63s  rgb(25,42,66)      the theme, settling to the edit

built-in ircx Light, same profile, same run
  t=1.27s  rgb(255,253,255)   and stays
```

The control is what makes it a defect rather than a fact about webviews. A
built-in theme paints its final colour and stops. An installed one paints
ircx-dark for about an eighth of a second first, and on a light theme that is
the entire window going dark and back on every single launch.

`session.ts` says why, and has said so all along: *"A theme installed on disk
cannot be read synchronously; it lands a moment later, when `startThemes`
resolves."* `applyOpeningTheme` builds its catalogue from the built-ins, finds
nothing called `harbour`, and calls `applyTheme(null)` — which by design
uncovers the dark theme `global.css` imports statically. That is the floor
working. It is just that the floor is visible for 130ms.

**The fix is the one the file already made for edits.** Those live in
localStorage precisely so the window does not "paint the theme first and the
edits a frame later". The theme's own two files are now kept the same way, and
`applyOpeningTheme` opens the catalogue with them.

The source is kept rather than the tokens it parses to, so `catalogue` validates
what comes back out of localStorage exactly as it validates what the backend
sends. A cache of already-parsed tokens would be a way around the gates
`overrides.ts` spends forty lines describing, and localStorage is a text file
anyone can edit.

Recorded again with the fix, everything else identical:

```text
  t=1.27s  rgb(255,253,255)   nothing painted yet
  t=1.47s  rgb(17,34,58)      the theme, first paint
```

The `rgb(10,13,18)` frame is gone.

## What the harness needed

**`window.mjs --profile <dir>`.** Every run seeded a fresh profile, so nothing
that only matters across a restart could be asked at all — and "install a theme,
edit a colour, relaunch, and the edit should be there" is one of several
entries in `manual-verification.md` written in exactly that shape. A run can now
be pointed at a profile a `--keep` run left, and nothing is seeded the second
time.

**Recording the display rather than screenshotting it.** A flash of 130ms is
four frames; `import` cannot catch it and a screenshot taken after the fact says
nothing. `ffmpeg -f x11grab` on the Xvfb display, cropped to the conversation
area and scaled to one pixel, turns the first two seconds into a list of colours
with timestamps. That is what made the built-in control possible, and the
control is what turned "the window looks wrong for a moment" into a defect with
a boundary.

**Take the display from the harness, never from a glob.** The first attempt
picked the first socket in `/tmp/.X11-unix`, which is `X0` — the operator's real
screen. Nothing was captured, because the shell running it was killed first by a
`pkill -f` matching itself, which is the hazard SKILL.md already documents. The
display now comes from watching for a socket that was not there before, and `:0`
is refused by name.

## What this run did not reach

- **`color-scheme` against native controls.** The manifest's `appearance` is
  written to the root element and the walk confirms the root attribute, but
  nothing here has a native scrollbar or a form control in view to see flip.
- **A theme that arrives while the palette is open.** The poll republishes the
  whole directory; what the palette does with a list that changes under an open
  selection is not something this run tried.
