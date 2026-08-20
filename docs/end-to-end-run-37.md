# End-to-end run 37: the band over the top of the timeline

Run 36 left one thing written down rather than answered. A click on a chip at
y≈105 sent nothing at all, and the run put that down to the sticky author band
having taken it — which would mean a control on the topmost row cannot be
reached by pointer. That reading was corrected before this run started
(`67862d9`): `StickyAuthor` has carried `pointer-events-none` since `b8bae22`
drew it, and that commit is behind both builds run 36 walked, so the band was
never a candidate.

This run measures what the band does instead. The short of it: **it hides a
control without disabling it.** A reaction chip under the band can be missing
from the window down to a two-pixel sliver, and a click on the part that is not
drawn reacts, counts the reader in, and puts a `TAGMSG` on the wire.

## Two instruments, because the question has two halves

**What overlaps what** is geometry, so it is asked in Chrome, where there are
selectors and `elementFromPoint`. `seed.mjs` gains `#band`: sixty lines from one
nick inside one run window, which `buildRows` makes a single block taller than
the pane — the only shape that draws the band at all, since it appears when a
block's head has gone past the top edge and the rest of it has not. Two
reactions sit on the thirtieth line, adjacent, because "the pointer fell between
two chips" is the other answer run 36's symptom has. `probe.txt` is the driver
script.

**What a pointer reaches** is the assembled app, so it is asked in the window
against `ergo` 2.19 on `127.0.0.1:6677`, with three sockets in the channel.
`walk.py` is run 36's, with the rewriting proxy taken out: this run needs a
server that tells the truth. One peer says sixty lines, two react to four of
them, and **the third-party socket is what the results are read off** — ircx's
own timeline draws a local copy the moment a control is clicked, so it cannot be
the witness for whether anything was sent.

## What the band covers

The band is `top-0`, the full width of the timeline, opaque
(`bg-[var(--surface-base)]`), and **19.5px tall** against a reaction chip's
**22px**. Measured at three scroll positions on the same chip:

| `scrollTop` | chip | covered | what the reader sees |
|---|---|---|---|
| 917 | 79.7–101.7 | 19.8 of 22 | `chrome-sliver.png` — two grey smudges |
| 906 | 90.7–112.7 | 8.8 of 22 | `chrome-half.png` — chips with their tops sliced |
| 890 | 106.7–128.7 | none | `chrome-clear.png` |

The first row is the worst case and it is arithmetic rather than a sample: the
band cannot hide a chip completely, because it is 2.5px shorter than one. What
a reader gets at the bottom of the band is the chip's last two pixels, which is
the rounded end of a border and no emoji, no count, and no colour.

## What a pointer reaches through it

`document.elementFromPoint` at the chip's centre returns the chip's own span at
all three positions above, and a real pointer — press and release through the
DevTools Protocol, not `el.click()` — lands on the same span. The band is
absent from hit-testing entirely; at a point over its own nickname the element
underneath is the virtualiser's row container.

In the window, on the wire (`wire.txt`, read off marrow's socket):

```text
[126] …;+reply=49pqnwj3…;+draft/react=👍 :marrow!…    ← the peer makes the chip
[133] …;+draft/react=👍;+reply=49pqnwj3… :walker!…    ← ircx, clicked at 355,91
[136] …;+draft/unreact=👍;+reply=49pqnwj3… :walker!…  ← ircx, clicked at 355,91
```

The band there spans y 80–100 and the chip row sat at y≈86–108, so 355,91 is a
point where the chip is drawn over rather than drawn (`band-over-chip.png`, and
`band-over-chip-zoom.png` for the same at 4×). The click reacted. The chip then
read `2` and took the accent outline that means the reader is in it — still with
its top behind the band (`covered-click-counted-you.png`). A second click at the
same point took the reaction back.

So the control is live where it is invisible, in both directions, and nothing
about a reader's aim is being tested: a pointer put anywhere in that band lands
on whatever the band is covering.

## What run 36's click was

Not this. Two ordinary things send nothing at all, and both were reproduced:

- **The gap.** Two chips are 6px apart in Chrome, about 9 screen pixels in the
  window at this scale, and the point between them belongs to the row that wraps
  them rather than to either button. A click at 382,103 — inside the chip row,
  between the chip and the `+` — put nothing on the wire and opened no picker.
- **A coordinate that has gone stale.** This run's first click at the covered
  chip missed for exactly run 36's reason, and it is worth recording because the
  reason is not the band either: four wheel notches had been sent between the
  screenshot the coordinate was read off and the click, and at 1200×800 a notch
  here is **~75px — three rows** rather than the third of a row `SKILL.md`
  describes. The click landed on plain text three rows away and sent nothing.

Which of the two run 36 hit cannot be recovered from its log. What can be said
is that the band was not it, and that y≈105 is below where the band ends in this
run's window — 80 to 100, in the 1200×800 the same harness opens — so the
pointer was under the band's bottom edge rather than inside it.

## What this does not claim

- **That the band should block a click.** The run measures; what to do about a
  control that is drawn over and still live is a design question, and the
  choices — the band takes pointer events, or the scroller stops a row from
  passing under it — are not the same and are not walked here.
- **Anything about the `+` control or the hover toolbar.** The same band covers
  them, and only the chip was clicked through it.
- **Anything about a real network.** One `ergo` on loopback, three sockets that
  parse and none that draws. Same gap as every run since 33.
- **The archive.** No restart; every result is the live path.
