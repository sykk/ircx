# End-to-end run 41: the rows are where they should be

Release build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`. Run 40's
arrangement and run 40's scripts — `docs/end-to-end-40/run.sh`, one run, three
arms — with the stack probe added.

## The question run 40 left

> **Does not.** Why. Nothing here separates a row drawn at the wrong offset from
> a row that measured wrong to begin with, and the probe records carry the
> anchor's own terms rather than the virtualiser's.

#602 named what would answer it: a record of each drawn row's `data-index`, its
transform and its measured height, on the commits after a landing. That is
`probe("stack", …)` in `scrollAnchor.ts`, and this run is the first to carry it.

**Every arm of this run is the `probe` binary.** Only that build writes records,
and the question is the records, so the two extra release builds `builds.sh`
makes were not made. The arm names in the output are the slots `run.sh` fills,
not three different binaries; the ship/control distinction means nothing here
and nothing below rests on it. What the three arms are is three walks.

## What the records say

The whole of the settled stack, the pane that asked, `ship/run1`:

```text
  i  0 top=     0 h=   56 says=  0
  i  1 top=    56 h=   56 says=  0  gap=+0
  i  2 top=   112 h=  623 says=  9  gap=+0
  i  3 top=   735 h= 4244 says= 60  gap=+0
  i  4 top=  4979 h= 1381 says= 20  gap=+0
  i  5 top=  6360 h= 2794 says= 40  gap=+0
  i  6 top=  9154 h= 4244 says= 60  gap=+0
  i  7 top= 13398 h= 4099 says= 60  gap=+0     <- the block the page merged into
  i  8 top= 17497 h= 2893 says= 40  gap=+0
  ...
  i 17 top= 42060 h=   56 says=  0  gap=+0
```

Three readings, and all three are the answer to a different half of #602.

**Every row starts where the one above it ends.** `gap=+0` for all eighteen, in
every settled record of every arm. A row drawn at an offset computed for a
different height is what run 40 proposed and it is not what the pane is doing.

**Every row is the height of what it holds.** 4244px for 60 messages, 2794 for
40, 1381 for 20, 623 for 9 — 69 to 71px a message throughout, which is a `MEDIUM`
body wrapping to three rows at this width. The merged row is 4099px for 60, the
shortest of the six sixties in the window and inside their spread of 4099–4260.
It is not a row measured for fifty.

**The block holds all sixty.** `says=60`, and `buildRows` says the same: the
window is `line0410..line0419` at 10, then 60, 20, 40, 60, and `line0600..
line0659` at 60. Row 7 is that block, `first` and `last` are its outer messages,
and nothing is absent from it.

The landing commit is not clean and does not stay that way. On the commit the
page lands in, rows are placed 296 to 4214px from where they stack — the whole
window at the estimate — and by two commits later every arm reads `gap=+0` and
holds it. **The arithmetic corrects itself and the screen does not.**

## What the screen says

The same walk, thirty seconds later, the pane those records came from:

```text
    heap
    archivist 12:22
    line 0600 ack
    line 0611 the reader is
```

`docs/end-to-end-41/dropped.png`. Lines 0601 to 0610 are not on the screen, and
**there is no space where they are missing from** — 0600 and 0611 are drawn
25px apart, one line, the same gap as every other pair in the block. Ten
messages are absent from the flow rather than covered by anything, in a row
whose measured height counts them.

The other two arms have run 40's other shape, `docs/end-to-end-41/reordered.png`:

```text
    line 0600 ack        line 0600 ack
    line 0613 … 0619     line 0615 … 0619
    line 0601 …          line 0601 0602 0603 …
```

0600, then a stretch from a dozen messages further on, then back to 0601 — which
is `control/run1` of run 40 (`0600`, `0615` to `0618`, `0601` to `0604`) twice
over. Both read `gap=+0` too, and row 7 is the same 4099px holding the same 60 in
all three.

**Three walks, three reproductions.** No arm drew the block whole, and no arm's
settled records were anything but exact.

## The reading

**The two panes are drawing the identical DOM and only one of them is wrong.**
Every row's index, transform, height and message count is equal between them,
`first` and `last` msgid included; the two differ in `scrollTop` alone, 13327
against 14836. The right pane draws 0622 to 0629 unbroken out of that row while
the left pane drops ten of its lines.

So the app computes the right answer. `buildRows` puts sixty messages in the
block, React renders sixty, the row measures the height of sixty, and the
virtualiser places it exactly where the row above it ends — and WebKitGTK paints
a region of it with content that belongs to a scroll offset the pane no longer
has. The lines the frames show in that region, 0611 in one arm and 0613–0619 in
the other, are the lines that occupied those pixels **before** the anchor moved
the pane 13327px to hold the reader.

That is a repaint the engine did not do, not a number this app got wrong, and it
is why the frame is byte-identical thirty seconds later: nothing invalidates it.

## What this run claims, and what it does not

**Claims.** In run 40's arrangement, on the commits after the page lands and for
as long as the pane is left alone, every row the asking pane draws is placed
where its neighbours' measured heights put it, is the height of the messages it
holds, and holds all of them — while the screen omits ten of those messages or
draws them out of order. #602 is not the row's height and not its transform.

**Does not.** That the stale region is a tile, or name the invalidation that is
missing. The records prove the DOM; the pre-landing content appearing at
post-landing offsets is what the two frames show and is inference from them.

**Does not, either.** #601. The parked pane's anchor reads `moved` then
`holding` then `settled` and its `scrollTop` does not change again, but its
`now` message changes from `grps6c` to `uz3uzx` on the landing for a reason that
is not displacement: `messageAtOffset` names a row by its *first* message and
the merge changed which message that is. The records as they stand cannot tell a
reader who moved from a row that was renamed under them. What run 41 does add is
a caution — **run 40's table was read off frames, and this run shows this pane's
frames misreporting its own content by ten messages.** A displacement read that
way wants a records-side confirmation before it is trusted to the pixel.

## What the harness learned

- **A walk that only needs records needs one build.** Three arms of the probe
  binary is three walks in the time `builds.sh` takes to make the other two, and
  the frames the ship build would have given are already in run 40.
- **`says` is worth recording next to `h`.** It is what separated "the row is
  short" from "the row is whole and the paint is not", and neither height nor
  transform alone could have.
- **The landing commit is always wrong and that is not the defect.** Every arm
  shows the whole window at the estimate for one commit. A probe that sampled
  only the landing would have reported run 40's proposed mechanism and been
  wrong about the settled pane.
