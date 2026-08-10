# The thirteenth run: the page that lands, and the estimate it was corrected for

Run on 2026-08-10 in headless Chrome through `driver.mjs --seeded`, against
`main` at `ecb61b5`. Not the assembled app: nothing here is the Rust side's, and
the defect is a scroll container's arithmetic, which Chrome answers about and a
screenshot does not.

Run 12 measured two things moving the reader and #478 fixed the smaller one.
This is the larger, split out as #477: a page of history landing moves the
timeline under the reader by **228px**, and the shift scales with the page.

## The walk

`end-to-end-13/anchor.sh`, and `table.py` beside it renders what comes back.

`#long` holds 300 messages, which the seed answers in a first page of 200 and a
second of 100. The pane is parked at `scrollTop 700` — above `LOAD_OLDER_PX`, so
nothing is asked for — and left long enough for the virtualiser to render that
window, so the row the walk marks is one that stays mounted. `load_history` is
delayed 1500ms inside the page so the page lands on a commit of its own, and
`page_back` is answered `false`, the seed having no handler for it. Then
`scrollTop 300` asks for the page, and a `requestAnimationFrame` sampler keeps
every frame where anything moved.

`markY` is the marked row's top relative to the scroller's viewport. It is where
the reader sees it, and holding it still across a landing is the whole of what
the anchor is for. A frame where `markY` moves and nobody scrolled is a frame
the reader did not ask for.

## What it did, before

```text
     t  scrollTop  scrollH   sizer  head    markY  moved
     0        700     9941    9941     0    260.5
   319        325     9966    9941    25      660  +399.5
  1839       5021    14890   14865    25      888  +228.0
  2056       5141    15010   14985    25      888    +0.0
```

At 319 the walk scrolled -400 and the mark moved +399.5, which is the reader's
own scroll and #478 holding the head still through it. At 1839 nobody scrolled
and the mark moved **+228**, and it never comes back.

## Why

A probe either side of `usePrependAnchor` on the commit the page lands in, of
the two numbers that disagree:

| | `scrollTop` | `el.scrollHeight` | `getTotalSize()` |
|---|---|---|---|
| the commit before | 325 | 9966 | 9941 |
| the landing, before the anchor | 421 | 14566 | 14865 |
| the landing, after the anchor | 5021 | 14566 | 14865 |
| the commit after | 5021 | 14890 | 14865 |

Two things are in that table and the anchor was reading the wrong one of them.

**The DOM is a commit behind.** The sizer's height is `getTotalSize()` as it
read during render, and the rows measured in this commit's ref callbacks — which
run before any layout effect — are not in it. `el.scrollHeight` says 14566, the
virtualiser says 14865, and 14890 is what `scrollHeight` becomes on the very
next commit. The old shape added `14566 - 9966 = 4600`; what the page occupies
is `14890 - 9966 = 4924`. The 324 between them is the estimate error of the
whole prepended block, `ESTIMATED_ROW_PX` being 46 against rows averaging 48.87.

**Part of it was already paid.** `scrollTop` is 421 at the anchor rather than
the 325 the reader left it at: the virtualiser corrects the position itself for
rows it measures above the fold, and had already put 96 back. So of the 324, the
reader is short 228 — which is the shift, to the pixel.

## The fix, and what it measures

The anchor now asks the virtualiser where a message's row is rather than asking
the container how tall it has become, and puts the reader back at that offset.
An offset cannot be wrong about an estimate the way a height difference can, and
being a position rather than a delta it subsumes whatever the virtualiser
already did on the same commit.

```text
     t  scrollTop  scrollH   sizer  head    markY  moved
     0        700     9941    9941     0    260.5
   332        325     9966    9941    25      660  +399.5
  1850       5249    14890   14865    25      660    +0.0
  2008       5321    14962   14937    25      660    +0.0
```

5249 is `325 + 4924`, which is where the reader was plus what the page occupies.
Nothing in the cycle moves them now: not the head arriving, not the landing, not
the measurements that settle after it.

Two things had to be right for that, and each was wrong first.

**`getOffsetForIndex` reads a cache rather than the measurements.**
`getTotalSize` goes through `getMeasurements()`, which recomputes; the offset
call reads `measurementsCache` as it stands. Asking it directly on the landing
commit returned 4914 where the answer is 5238, and the walk moved **+324** — the
estimate error entire, the worst reading of the three. `getTotalSize()` is the
public call that refreshes it, so `Timeline` makes it for the side effect.

**One pass is not enough when the estimate is far out.** The offsets are current
on the landing commit and the DOM is not, so the frame that paints is short by
whatever was measured between the two. Asserting the same place again on the
commit after costs nothing when the estimate was close and is the whole of the
correction when it was not:

| `ESTIMATED_ROW_PX` | before | one pass | two passes |
|---|---|---|---|
| 46, as shipped | +228.0 | +0.0 | +0.0 |
| 92, the control | -680.0 | -102.0 | +0.0 |

The 92 row is the control #477 named, and it is the reason to trust the table
above: doubling the estimate and changing nothing else used to throw the reader
680px *up* the timeline, the correction overshooting instead of falling short —
far enough that the marked row ended at `markY -20`, off the top of the pane. It
now moves them nowhere at all, which is what says the shape no longer depends on
the estimate being any good. #477 read -679.5 for that cell on the shape before
#478; this run reads -680.0 on the shape after it, which is the head holding
still and the estimate doing the rest.

The second pass declines if `scrollTop` is not where the first left it. A reader
who scrolled in that window owns the pane, and putting them back would be the
defect rather than the fix.

## What it leaves

- **A page that merges into the row the reader is inside.** The anchor names a
  message and is put back by the row holding it, so a page whose last messages
  join that row leaves the message lower inside it than it was. A merge itself
  is covered — `Timeline.test.tsx` prepends a page into the top block and the
  pane holds — but there the reader is two rows below it. Being inside the first
  row rather than near it is the case nothing stages, and it is bounded by one
  row where the shape it replaces was wrong by the whole page.
- **A row measured for the first time far below the fold.** Everything here is
  about rows above the reader. The virtualiser's own rule covers what is below
  and this run gives no reason to doubt it.
- **The assembled app.** This is Chrome against Vite, so it is the frontend's
  arithmetic and not WebKitGTK's. Run 12 walked the same cycle in the window and
  read +24 at the landing, where ergo's rows sat about that far from the
  estimate; the same walk there now is unwalked.
