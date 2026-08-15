# End-to-end run 31: the pane beside the one that waited

2026-08-15, release builds against a local `ergo` 2.19, on the walk in
`docs/end-to-end-31/`.

## The question

Run 30 held a page-back past `ROUND_TRIP_TIMEOUT` and photographed the pane that
asked for it. It closed on what it had not touched:

> **Anything about a split.** One pane throughout. #508's own shape is two, and
> what the pane beside this one does when a late page lands is untouched.

#508 is the pane nobody is scrolling moving a line when the other pane pages.
#515 bounded it, #532 held the asking pane's reader still while the landed page
was measured, and run 30 read `+0px` on the asking pane afterwards. What no walk
has watched is the other pane, on a page that arrives after the client has given
up on it.

## The instrument

Run 23's arrangement under run 30's proxy. Two panes on one conversation, the
right one parked up the archive with nobody touching it, the left one paging
back — and `latepage.py` holding the answer seventy-five seconds, past the sixty
`state.rs` gives up at. The control is the same binary on the same walk with the
page held forty seconds, so the client is still waiting when it lands.

`pick.py` reads both panes off the same frames, three pairs each — two frames
before the landing, the pair it falls between, two after — and three readings a
pair: the distance the message column moved, whether that column is pixel for
pixel what it was, and whether the whole pane is.

## What the frames say

Ten walks on the build anybody builds, five an arm, `still` and `after` beside
every landing so that a distance means the landing rather than a pane that was
drifting anyway. The full readings are `shifts.txt`; the middle column of each:

```text
                     the pane that asked      the parked pane
late     run1               +0px                   +0px
         run2               +0px                   +0px
         run3               +0px                   +0px
         run4               +0px                   +0px
         run5               +0px                   +0px
in time  run1               +0px                   +0px
         run2               +0px                   +0px
         run3               +0px                   +0px
         run4              +84px                   +0px
         run5               +0px                   +0px
```

**The parked pane does not move, in either arm.** Thirty readings — ten landings
and the `still` and `after` pairs either side of them — and every one of them
zero, with the message column pixel for pixel what it was across the landing in
all ten.

**The page did land, and the parked pane shows it.** Every landing pair reads
`pane differs` where the message column reads `rows still`: the scrollbar's thumb
shortens for the two hundred messages that arrived above the reader, and the
spine beside every row changes where the topic declared on the page's last line
re-opens the group they are in. Both are outside the column the distance is
measured over. Without them a walk that photographed the wrong minute would print
the same table.

**The one non-zero reading is the pane that asked, and it is not the settling.**
It has a section of its own below.

## What the records say, which the frames cannot

A second binary carrying `VITE_PROBE=1`, on the same walk, twice. What a
photograph cannot answer is whether the parked pane held because its anchor did
something or because nothing reached it, and the records answer it plainly. Both
walks are in `records.txt`; the first:

```text
left pane, at x 244     the landing   msgs 408  top 11137  branch moved
                          the write   drawn 11059 - delta -78 = 11137
                          the head    headPx 0 against margin 24, lag -24
                          settling    11 commits, +0px under the reader
right pane, at x 724    the landing   msgs 408  top 13173  branch moved
                          the write   drawn 13146 - delta -27 = 13173
                          the head    headPx 0 against margin 0, lag 0
                          settling    2 commits, +0px under the reader
```

**The parked pane's stillness is work.** It took the `moved` branch and wrote its
own `scrollTop`, from 2289 to 13173 — ten thousand pixels, paying for two hundred
messages that arrived above a reader who was not there. A pane that had done
nothing would have stayed at 2289 and shown the reader a different part of the
conversation. The second walk is the same shape from a different parking: 7119 to
18091, `drawn 18006 - delta -85`, and 0px after it.

**Its `lag` is 0 where the asking pane's is -24.** The parked pane never had a
head, because it never asked: #516 from the inside.

**The hold ends in two commits rather than eleven.** The measuring a landing sets
off is per pane, and the pane the reader is not looking at has fewer rows on
screen to measure.

## The reading that was not zero

In one walk of ten the pane that asked moved 84px, and the frames say what
happened. `merge-before.png` and `merge-after.png` are its message column either
side of the landing.

Before, the pane was at the top of its content: the head, the day separator, and
then line 0233 under a `curator` heading of its own, being the first message in
the window. The page landed with line 0232 as its last message — `curator` again,
by the run the seed was written to produce — and 0233 folded into that run and
lost the heading. The reader's own line is drawn 84px lower afterwards.

**This is not the settling #532 fixed.** The `still` and `after` pairs of that
walk read zero, and the probe's answer to a settling drift is a `delta` that
changes over the commits after the landing; every settling read in this run is
0px.

**It is the anchor's unit.** `Timeline.tsx` translates between messages and rows
in `offsets`: `offsetOfMessage` answers with the start of the *row* holding a
message, and `messageAtOffset` names a row by its first message. So the reader is
recorded as "the row whose first message is X, that far below the top of the
scroller", and put back by aligning that row's top with where X's own line was.
Where the row has taken in messages above X — which is what a page merging into
the group at the top does — the row's top is no longer just above X, and
everything the row took in is added below the fold.

`scrollAnchor.ts` names this case as the reason `movedInList` works in messages:

> Messages rather than rows: a page can merge into the group that was at the top,
> which changes that row's identity but not any message's.

It is detected in messages and corrected in rows. Filed as #535.

## What this run got wrong first, which is worth more than the table

**Run 30's window does not survive a split, and the first set died on it.**
Frames cannot be taken during a wheel burst — `window.mjs` sends the whole burst
as one command — so the first of them lands a second and a half after the burst
ends, while the ask went out the moment the pane reached the top of its content.
How long the burst runs on after that is the free variable: 23 seconds in one
walk here and 60 in another, against a hold that is the same number every time.
Run 30 opened its window 28 seconds before the release could be at its earliest,
which is a window aimed at a burst of known length. Aimed at these, it caught one
frame ahead of the landing where `pick.py` needs three. The window now starts
where the burst ends and runs the whole hold out.

**A pair straddling the release is not a pair straddling the landing.** The
release is when the batch went on the wire; what a frame can show is two hundred
rows drawn. One walk's pair bracketed the wire by a tenth of a second and read
`pane still` on every pane and every pair — a landing photographed twice from in
front. `pick.py` now takes the release as the instant the page is on its way and
the first frame that differs from the one before it as the instant it arrived.

**The strips have to clear the spine, and the seed is why.** The page this walk
lands declares a topic on its last line, and that group reaches forward into the
rows already on the screen: every one of them gains a continuous coloured spine
where each had a stub of its own. Nothing moves — the text is drawn at the same
heights either side of it — but the first walk to park a pane where the
regrouping reached it lost all fourteen strips, because a strip that includes
those four pixels cannot be found afterwards. The columns start clear of it now,
and the change is reported by the pane-wide reading instead.

**A distance of zero is what a walk that measured nothing prints.** Both panes
read `+0px` with their rows identical, in every arm, which is also the reading of
a burst that photographed the wrong minute. What separates them is the whole-pane
comparison: two hundred messages arriving above the reader shorten the
scrollbar's thumb in every pane on the conversation, whether or not a row moves.
A landing pair that reads `rows still, pane differs` is a page that arrived and
moved nobody.

**Which pane asked is read rather than assumed, and a set was thrown away for
it.** The regrouping a landing page does reaches the rows nearest the top, so a
pane parked where it can be seen is a pane near the top of its own content — and
`LOAD_OLDER_PX` is 400px, so such a pane asks for that page itself. A set was
started with the right pane parked there and stopped on its first walk, once
`parked.png` was looked at rather than assumed: the pane had "Loading older
messages" over it, and the ask was stamped three and a half seconds *before* that
frame was taken. The right pane was the asker and the walk had no parked pane in
it at all. `pick.py` names the asker now, from the proxy's own log against the
frame's mtime.

That parking was tried again with the flag in and abandoned on its own evidence:
five walks of the six read inverted. Where a pane stops is not a function of how
far it was wheeled — 700 notches left it on line 0253 of this seed, 750 on 0206
and 850 on 0217 — because the wheel scrolls against heights the virtualiser is
still measuring. The band it has to stop in is real, from 400px below the top of
its content to wherever the arriving group's reach ends, and a burst cannot be
aimed into it. What is walked here is run 23's parking, a hundred messages below
anything the page redraws.

## Two things the wire said in passing

**A pane that gives up asks again immediately.** On three of the five late walks
the ask went out twice — the second exactly sixty seconds after the first, which
is `ROUND_TRIP_TIMEOUT` — so the page that lands is the answer to a request the
client both gave up on *and* has already replaced. Run 30's arm held one ask a
walk and reported one; nothing here says whether the second is the split's doing
or run 30's window closing before it.

**Its answer is never seen.** The second ask is held seventy-five seconds too and
the walk ends first, so what the client does with two answers to the same
page-back is unwalked. #522 is the shape of that question and was closed against
a batch the window already holds.

## What this settles

- **The pane beside the one that asked does not move when a page lands late.**
  Ten landings on the build that ships, five of them past the timeout, and the
  parked pane's message column is pixel for pixel what it was across every one.
  Run 30's open item, closed.
- **It holds because its own anchor holds it.** The records have that pane taking
  the `moved` branch and writing ten thousand pixels of correction, exact against
  its own arithmetic, with no settling drift after it.
- **The instrument is not blind to a pane that moves**, which a table of zeroes
  otherwise cannot claim. The same instrument read +84px on the pane that asked,
  in a walk of the same set.

## What it does not claim

- **That the reader is never moved by a landing page.** #535 is the case where
  they are, in the pane that asked, and it is a mechanism this run reached rather
  than a rate: one walk in ten, and what decides it is where the pane's top row
  falls against the page's last message.
- **A rate for the parked pane.** Ten landings is not run 23's seventy-two, and
  that walk found two moves in seventy-two on the arrangement this one uses. What
  is walked here is the late page, which nothing had walked at all.
- **The neighbour where the arriving group reaches it.** The band a pane can be
  parked in and still be a neighbour is real and a wheel cannot be aimed into it,
  so what a pane parked among rows the page re-groups does is unwalked. The rows
  themselves are watched — the spine changes beside every one of them in the
  parked pane, and nothing moves.
- **A real server's late page.** The delay is a proxy's, as it was in run 30.
- **Anything about the second ask being answered**, which the walk always ends
  before.
