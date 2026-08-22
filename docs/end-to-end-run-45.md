# End-to-end run 45: a reaction landing on a line the reader has scrolled past

Debug build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`. #611's
arrangement, which is not run 40's: **one pane, nothing paging, and the reader
still moving when the measurement is taken.**

Four walks, two arms of two. `docs/end-to-end-45/walk.sh` is the whole of it and
`walk-records.txt` is what it printed.

## What was owed

#612 fixed #611 on the model and on `docs/end-to-end-42/lab`, and said what that
left open:

> A walk. This is the lab and the model; nothing here is the assembled app, and
> the lab has no Rust behind it. The arrangement a walk would need is a reader
> scrolling up in a channel that is still talking, which `latepage.py` does not
> arrange.

## The arrangement, and why none of run 40's applies

#611 is three conditions at once: a row above the fold, already measured, whose
height changes while the virtualiser calls the scroll a backward one. Nothing
pages, nothing merges and nothing changes place in the list, so the second pane
run 40 needed to make one pane ask has nothing to do here.

The parking is 60 notches rather than 305, and that is the arrangement rather
than a detail. What this walk needs is room *above* the reader: a pane holds
about four hundred messages and a pane parked where run 40 parks it has a screen
of them above it and the rest below. Sixty notches leaves three hundred lines
overhead, which is where every growth in this run goes.

**The gesture is a notch at a time with 120ms between**, forty times, which is
under `isScrollingResetDelay`. The virtualiser reads it as one backward gesture
for the whole 4.8 seconds rather than forty separate ones, and that state is the
whole of what #611 is about. A single `wheel -40` is over in 640ms — the notches
are 16ms apart in `xsend.c` — and lands every reaction in a heap after it.

## What makes the row grow, which is the app's own doing

`reactor.py` is a second client. It joins before the seeder, so it hears every
line and can name the message under any of them, and then it reacts: a
`+draft/react` TAGMSG naming a `msgid`, which `session.rs` turns into
`ReactionChanged` and the timeline draws as a row of chips. The first reaction
on a message is what adds that row — a second only lengthens one — so every
target is a message nobody has reacted to.

**It fires on the pane's own words.** The 150ms window is too narrow for a
schedule computed from outside, so nothing computes one: the reactor tails the
probe log, and two `commit` records with `top` falling is the reader scrolling
back. A reaction goes out on seeing it, and the loopback round trip is
milliseconds against the 100ms the probe buffers for.

The target is the fold's own message less a hundred lines, which is what makes
this self-locating and what asserts the arrangement rather than assuming it:
every line of `walk-records.txt` names the line reacted to and the line at the
fold when it went out, and the first is a hundred or a hundred and one above the
second in all forty-eight — the odd one being a line already reacted to, which
this steps over.

`--after` keeps the burst out of the parking, which is a backward gesture too
and the first thing an unarmed reactor spends itself on. The walk takes a
screenshot it does not need on the line before the gesture; `ss` is the only
mark `window.mjs` can leave for another process to see.

## The reading, which is a transaction rather than a distance

Run 43 read a displacement as a subtraction on one message between two commits
the pane was at rest on. Nothing here is at rest, and worse: **the displacement
changes which message is at the fold**, so a subtraction on one message cannot
see the thing whose whole effect is to put another message where it was.

So `moved.py` reads the transaction. A commit whose content grew by a row of
chips is a commit where the pane owes the reader those pixels, the growth being
above them. Paid, and the message at the fold is still there when the commit
ends. Unpaid, and it is a different message.

## What the four walks read

| arm | the pane, parked | settled | growths paid for | owed |
|---|---|---|---|---|
| with the fix | `816..838` | `709..727` | **12 of 12** | 0px |
| with the fix | `814..835` | `707..727` | **12 of 12** | 0px |
| `main` | `814..835` | `696..710` | 3 of 12 | **252px** |
| `main` | `819..840` | `700..716` | 5 of 12 | **196px** |

Twelve reactions in every walk, and twelve rows of chips in every walk: the
arms differ in what the pane did about them, not in what arrived.

**The frames say the same thing from outside.** The second `main` walk and the
second fixed walk parked on the identical band — `814..835` — and settled eleven
messages apart, `696..710` against `707..727`. The reader who was not paid ends
further back in the conversation, by about what the records say they were owed.

## The control inside the control

Three of `main`'s twelve growths were paid for, and five in the second walk.
Those are the reactions that landed between two notches rather than during one,
past the 150ms — where `scrollDirection` has reset and the virtualiser's own
rule applies without its backward clause. The same walk, the same build and the
same event, paid or not according to which side of the reset it fell on.

That is the mechanism named rather than inferred. If the difference between the
arms were anything but the direction clause, the unpaid growths in `main` would
not be exactly the ones that arrived while the wheel was turning.

## What this run claims, and what it does not

It claims #611 in the assembled app: a reaction arriving from another client, on
a line the reader has read past, while they scroll — with no page, no merge and
nothing changing place — moved the reader 252px and 196px on `main`, and 0px
twice with #612 in.

- **It is the debug binary.** Vite serves the frontend and the probe is compiled
  in. The fix is one predicate and the probe is not on its path, but no release
  walk has been run.
- **The reaction is one of three doors.** #611 names a preview finishing and a
  delivery failure gaining its reason as the others, and neither is walked. A
  reaction was chosen because it needs nothing of the reader but scrolling, and
  because another client can send one on demand.
- **Nothing here measures the cascade the clause was for.** The three tests in
  `Timeline.layout.test.tsx` say the reader still goes where they take the pane;
  four walks of a reader scrolling through a growing conversation is a live
  version of that and it saw no fighting, but it is not the arrangement upstream
  was guarding against.

`docs/measurements.md` has no figure at stake.

## What the harness learned

- **A displacement that moves the fold cannot be read at the fold.** The
  instrument every run since 40 has used — one message, two commits — reads zero
  here, because the message it would subtract is no longer the one being asked
  about. What the records could still answer is whether the pane was paid, and
  that is the same question from the other end.
- **`ss` is a semaphore.** `window.mjs` speaks to nothing but the window, and a
  second process that has to know where the walk has got to can watch for a
  screenshot to appear. It cost one PNG and replaced a schedule that would have
  had to guess the app's launch time.
- **The pane's own records are a trigger, not just a reading.** A condition
  150ms wide is not something to aim at from outside; tailing the log the pane
  writes puts the second client inside the app's own clock.
- **A wheel is not one gesture per command.** Notches are 16ms apart, so
  `wheel -40` is a 640ms event and `wheel -1` forty times with 120ms between is
  a 4.8s one. The virtualiser tells them apart and so does the defect.
