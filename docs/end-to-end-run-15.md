# End-to-end run 15

Run on 2026-08-12 against a local `ergo` 2.19 on `127.0.0.1:6677`, in the
release app, on the two paths run 14 named as unreached and could not walk.

Run 14 left four things it had not reached. Two of them are the scroll
anchor's, and both are walked here:

- **a page landing while the reader is at the live edge**, which every walk
  before this one missed because they all measured a reader who had scrolled
  back and stayed there
- **two panes on one conversation**, named by run 12 for the same reason and
  named again by run 14

Both hold. The reader is not moved in either, and the measurement is `+0px`
rather than "looks right". What the run found instead is on the way to them:
a history page that takes longer than five seconds is reported to the reader
as the network having stopped responding, which is #491.

The channel is run 12's `seed_history.py` — 900 messages, `line 0001` to
`line 0900`, seeded the day before this run, which is why every frame here
separates them from the walk's own day with a `Yesterday`.

## The instrument

`delay.py` from run 14 holds the server's side by one fixed delay, which is
enough to bracket a page landing in a pane nobody has touched. It is not enough
for a reader who scrolls to the top and comes back. Reaching the top of a
200-message page is about a thousand wheel notches, and the way back is
another twelve hundred: thirty-odd seconds of walking, against a page that
lands 800ms after it is asked for. Holding the whole session by thirty seconds
instead would work and costs three round trips of it before registration
finishes — registration is three round trips, so an 8s hold puts `001` at 24s,
which is how the first attempt at this ran out of walk before the pane had
anything in it.

`stepdelay.py` steps instead. The walk registers, joins and settles at 800ms;
the delay steps to 45s before the scroll that asks for the page; the page is
still in the air when the reader is back at the live edge. The step is timed
from the first connection rather than from the process starting, because what
the walk knows is when it launched the app — which means **one walk per proxy**:
a second walk against the same one registers at 45s and never finishes.

Ordering is what makes stepping safe mid-session. The delay only ever goes up
and a chunk is due no earlier than the one before it, so the server's lines
reach the client in the order it sent them.

## A page landing at the live edge

Two shapes, because a following pane can be at the live edge for two different
reasons.

**The pane a channel opens with**, which is every channel open there has ever
been. Held at 8s, the walk photographs the pane before and after the join-time
`CHATHISTORY LATEST` lands:

```text
12:06:19.829  JOIN #scrollback
12:06:27.830  CHATHISTORY LATEST #scrollback * 200
   f09  08:06:34   the pane, holding the join and nothing else
   f10  08:06:36   200 messages of yesterday above it, the reader still at the foot
```

`01-following-before.png` and `02-following-after.png` are the pair. The reader
is at the live edge in both.

**The pane a reader comes back to**, which is the one nothing had walked. The
scroll to the top asks the server, the reader returns to the live edge, and the
page lands on a pane that is following — and this time the anchor has a
recorded row as well, so both layout effects in `Timeline.tsx` answer the same
prepend.

```text
12:10:05.375  @label=ircx-1 CHATHISTORY BEFORE #scrollback msgid=zsyypyx86ephqvfuq9hxfnpf7w 200
   08:10:38    back at the live edge
   e03  08:10:47   before
   e04  08:10:51   after — the page has landed
```

`shift.py` reads **+0px** across that pair, and the only pixels that differ at
all are `(1052, 654)` to `(1058, 668)`: a 6×14 region, which is the scrollbar's
thumb shrinking by 200 messages of new scroller above the reader. That is the
same signature run 14 recorded for a release landing, and here it is on the
path that has no anchor to hold.

One request went out for that page and one only. #486 and #487 were both fixed
the day before this run, and seven landings across this run's walks show
neither the join-time second ask nor the doubled fast one coming back.

## Two panes on one conversation

`06-two-panes.png` is the end of it: the left pane at `Beginning of history`
with `line 0001` under it, the right pane still at the live edge with the
walk's own join at the foot, both drawn from one store timeline.

The left pane was read back through all 900 messages in fourteen bites of 400
notches, four pages from the server. At no point does the right pane move. Its
own layout effect re-pins it to the last row on every prepend, and every
prepend is 200 messages the reader of that pane never asked for and does not
see.

Worth knowing for the next walk of this: a split halves the width, so the rows
re-wrap and the notch is worth less of the conversation than in a full-width
pane. 1600 notches reads about 200 messages in a full window and rather fewer
in half of one; measure it per walk rather than carrying the figure over.

## A page slower than five seconds is a failure with a page in it

This is #491, and the instrument found it by accident: a 45s hold is longer
than the 5s `REPLY_TIMEOUT` in `src-tauri/src/state.rs`, so every stepped walk
drew `walk stopped responding — reconnect it and try again` in the danger
colour across the head of the timeline. `05-stopped-responding.png` is it.

`page_back` is asked through `App::ask`, and the oneshot it waits on is only
answered when the server's labelled response comes back —
`context.waiting_readers().insert(label, reply)` in `crates/ircx-core/src/task.rs`.
So the five seconds is a deadline on a server round trip rather than on the
session taking a command, which is what the timeout reads as everywhere else it
is used.

What makes it worth a number rather than a note: **the page arrives anyway**.
The same walk that reported the network stopped responding took the page 45
seconds later and drew it correctly, holding the reader at +0px — that is the
e03/e04 measurement above, and the error was already on screen when it was
taken. The reader is told to reconnect a network that answered.

Three of three stepped walks reported it. Nothing else in the run does.

## What this run did not settle

**The head of a pane that holds only its first page.** Twice in ten walks, a
pane scrolled to the top of the initial `CHATHISTORY LATEST` page drew the
conversation's own opening rows *above* the history: a `Today` separator, the
`1 joined. 1 of them involves you.` digest and the `#scrollback was created on
…` line, and then `Yesterday` and `From the server's history` beneath them.
`07-head-inverted.png` and `08-head-inverted-again.png` are the two, one in a
split pane and one unsplit. `09-head-correct.png` is the same three rows where
they belong, at the foot, from a walk that did not show it.

It is not reduced, and the useful part is what it is not:

- **not the split.** One of the two sightings is a single pane, and four split
  walks drew a clean head.
- **not ergo's HistServ replay.** A raw socket confirms ergo returns join and
  quit history as `PRIVMSG` from `HistServ`, so the reader's own join legitimately
  appears twice — once live and once from history, with the seams alternating
  around it. That is the server's doing and it is in every frame of this run,
  including the correct ones.
- **not the archive's ordering.** Every message read in `ircx-store` is
  `ORDER BY timestamp DESC, id DESC`, and the archive from a kept profile
  confirms the rows themselves carry the right timestamps — today's live rows
  are the newest in the file.
- **not `Date.parse` losing the precision.** Locally-stamped rows carry
  nanoseconds (`2026-08-12T12:18:07.019046738Z`) where server-stamped ones carry
  milliseconds, and the store orders by `Date.parse` throughout — but
  `/usr/libexec/webkit2gtk-4.1/jsc`, which is the engine the app actually runs
  in, parses all three widths to the same millisecond as V8 does. Checked
  because a NaN there would have made `mergeByTime` degrade to
  `[...held, ...fresh]`, which is exactly the shape on screen.
- **not `buildRows`.** It walks the message list in order and emits rows in that
  order, so the rows being at the head means the messages are.

What would settle it is a reading of the store's list rather than of the
window, which is the same thing run 14 wanted for its residual and the same
reason it did not get one. Two sightings with frames is more than run 14 had
for the empty pane it recorded, and less than a mechanism; it is here so the
next run knows the shape to watch for and which four explanations not to spend
an hour on.

**Settled after the run, by reading the store rather than the window** (#494).
The fifth explanation was `prependHistory`, which filed an archive page in
front of the window without comparing a single timestamp. A pane that opens on
an empty timeline asks the archive with `before` null, and `load_history` reads
that as "the newest page you hold" rather than as a page behind anything; the
read is then awaited, so the server's own `CHATHISTORY LATEST` can land while
it is in flight. Today's rows are filed in front of yesterday's, which is the
shape in `07-` and `08-`. It is a race between two reads, which is why it was
two in ten walks rather than ten. The list is merged by time now, and the
ordinary page — wholly behind the window — is still the concat it was.

One thing to carry forward from the hunt. Run 15 put three fractional-second
widths through `/usr/libexec/webkit2gtk-4.1/jsc`; a kept archive holds five (3,
6, 7, 8 and 9 digits), and `time`'s RFC 3339 formatter trims trailing zeros, so
it can emit any width from 0 to 9. All ten parse there to the millisecond V8
gives. `Date.parse` returning NaN is ruled out for every stamp this client can
write, rather than for the three that were sampled — which matters because a
NaN anywhere in `mergeByTime` degrades it to exactly the shape above.

**The empty pane** run 14 recorded did not happen again, in ten walks.

**A machine under load** is still unasked, and still the obvious way run 14's
debug-only residual could stop being debug-only.
