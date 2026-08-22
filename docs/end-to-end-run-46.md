# End-to-end run 46: run 45's walk on the app anybody runs

Release build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`. Run 45's
arrangement and run 45's scripts, in `docs/end-to-end-45/` where they already
live: one pane, nothing paging, a reader wheeling up while a second client
reacts to lines they have read past.

Four walks, two arms of two, and two release builds two minutes each.
`release-records.txt` is what they printed.

## What was owed

#612 fixed #611 and run 45 walked it, on the debug binary against Vite. What
that leaves is the question #599 exists to ask: the app anybody runs is a
different build — React in production, the frontend minified and bundled into
the binary, no `StrictMode` mounting every effect twice.

## The build, and the one thing it costs

`VITE_PROBE=1 VITE_SWATCH=1 npm run tauri build -- --no-bundle`. Both have to be
set at build time: the release frontend is inside the binary, so a probe the
build did not compile in is one the walk cannot switch on — and this walk's
reactor fires on the probe. `WINDOW=--release` is what points `walk.sh` at it.

So this is the release build *of the frontend the walk needs* rather than
literally the artefact a user downloads. What separates the two is a branch the
minifier drops and a stripe painted down the left of every message; neither is
on the path #611 is about.

## What the four walks read

| arm | the pane, parked | settled | growths held | moved | unreadable |
|---|---|---|---|---|---|
| with the fix | `818..839` | `706..722` | **12 of 12** | 0px | — |
| with the fix | `819..840` | `708..726` | **11 of 11** | 0px | 1 |
| `main` | `818..839` | `699..714` | 6 of 9 | **84px** | 3 |
| `main` | `818..839` | `699..715` | 7 of 11 | **112px** | 1 |

Twelve reactions in every walk. Three of the four parked on the identical band,
and the fixed arms settle seven to nine messages newer than the control ones —
the reader who was not paid ends further back in the conversation, as they did
on the debug build.

**The defect is on the release build and the fix answers it there.** That is the
whole of what this run was for.

## What the release build changed about the instrument

Two things, and both are the release build being a browser rather than the model
being wrong.

**It lays out at fractional pixels.** A row of chips measuring 28 is paid 26,
and a reader held to the pixel reads two pixels lower. `moved.py` compared the
two numbers for equality, so the first release walk reported a debt of 28px for
a reader who had not moved at all. Paid is now read off the reader — the same
message at the fold, drawn where it was — with two pixels of slack, and the
debug walks are unaffected: every commit in run 45's records paid `+0` or `+28`
and nothing in between.

**A wheel notch and a row of chips can land in the same commit.** The pane then
moves by neither nothing nor the growth, the message at the fold changes because
the reader went looking for it, and the commit says nothing about who moved
whom. Those are counted apart now rather than called a displacement: one in
three of the four walks, and three in the other. Run 45's debug walks have none
— a notch every 120ms and the commits fall between them — which is why the
question never came up.

Both are the same lesson from opposite ends: **an instrument calibrated on the
debug build is calibrated on a build that rounds.**

## What this run claims, and what it does not

It claims #611 and #612 on the release build, twice each way.

- **The reaction is still one of three doors.** A preview finishing and a
  delivery failure gaining its reason are named in #611 and neither is walked,
  on either build.
- **The probe is in this binary.** A release build without it has never been
  walked, and cannot be by this instrument.
- **Nothing here is about the resize.** #613 is a different arrangement and the
  lab is where it stands.

`docs/measurements.md` has no figure at stake: nothing here is a startup, memory
or size figure, and the release build is the walk's subject rather than its
yardstick.

## What the harness learned

- **A control build is worth its two minutes even when the answer is known.**
  The release fixed arm alone would have said the reader holds, which is also
  what a walk that reached nobody says. The control moved them 84 and 112px and
  that is what makes the zero mean something.
- **`moved.py` was measuring the pane and calling it the reader.** Comparing the
  growth against the payment is arithmetic about the app; the reader is a
  message and a y. The rewrite says the same thing on the debug build and a
  different thing on the release one, which is how a loose instrument shows
  itself.
- **The parking is the same 60 notches on both builds**, and the painted band
  came out `818..839` in three walks of four. Run 40's 305 notches was a release
  figure too, and holds across builds for the same reason: the notch is the X
  server's and the content is the seed's.
