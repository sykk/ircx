# End-to-end run 44: the walk #609 owed, and the tie-break it did not need

Debug build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`. Run 40's
arrangement and run 43's instrument, both unchanged: two panes on one channel,
one parked inside the block an arriving page merges into and the other taken to
the top so it asks, with `docs/end-to-end-30/latepage.py` holding the answer
twenty seconds so it lands on a pane at rest.

`docs/end-to-end-43/walk.sh` is run as it stands rather than copied and edited,
because it is the instrument the owed item names. Six walks, three arms of two.

## What was owed

#609 changed which message the anchor holds — the line drawn at the fold rather
than the first message of the row that holds it — and shipped on the model and
on three lab runs. Its own account of what that left open:

> `docs/end-to-end-43/walk.sh` on the assembled app with a control build beside
> it. The landing case is #601's, which #606 already fixed and which this
> changes the anchor's answer for; the model covers it in three tests and the
> lab has not been asked, because the lab's page-back reports paint rather than
> where the reader ended up.

So the question is not whether #609 fixes anything. It is whether the case
somebody else already fixed still holds with the anchor answering differently.

## The arms

| arm | tree |
|---|---|
| `ship` | `main` at 3b89096 |
| `nomerge` | `main` with #606's tie-break out — `git checkout e963c62^ -- src/store/index.ts` |
| `pre609` | `nomerge` with #609 out as well — `git checkout 3b89096^ -- src/components/timeline/Timeline.tsx src/components/timeline/scrollAnchor.ts` |

`pre609` is run 43's control exactly, and it is here because a walk where every
arm holds has measured nothing. All three differences are frontend files and the
debug binary fetches the frontend from Vite, so no arm needed a rebuild — the
`cargo` binary is one build serving all six walks.

## What the six walks read

The right pane is the parked one. `anchor` and `fold` are the two records run 43
added; on `main` they name the same message, which is what #609 predicted would
happen to them.

| arm | anchor | fold | the parked pane, before → thirty seconds after |
|---|---|---|---|
| `ship` | +0px | +0px | `629..638` → `629..638` |
| `ship` | +0px | +0px | `629..638` → `629..638` |
| `nomerge` | +0px | +0px | `629..639` → `629..639` |
| `nomerge` | +0px | +0px | `629..639` → `629..639` |
| `pre609` | +0px | **+547px** | `629..639` → `622..630` |
| `pre609` | +0px | **+618px** | `629..639` → `621..629` |

Two page-backs in all six, which is the walk being in the arrangement rather
than the parked pane having overshot into asking for its own. The fold's `within`
reads `1285 → 1944` in every walk of every arm: the reader's line gains the same
659px inside its row, so it is the same page landing the same way six times.

`records.txt` is the whole of it and `ship-settled.png` against
`control-settled.png` is the picture.

## The control, which is the useful half

`pre609` reproduced run 43 to the pixel — +547px and +618px, the same two
readings, against frames run 40 first read as `0630 → 0622`. The walk still
detects a reader being moved, on this binary, on this seed, with these two
scripts. Everything below rests on that; without it, four arms holding would be
four arms of an instrument that had stopped answering.

## What the run found

**#606's tie-break is not what holds the reader here.** `nomerge` is the merge
order run 43 measured the displacement on, and with #609's anchor in front of it
the reader holds — +0px, twice, and the parked pane painting `629..639` in the
frame before the page and in the frame thirty seconds after it.

This is #609's own argument arriving at a case it did not claim. Its account of
a gap fill and a line stamped behind what is held was that both "land in front of
the message at the fold however far behind the row's first message they land",
so `movedInList` becomes true and the correction that already exists runs. A page
sorting behind the messages it ties with lands in exactly that place: below the
row's first message, above the reader's line. It is the same shape, and the walk
is where it was measured rather than reasoned.

**It does not make #606 redundant.** What #606 fixed is #602 — the window
drawing ten of its messages nowhere — which is what the pane contains rather
than where the reader is sitting in it. Nothing in this run asks that question:
`sequence.py` reports 0 steps in all six walks, in every arm, so the parked
pane's painted run is contiguous whether the tie-break is in or out. #602 was
measured on the pane that asked for the page, and this walk reads the pane that
did not.

**The left pane is an internal control nobody arranged.** It sits at the top of
its content, where the fold is above the row's first line and #609's rule falls
back to the old answer. `anchor` and `fold` name the same message in all six
walks there, including both `pre609` walks where the right pane's two records
name different messages 1327px apart. That is the claim in #609's PR about #532
and #535 — that where the reader is not inside a run this changes nothing —
holding in the app rather than in the tests.

## Where the two trees park differently, and why it does not matter

`ship` measures its content at 28295px and both reverted arms at 28367px, so the
same 305 notches lands 72px apart: `scrollTop` 1437 against 1509, and the fold's
line beginning 40px above the top of the pane rather than 112px above it. The
tie-break decides a shared millisecond, that decides which messages share a run,
and a run's height is not the height of the messages in it.

`band.py` puts all six inside the band, and the fold's `within` of 1285 is the
arrangement asserted rather than assumed. The parking is 305 notches on this
binary as on run 40's release one, still.

## What this run does not claim

- **Anything about the release build.** Six debug walks against Vite. Run 42
  established that #602 reproduces identically on both, which is a fact about
  #602 and not a licence covering this.
- **That the anchor is right in general.** It holds the line at the fold, and
  every displacement this walk could produce lands above that line. #609 named a
  case beside itself that nothing covers — virtual-core declining to compensate
  a row entirely above the fold while the reader scrolls backward — and this
  walk does not scroll backward through a growing row.
- **Anything about a pane resized mid-read.** #609 gave the reader's eye line a
  hold across a rewrap and nothing asserts it, here or in the model.

`docs/measurements.md` has no figure at stake.

## What the harness learned

- **A walk with no arm that moves is an instrument, not a measurement.** The
  useful arm here is the one that was already known to fail: it is what says the
  four holds are holds.
- **A frontend control is free.** The debug binary loads the frontend from Vite,
  so three arms of a scroll-position question are three `git checkout` calls and
  one build, not three builds. Run 43's control was already this and did not say
  so; it is worth saying, because the reflex is to build.
- **A fix can reach a case its own PR did not claim.** #609 argued about fills
  and late lines and was walked on a landing, and the landing held for the
  reason the argument gives. Where a fix changes what a term *means* rather than
  what a branch does, the cases it reaches are not the cases it was written for.
