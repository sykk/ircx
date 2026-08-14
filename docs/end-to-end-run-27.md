# End-to-end run 27

Run on 2026-08-14 against the same local `ergo` 2.19 on `127.0.0.1:6677` runs 15
to 18 used, in the release app, on the thread run 18 left in its own list of
what it had not settled: **the duplicate-batch route**, which it argued from the
code and did not walk.

Run 18's words for it were that all three routes to a wedged page-back "end in
the same place — `askedBehind` naming a message nothing moved — so the fix
covers them, but only the dropped one has been seen." The first half is right
and the second does not follow. **The `waiting` fix does not cover this one**,
because this one is answered: the round trip completes, `more` comes back, and
the disarm that fires on a spent deadline never fires at all. That is #522.

The run reached it, separated the builds on it, and then **found the first fix
for it asking the same question 26 times in a walk** — which is why the fix that
ships is a different one.

## The defect

Nothing has to go missing. The batch arrives, on time, carrying only rows the
pane already holds, and `holdMessages` files none of them — so the window's
oldest message does not move, and the guard that came off by its moving stays
armed. `forgetPageBacks` on a connection change is the only other thing that
clears it.

That is `CHATHISTORY LATEST`'s own shape. `PageBack::Deferred` answers `true`
for exactly it, reasoning in its comment that "`true` is what leaves the pane
able to ask again once it has landed" — and under the guard the landing is what
does not happen.

The reader is left at the top of a conversation whose `hasMore` is still true:
no "Beginning of history", no error, nothing loading, and no scroll they make
will ask again for the rest of the session.

## The instrument

`replaypage.py`, which is `holdpage.py` with its one decision inverted:
run 18's proxy **drops** the batch answering a `CHATHISTORY BEFORE`; this one
**replaces its contents** with the two hundred messages the client was sent when
it joined, retagged into the answering batch's own reference. The opening
`BATCH +ref chathistory` line passes through untouched, label and all, so the
client correlates the answer exactly as it would a real one.

So every ask is answered inside its own deadline, the session stays up, and the
only thing wrong is that the answer says nothing new. There is no sixty-second
wait anywhere in this walk: run 18's page never came, and its result was a
deadline expiring; this page comes back in three milliseconds.

Checked at the protocol level before any binary was driven — a socket client
that joins, takes `LATEST`, and asks `BEFORE` the oldest of it reads back 200
messages of which 200 are already held.

`--pass` replaces nothing and was run first, on the shipping build:

```text
   16.309 ask @label=ircx-1 CHATHISTORY BEFORE #scrollback msgid=6uhih9dhv8nsyz468nqf68pszn 200
   30.424 ask @label=ircx-2 CHATHISTORY BEFORE #scrollback msgid=y8nr7ecwkbah868ji687y8xsvs 200
```

Two asks, the second naming an older message than the first: pages arriving, the
guard disarming as each lands, the client walking back through history the way
it should. Run 17's discipline, applied before the count rather than after it.

## The count, and where the count stops being the result

Three walks a build, `#scrollback`, over-scroll to the top and then two
deliberate down-and-up bursts.

```text
                              walks   asks/walk   what the reader is told
a1787bf (before)                  3           1   nothing
the first fix (asking again)      3     26/22/23   nothing
the fix that ships                3           1   Beginning of history
```

The control is wedged, 3/3: one ask on the first scroll and never again,
however much it is scrolled. `control-wedged.png` is the frame — the top of the
channel, `Connected`, 15 caps, and no line of any kind above the first message.

**The first fix took the guard off the batch that answered it**, and separated
from the control cleanly — 26 asks against 1. It also put #487 back:

```text
   15.666 ask @label=ircx-1 CHATHISTORY BEFORE #scrollback msgid=82b6ze64y8nvnqgjwa9mfh8cci 200
   15.735 ask @label=ircx-2 ... msgid=82b6ze64y8nvnqgjwa9mfh8cci 200
   15.799 ask @label=ircx-3 ... msgid=82b6ze64y8nvnqgjwa9mfh8cci 200
   15.863 ask @label=ircx-4 ... msgid=82b6ze64y8nvnqgjwa9mfh8cci 200
```

The same msgid, 65 ms apart, seven of them from the single over-scroll that
reaches the top — before either retry burst. #487's bursts were 37 to 40 ms
apart. On a local socket the batch lands fast enough to disarm the guard before
the next scroll event of the same wheel, so the guard bounds nothing: what the
reader holds at the top of a conversation is a request loop, paced only by the
round trip. `asking-asks.txt` is the whole of it.

**A unit test could not have caught that**, and this is the part worth carrying.
The test written for the first fix asserted the second ask goes out, and it
passed: jsdom's mock resolves the page-back without an event channel, so the
26th ask has nowhere to come from. Run 18 closed with "where a defect has a
state rather than a timing, the test is the cheaper instrument and the walk is
the confirmation." That holds. The clause this run adds is that **a fix whose
cost is a rate cannot be confirmed by the instrument that found the state.**

## What ships instead

The two cases the frontend has to tell apart both arrived as `More`:

- nothing went out, because the conversation's own first page was already coming
  and is what answered — which says nothing about what is behind the window; and
- the server answered, with a page carrying nothing before the message it was
  asked about — which says there is nothing there.

Asking again is right for the first and wrong for the second. Stopping is right
for the second and wrong for the first — it would draw "Beginning of history"
over a server still holding history, which is #472.

So `PageBackOutcome` gained a fourth answer, `Deferred`, and the frontend reads
them apart. The guard is armed only for an ask that reached a server and whose
answer has not crossed yet; a page landing against an armed one is that answer,
and a page with nothing in it ends the paging.

Which the walk confirms, and **not by the count**: the shipping build asks once
per walk, exactly as the wedged control does. The wire no longer separates them
and the frame does — `fix-says-so.png` against `control-wedged.png`, same
scroll, same second, one drawing "Beginning of history" at the top of the
channel and the other drawing nothing at all. 3/3 either way.

That is run 17's warning arriving from the other side: a frame that appears in
both walks separates nothing, and here it is the *wire* that appears in both.

## What this run did not settle

- **Whether a real server produces the condition.** The proxy reproduces the
  effect — a page answered with what the reader already has — and not any
  particular cause. The one route in the client's own code is
  `PageBack::Deferred`, which is `#486`, and that path is now the one told
  apart rather than the one wedging.
- **The empty-batch route**, still argued from the code. It ends as `End` rather
  than `More`, so it is a different sentence again, and no walk has read it.
- **Whether the ordering this fix turns on holds off a local socket.** Core
  emits the batch before the outcome and both cross to the webview on different
  channels; every walk here saw the batch first, which is why the count of pages
  taken is read rather than assumed. A slow or loaded network is where the other
  order would show, and nothing here has been run on one.
- **Run 17's asks-per-walk difference**, which is what led to run 18 and to
  this. Six asks a run against two was measured between the #494/#496 builds,
  and this wedge is in both of them. Still unexplained.
