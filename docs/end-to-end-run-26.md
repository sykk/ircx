# End-to-end run 26: the line #516 was about, photographed

2026-08-14, release builds against a local `ergo` 2.19, on the walk in
`docs/end-to-end-26/`.

## The question

#516 was that the head of a pane said "Loading older messages" whenever the pane
beside it scrolled to the top: `loadingOlder` belongs to the conversation, and a
split can hold one channel twice. #517 gave the pane its own answer to "is the
page in flight one I asked for", and shipped with `Timeline.layout.test.tsx`
holding it.

Run 25 took 200 frames either side of that fix and reported that none of them
contains the row. The line draws at the top of the timeline; every frame that
run took is of a pane parked some 720 lines below its own head. So the fix was
verified in the sense that nothing regressed around it and unverified in the
sense that nobody had seen the line it governs.

That run also named the difficulty, and it is a real one. **A pane that can show
its head is a pane at the top of its content, and reaching the top is what makes
a pane ask.** A pane that asked is the case #517 says *should* draw the line.
Photographing the case the fix is about needs a pane whose head is on screen and
which has asked for nothing, and the walk that reaches the top has just spent
the ask.

## The state that resolves it

There is a state the app can be in where a pane sits at the top of its content
and asks for nothing: **owed a page it has already asked for and not been
given.**

A page-back that goes out and is not answered inside `ROUND_TRIP_TIMEOUT` leaves
the timeline with `hasMore` still true, `loadingOlder` back to false, and
`waitingBehind` set to the message the ask named — which is the head reading
"The server has not sent this page yet" (#491). Nothing was prepended, so the
pane has not moved off the top. `askedBehind` is cleared on that outcome, so the
*other* pane is free to ask. And the pane itself asks nothing further, because a
pane that is not scrolled raises no scroll event and a wheel against the top of
the content changes nothing to raise one with.

So the arrangement is two panes on one channel, run 23's, with the right one
walked to the top first and left there:

1. The right pane reaches the top and asks. Its answer never comes.
2. A minute later it gives up on the round trip and settles: parked at the top,
   head of its own, asking for nothing.
3. The left pane is walked to the top, where it asks.
4. The right pane's head through the next minute is the measurement.

## Holding the page-back, and nothing else

`holdpage.py` is a proxy that passes everything at wire speed except the batch
answering a `CHATHISTORY BEFORE`, which it keeps. Against an ergo on the
loopback a page comes back inside a millisecond, which is not long enough to
photograph and not long enough to walk a second pane in.

Two things it deliberately does not hold.

**The page a join asks for.** That request is `CHATHISTORY LATEST`, and it has to
land. A pane that opens on an empty timeline asks the server for the page behind
no message at all, is answered `end`, and spends the rest of the session saying
"Beginning of history" with nothing left to ask for — #496's shape, reached from
a different direction. The join's page is what keeps the conversation out of it.

**Everything else on the wire.** Registration, the join, the roster, the
seeders' lines: all of it goes through untouched, so nothing about when the
client asks or how it draws is being measured through the instrument.

`labeled-response` is what tells the two requests apart, which is the same
capability the client itself needs to tell a page-back from a gap fill
(`session.rs`). The client labels every chathistory request; the label comes
back on the batch that answers it, and the batch's reference names the lines
inside.

## The minute, which sets the pace

The first version of this walk waited nine seconds for the pane to settle and
photographed a head still reading "Loading older messages". The deadline is not
where it was assumed to be: `REPLY_TIMEOUT` is five seconds and is the enqueue's,
and `ROUND_TRIP_TIMEOUT` — the one a held answer runs out — is **sixty**
(`src-tauri/src/state.rs`). Both waits in the walk are 62 seconds for that
reason, and a walk is a little over three minutes.

## The two builds

Both arms are `npm run tauri build -- --no-bundle` with no probe, which is what
anybody runs.

The control is `main` with `src/components/timeline/Timeline.tsx` taken back to
9689a4f, the commit before the fix. #517 changed that file and its test and
nothing else, so the two binaries differ by the fix or by nothing — checked as
two different SHA-256 sums over the two builds rather than assumed.

The arms alternate run by run, run 25's arrangement, three runs each.

The channel is run 23's seed, 400 lines of it, taken for the channel rather than
for the property that seed was written for: no page lands here, so there is
nothing for a regrouping to happen to. What 400 buys is that the 200 the join
page brings leave 200 behind them, so the page this walk holds is one the reader
is genuinely owed.

**The walk repeats exactly.** All six sent two `CHATHISTORY BEFORE` and had 404
lines of 678 held, the same three figures in every one, on both arms and on the
rehearsal pass before them.

## What the frames say

Four frames a walk, three walks an arm. The reading is of the right pane — the
one that asks once and is then left alone — over its own columns, the head's
band apart from the rows below it (`head.py`, on run 23's crops).

| the right pane, between | control | fixed |
|---|---|---|
| its own ask going out and running out | head differs 3 of 3 | head differs 3 of 3 |
| **that, and its neighbour asking** | **head differs 3 of 3** | **head still 3 of 3** |
| that, and its neighbour's ask running out | head still 3 of 3 | head still 3 of 3 |

**The rows under the head are still in all 18 comparisons.** No page lands in
this walk — every answer is held — so the pane that asked for nothing has
nothing to redraw, and the whole of what the control changes is the sentence at
the top of it.

The first row is what makes the second one mean anything. Both arms draw the
line while the pane's own page is in flight and take it off when the round trip
gives up, so the fixed arm is not a build that stopped saying anything. The
third row is the control's line going again when the neighbour's minute runs
out: what it drew was the neighbour's request, for exactly as long as the
request was out.

`control-owed.png` is the pane before its neighbour asked — parked at the top,
owed a page, "The server has not sent this page yet" over it.
`control-asking.png` is the frame after, and it is #516: the left pane asked,
and both heads say the reader's history is loading.

`fixed-asking.png` is the same moment on the build that ships. Two panes on one
conversation, the same rows drawn in each, one sentence apart.

What the fixed arm draws there is a different sentence rather than no sentence,
and `historyHead` is why: `loading` is tested *before* `waiting`. The pane is in
one state in both arms — owed a page, nothing of its own in flight — and what
decides which of the two lines it draws is `askedForPage` and nothing else.

## The other half of the fix

#517 kept one way of drawing the line that is not the pane's own request: a
reader who scrolls to the top while a page for that page is already out is
refused their own request by the deduplication guard, and is waiting on the
answer all the same, so they get the line. Nothing had watched that case either,
and it is the one a fix like this can quietly lose.

`midflight.sh` walks it — the left pane taken to the top *inside* the right
pane's minute rather than after it. Both heads say "Loading older messages", in
both arms, and the wire carries **one** `CHATHISTORY BEFORE` for the pair
(`midflight.png`). The second head is not a second request; it is a pane saying
it is owed the first.

## What this leaves

- **#516 is reproduced on the build that ships**, and it is not a rate: the
  control draws the line in a pane that asked for nothing on every run, and the
  fixed arm on none.
- **The fix still draws the line where it should.** In the pane that asked, in
  both arms; and in a second pane that scrolled in mid-flight, in both arms.
- **What no walk here holds is a page that lands.** Every answer in this run is
  held, which is what makes the state stable enough to photograph. What the head
  does as the page it named arrives — the line going, the anchor correcting for
  the rows that came with it — is `Timeline.layout.test.tsx`'s, still.
