# End-to-end run 42: the messages are in the wrong order

Release and debug builds, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under
`Xvfb`. Run 40's arrangement — two panes on one channel, one parked inside the
block an arriving page merges into, the other taken to the top so it asks — with
the page held by `docs/end-to-end-30/latepage.py` so it lands on a pane at rest.

## What run 41 left

> **That leaves** WebKitGTK painting a region of the pane with content belonging
> to a scroll offset it no longer has.

It does not. #602 is this app handing the engine the wrong list, and the run
that measured every row's height, transform and message count never asked the
question underneath them: **what order the messages are in inside a row.**

## The reproduction, twice over

`docs/end-to-end-40/parked.sh` on a `VITE_PROBE=1` release build reproduced it on
the first walk: the asking pane settles drawing `line 0607` and then `line 0611`,
and holds that picture for sixteen frames over thirty-two seconds. `stack.py`
reads `offsets_wrong=0` on every settled commit, which is run 41's finding
reproduced on this machine.

The **debug** build does it too — `line 0601` then `line 0611` — and that is what
made the rest of the run affordable: a debug binary fetches the frontend from
Vite, so a candidate costs a walk rather than a walk and a five-minute build.

## Three things that ruled the paint out

**The picture moved 24px while the pane moved 13725.** `paneshift.py` over the
asking pane's message column, the frame before the landing against the frame
thirty seconds after: −24px, ten of eleven strips agreeing. The 24px is the
history head leaving. A pane whose `scrollTop` went from 24 to 13749 and whose
picture did not move is a pane drawing a picture that has nothing to do with its
offset — which is what run 41 read as staleness.

**Disabling accelerated compositing changed nothing.**
`WEBKIT_DISABLE_COMPOSITING_MODE=1`, same walk, same channel: `line 0604` then
`line 0612`, −24px with twelve of twelve agreeing.

**Neither did making the pane draw itself again.** A `display:none`, a forced
reflow and a restore on the scroller after every anchor write larger than the
viewport — the heaviest invalidation a page can ask for — left the same step in
the same place. And **one wheel notch twenty seconds later**, a real scroll that
repaints, moved the picture 84px and kept the step: `0600` still followed by
`0611`. Stale paint comes right when something repaints it. This did not.

## The instrument the answer needed

The window is a channel whose lines all look alike, and a walk of the assembled
app has no selectors. So `VITE_SWATCH=1` paints a stripe down the left of every
message in a colour that names it — `rgb(n >> 8, n & 255, 128)` for `line NNNN`
— and `docs/end-to-end-42/sequence.py` reads the stripes down a pane:

```text
-- the pane that asked, last frame --
stripes at x=290, 8 messages painted
y 223: 600 is followed by 611
599..616 painted, 1 steps
```

The seed sends its lines in order and nothing in this walk reorders them, so a
pane painted right reads as a run of consecutive numbers and #602 reads as a
step. The stripes do not mask the defect: the walk they were first run on
reproduced it.

## What the DOM has

The stack probe gained two readings a count could not give — what a row's
messages span, and how many of them have no height:

```text
i7 h=4099 spanned=4053 says=60 zero=0
```

Sixty messages, none of them collapsed, spanning what the row measured. So they
are all there, laid out, taking their own space. Then the order:

```text
i7 lines 600..659 says=60 jumps=3
   run: 600 611-619 601-610 620-659
```

**The block holds all sixty and holds them in the wrong order.** The pane draws
exactly that: `0600`, then `0611`, with the ten messages between them hundreds of
pixels further down the block. The engine was drawing what it was given.

## Why the order is wrong

The wire is in order — `grep` on the proxy's own record shows the held page
arriving `0600` to `0610`, ascending. What is not in order is the clock:

```text
time=2026-08-21T18:04:42.886Z ... :line 0611
time=2026-08-21T18:04:42.886Z ... :line 0612
time=2026-08-21T18:04:42.886Z ... :line 0613
```

**`ergo` stamps at millisecond resolution and a burst is not a millisecond
long.** Nine of the messages in the window share one stamp, and the page that
lands in front of them shares it too — so the timestamp cannot order the two
runs.

`mergeByTime` in `src/store/index.ts` broke that tie towards the window:
`takeFresh` was `fresh < held`, strictly. So the arriving page waited behind
every tied message the window already had, and then went in at the first stamp
that differed — `600`, then the window's `611-619`, then the page's `601-610`,
then `620` onwards. That is the run above, exactly.

## The fix, and the test that fails without it

The merge is given the tie: a batch that is history being read back goes in
front of a message the reader has already been shown at the same millisecond,
and a line somebody just said goes after it. `readBack` decides it from the
messages themselves — `source` is `live`, `serverHistory` or `localArchive`, and
an archive read, a page-back's answer and a gap fill are all history.

Not from the batch's position: a window whose every message shares one stamp —
a fixture, or a channel that took a paste — makes a positional test call every
arriving live message history. That version passed the store's suite except for
one reaction test, which is what caught it.

`src/store/index.test.ts`, "keeps a page in front of the tied stamps it is older
than", builds run 42's arrangement out of nine tied held messages and a page
sharing their stamp, and asserts the order. Without the fix it fails with
`page-600, held-611…619, page-601…610` — **the walk's run, in 941ms, with no
server, no engine and no window.**

## The walks that say it is fixed

The same walk, the same channel shape, on the fixed tree:

| walk | the pane that asked | the parked pane | after one notch |
|---|---|---|---|
| fixed1 | `608..616`, 0 steps | `629..638`, 0 steps | `607..614`, 0 steps |
| fixed2 | `608..616`, 0 steps | `629..638`, 0 steps | `607..614`, 0 steps |
| fixed3 | `608..616`, 0 steps | `629..638`, 0 steps | `607..614`, 0 steps |
| fixed4 | `608..616`, 0 steps | `629..638`, 0 steps | `607..614`, 0 steps |

and no row in any landing of either pane reads `jumps` at all. Before the fix,
every walk of this arrangement read a step, on both builds — `0600` then `0611`,
`0601` then `0611`, `0604` then `0612`, `0607` then `0611`.

`fixed4` is the same walk again after `readBack` was tightened from the batch's
first message to all of them.

**And the parked pane holds to the pixel.** `paneshift.py` over the right pane,
the frame it was parked in against the last frame of the walk:

| | before the fix | after |
|---|---|---|
| run1, order1, base2 | no strip of 14 found | — |
| fixed1, fixed2, fixed3 | — | `+0px`, 14 of 14 agree, spread 0 |

A pane whose picture shares *no strip* with the one before the landing is a pane
whose rows were all redrawn, which is what re-ordering the block under a reader
does. That is #601's neighbourhood and this is not #601's walk — see below.

## What this run claims, and what it does not

**Claims.** In run 40's arrangement, against a server that stamps a burst with
one millisecond, the block an arriving page merges into held its messages out of
order, the pane drew them in that order, and the merge's tie-break is why. The
frames and the DOM agree once the order does.

**Does not.** #601, though it moves it. The parking here is calibrated for the
asking pane's arrangement rather than for a reader inside the merged row, and
the frames are two seconds apart rather than bracketing the landing — so the
`+0px` above is not that issue's measurement. What it does say is that in three
walks of three the parked reader is now held exactly where a walk before the fix
could not find one strip of its picture again, and that the frames of a walk in
this arrangement can be trusted to the message, which is what run 41 warned they
could not be. #601 wants re-walking on its own terms before it is closed.

**Does not, either.** That no engine defect exists anywhere near here. What it
shows is that #602 was not one, and that three of the things a paint bug would
have answered to — compositing off, a forced repaint, a real scroll — left it
exactly where it was.

## What the harness learned

- **A walk of the assembled app can read its own screen.** A stripe per message
  in a colour that names it turns a screenshot into a list, and
  `docs/end-to-end-42/sequence.py` reports a step without anybody reading prose
  off a PNG. Every earlier run in this neighbourhood was read by eye.
- **The debug build reproduces this defect and costs no rebuild.** Six of run
  42's arms were frontend changes; none of them waited on cargo.
- **A frontend in a WebKitGTK view of its own does not reproduce it**, which is
  worth knowing before building one: `docs/end-to-end-42/lab/` drives the seeded
  frontend in `webkit2gtk-4.1` — the library Tauri links — with real XTEST
  wheels, an ephemeral profile and a transparent window, and its panes paint
  every message the DOM has over jumps of 5.7k, 7.2k and 13.9k pixels. It has
  selectors, which the window harness has never had, and it is where the paint
  theory should have died an hour earlier than it did.
- **A count is not a geometry and a geometry is not an order.** `says=60` said
  the messages were there, `spanned=4053` said they were laid out, and neither
  could have found this. `jumps` did.
