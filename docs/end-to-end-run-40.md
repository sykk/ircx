# End-to-end run 40: the neighbour inside the row a page merges into

Release build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`.
Scripts in `docs/end-to-end-40/`; `run.sh` is the whole of it.

## The question

`docs/manual-verification.md` has carried this since #539 shipped:

> **What no walk has watched is still the release app.** The model is where the
> 744px was read, and the model had to be corrected to read it — its
> `ResizeObserver` never delivered the entry a browser delivers on observing, so
> every row remounted under a new key kept its estimate. A walk of this wants a
> seed that speaks in runs of twenty or more, so that a pane can be parked inside
> one block and be a neighbour without being the asker.

That is the one arrangement run 31 could not make, and #538's fix was written
against a jsdom model of it alone. This run is the arrangement.

## What it took to arrange, which is three findings before any reading

**A seed that speaks in runs of sixty.** A pane is only a message tall from the
top of its content where a row is a message tall. The band a reader can be parked
in and still be a neighbour — past `LOAD_OLDER_PX` at 400 and inside the row the
page merges into — exists only where the window's first row is taller than that,
and run 23's four-line runs put every parked pane either at the top of its own
content, where it asks for the page itself, or below anything the page can
redraw. `seed.py` here is run 23's with the speaker function changed, and its
topic declared every hundredth line rather than every fortieth: a declaration
ends the run open above it, so the fortieth was cutting the row back to 950px.

**One launch, because a restored window cannot express the case at all.** Run 31
seeds a profile with a first launch and restores it with a second, which is
#508's own shape. A restored window is `localArchive` and a page-back is
`serverHistory`, and `rows.ts` closes the open run where the source changes:

```ts
const history = message.source === "serverHistory";
if (history !== inHistory) { inHistory = history; open = null; ... }
```

So a page landing above a restored window can never merge into the reader's row —
the source changes at exactly the line it would merge at. Two walks were spent
before this was noticed, both reading "the reader held" on both builds: the row
under the parked reader gained the arriving group's name and not one of its
messages, and `tookIn` read 16px where a merge is hundreds.

**A parking calibrated per set, and a first page waited out.** A notch is 84px in
this window, which is neither of the numbers run 31 measured, and the pane a
split has just made asks for a page of its own — it sits at the top of its
content for the commit before the follow scroll moves it. That ask is held by the
proxy like any other, so the walk waits it out before parking anything, which is
also what puts the boundary this run is about inside the window rather than at
its edge. `pick.py` brackets the parking with two frames and rejects a walk whose
parked pane asked; four of the calibration walks were rejected that way.

## The arrangement

1009 lines, three speakers in runs of sixty, a topic declared every hundredth.
Two pages land before the one being measured — the join's `LATEST 200` and the
split's own — so the window opens at line 0610, fifty lines into the run that
goes 0600 to 0659. The page-back then brings 0600 to 0609 into the row the reader
is sitting in, which `buildRows` says as a block of 50 before and 60 starting ten
lines earlier after.

The right pane is parked 305 notches up, which lands it 1100–1400px into that
row: past `LOAD_OLDER_PX`, so it is not the asker, and inside the row, so the
merge reaches it. The left pane then wheels to the top and asks, and
`latepage.py` holds the answer for forty seconds — run 31's in-time hold, inside
`ROUND_TRIP_TIMEOUT`, so the client is still waiting when its page lands.

## The arms

| arm | what it is |
|---|---|
| `ship` | `npm run tauri build -- --no-bundle`, no probe: the binary anybody gets |
| `probe` | the same with `VITE_PROBE=1`, so every commit writes a record |
| `control` | that build with #539's term taken out of the hold's exit |

The control is one boolean: `scrollAnchor.ts` ends the hold when the container
has stopped growing *and* the reader's own row is a height the virtualiser knows,
and #539 is the second half. Taking it out is the build the 744px was reported
on, with the measurement left in so both arms compute the reader's line the same
way.

## What held

Two sets. The first shared one channel across nine walks and drifts run by run —
every walk joins and quits and leaves both in the history, so the boundary the
arrangement is built on moved two lines a walk and the last run of it was
measuring something the parking had not been calibrated for. `run.sh` seeds a
channel per run now, and the second set is four runs of three arms on four fresh
channels.

Read off the frames, in the line numbers the seeder writes into every body: the
message at the top of the parked pane before the page, in the frame after it, and
in the last frame of the walk — thirty seconds on, nothing else happening.

| run | ship | probe | control |
|---|---|---|---|
| 1 | 0630 → 0622 | 0632 → 0619 | 0633 → 0614 |
| 2 | 0630 → 0624 | 0632 → 0622 | 0633 → 0621 |
| 3 | 0630 → 0624 | 0632 → 0622 | 0633 → 0620 |
| 4 | 0630 → 0626 | 0632 → 0624 | 0633 → 0623 |

**Every walk of twelve moved the parked reader, and every one of them stuck** —
the settled frame and the frame a second after the landing are the same picture
in all twelve. The arms open on the same line as each other run for run, which is
what says the parking is repeatable; the two lines between them are the probe's
own weight on where a burst of 305 notches stops.

In messages that is four to eight for the build that ships and ten to nineteen
for the control. In pixels it is more than it sounds: a `MEDIUM` body wraps to
three rows at this width, so a message is about 72px and the shipped build is
leaving the reader **250 to 580px** from where they were reading. The control is
700 to 1400px.

**So #539's term is doing something and is not enough.** It was written to hold
the reader until their own row is a height the virtualiser knows, and the walk
with it out moves them two to three times as far — but the walk with it in moves
them too, on the binary anybody runs, in the arrangement the model asserts a
hold for.

## The thing the frames show that no reading was looking for

The asking pane, settled, on all four `ship` walks of the second set:

```text
    heap
    archivist 08:33
    line 0600 ack
    line 0611 the reader is
    somewhere above this line
```

**Ten messages are not drawn.** `line 0601` to `line 0610` crossed the wire
exactly once each — `grep -c` on the walk's own `wire.log` — and the pane's last
record says it holds 601 messages. The block above them draws, the block below
them draws, and the pane beside it draws its own stretch of the conversation
unbroken. The four walks skip 0601–0610, 0603–0610, 0603–0610 and 0605–0610: the
run of missing lines starts where the frame's first visible line ends and stops
at 0611 every time.

Thirty seconds after the landing, with nothing else happening. Not a frame caught
mid-commit: the last frame of the walk is the same picture as the one taken
twenty-eight seconds earlier.

The first set has the other shape of it. `control/run1` there draws `0600`, then
`0615` to `0618`, then `0601` to `0604` — the same messages, in an order neither
the wire nor the store put them in, with the pane beside it drawing `0614` and
then `0619`. A row drawn at an offset the virtualiser computed for a different
height would do both: cover the rows under it, and put its own lines where the
covered ones should be.

## What this run claims, and what it does not

**Claims.** In the arrangement `manual-verification.md` has carried as unwalked —
a neighbour parked inside the row an arriving page merges into — the release app
moves that reader, permanently, in twelve walks out of twelve; #539's term
reduces the distance by roughly half and does not close it; and the pane that
asked for the page can be left drawing a block with ten of its messages missing
from the screen.

**Does not.** Why. Nothing here separates a row drawn at the wrong offset from a
row that measured wrong to begin with, and the probe records carry the anchor's
own terms rather than the virtualiser's. `tookIn` is the term that moves with the
outcome — 254 in the walks of the first set that drifted and 1392 to 1772 in the
ones that held — and what it reads is `lineWithinRow` against a DOM on the commit
the page lands in, which is the one commit `scrollAnchor.ts` says is a render
behind. That is a lead, not a mechanism.

**Does not, either.** Whether the model is wrong about this case or right about a
different one. `Timeline.layout.test.tsx` parks a second pane in the same
arrangement and asserts the reader holds to the pixel, and it passes. What the
window says is that something between the model and WebKitGTK is not the same
arrangement, and #599 — the harness reporting a shortfall the window does not
have — is the other end of the same question.

## What the harness learned

- **A restored window cannot merge with a page.** `rows.ts` closes the open run
  where `source` changes, and a restore is `localArchive` under a `serverHistory`
  page. Any walk of a merge has to happen inside one session, which run 31's
  two-launch shape cannot do.
- **A split asks for a page nobody asked for.** The pane it makes sits at the top
  of its content for a commit, and asks. Under a proxy that holds page-backs it
  is held like any other, so a walk that does not wait it out has a landing it
  did not schedule in the middle of its window.
- **Seed a channel per run.** Nine walks of one channel move the page boundary
  fourteen lines, and the parking is calibrated against where that boundary is.
- **A notch is 84px here**, which is neither of the two numbers run 31 measured.
  Calibrate per set: `park.sh` does it in a fifth of the time a walk takes.
