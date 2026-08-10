# The twelfth run: a pane somebody scrolled into the server's history

Run on 2026-08-10 against a local `ergo` 2.19 on `127.0.0.1:6677`, in the
assembled debug app on `Xvfb :90`, against `main` at `e48032e`.

#473 landed `CHATHISTORY BEFORE` and said what it had left behind:

> **A pane a person actually scrolls.** The wire is verified here and the pane's
> own decision — ask only where the archive came back short, not where the
> window filled — is `Timeline.test.tsx`. What no test covers is the two
> together in the running app.

This is that walk, over a 900-message channel read from the live edge to line
0001. The paging is correct: five pages, in order, ending where the server ran
out and not before. **The reader is not.** A page landing moves the timeline
under them by the height of one line, and the cause is a piece of the scroller
the anchor was never told about.

## The channel

`end-to-end-12/seed_history.py` fills `#scrollback` from two clients and then
stays in it — ergo destroys an unregistered channel the moment it empties and
the in-memory history goes with it, so seeding and quitting leaves a server with
nothing to page back. That cost the first attempt of this run: the channel read
empty and the fault looked like the client's.

900 messages, numbered `line 0001` to `line 0900`, so a screenshot names exactly
which message is where. Heights vary on purpose: every seventeenth wraps to
three rows, every fifth is two words.

Nothing in the seed starts with `[` or with `nick:`. Both are things `groups.ts`
reads as structure, and a channel where every message opens a group is not the
channel this was measuring.

ircx joins with an empty archive, so every page in this run comes off the socket.

## What went out

`01-live-edge.png` is the pane on arrival: `CHATHISTORY LATEST` has filled it to
line 0900 and the seam reads **Live from here**.

Scrolling from there to the beginning, off ergo's own wire log:

```text
15:07:30.057  CHATHISTORY LATEST #scrollback * 200
15:07:30.557  @label=ircx-1 CHATHISTORY BEFORE #scrollback msgid=fctzxpmrpkg6rjbbv8rmp86iqw 200
15:07:58.429  @label=ircx-2 CHATHISTORY BEFORE #scrollback msgid=rn8f7sfbbjfm44ar5gik9uqp5a 200
15:08:25.214  @label=ircx-3 CHATHISTORY BEFORE #scrollback msgid=3ncdeyumqc2mft3esp946r5qii 200
15:08:50.326  @label=ircx-4 CHATHISTORY BEFORE #scrollback msgid=waif5zzwyxdrxuzrjs8ghu9v3s 200
15:09:16.549  @label=ircx-5 CHATHISTORY BEFORE #scrollback msgid=w4aex7ja6e8u77jfd5g24cuzga 200
```

Five requests, each labelled, each naming the oldest message the pane held, none
of them repeated and none of them overlapping. `04-beginning-of-history.png` is
where it stopped: line 0001, the two joins above it, and **Beginning of history**
at the top of the scroller — drawn after the fifth page came back short, which is
the one place #472 now allows it. The read is right.

## Measuring where the reader ends up

The wheel is new. `xsend` could click and type; a timeline is a `div` nothing
focuses, so no key sent to the window scrolls one, and "read to the top by hand"
had no input to do it with. `xsend wheel <x> <y> <n>` is X11 buttons 4 and 5.

A screenshot pair is the instrument. The walk wheels a notch or eight, photographs
the window immediately, waits 1.4 s, and photographs it again. **Nothing is sent
between the two frames**, so any difference between them is the app moving the
pane on its own. A page landing inside that gap is bracketed by it, and ergo's
timestamps say which gap that was.

Difference is measured rather than eyeballed:
`.claude/skills/run-ircx/shift.py` slides an 80-pixel band from the second frame
over the first and scores by absolute difference, so the answer is a number of
pixels.

Over 80 pairs in one walk, **78 were byte-identical**. `02-parked.png` is one of
them. Of the two that were not, one differed only in a 41×11 region at the
bottom right — the status bar's lag figure — and the timeline in it matched at
zero. So the pane is still when nothing arrives, and the instrument reads zero
when nothing moves.

## The one that moved

The remaining pair is step 31, and ergo puts `ircx-2` on the wire at
15:03:15.329 — between its two frames.

```text
c-31-t0  15:03:15.462   the request is out, the page has not arrived
c-31-t1  15:03:16.944   the page has landed
shift    +24px
```

`03-the-page-lands.png` is that pair, cropped to the top of the timeline. Above,
`historian`'s name and clock sit over line 0714. Below, they are gone and the
line has moved up into their place. The reader lost a line off the top of the
window without touching anything.

A second walk caught its own landing the same way and measured **+29px**. Both
are toward the newer end.

## What it is

Not the estimate, which is what the anchor's own comment is about. It is the
head — the line above the list that says **Loading older messages** while a page
is in flight.

`usePrependAnchor` corrects for growth only when a message was prepended:

```ts
if (previous && isPrepend(previous, messages)) {
  anchorScrollTop(el, previous.scrollHeight);
}
```

The head is inside the same scroller, above the list. It appears when
`loadingOlder` goes true and goes when the page arrives — and on the commit where
it appears, no message has been prepended, so `isPrepend` is false and its height
is nobody's business. Everything below it moves by exactly that height.

Measured directly in Chrome, where the numbers can be read rather than inferred.
A row was marked, `loadOlder` triggered, and the marked row found again:

```text
t0   head absent, headPx 0,     scrollHeight 9989,   mark 83px from the top
t1   head present, headPx 24.5, scrollHeight 10014,  mark 107.5px
     moved +24.5px
```

The scroller grew by 24.5 pixels, the head was 24.5 pixels, and the marked row
moved 24.5 pixels. The head's height and the displacement are the same number.

`prependHistory` clears `loadingOlder` in the same store update that prepends the
page, so the head arrives on one commit and leaves on the commit the anchor does
correct. The two frames above catch the leaving; the Chrome measurement catches
the arriving. Nothing in `scrollAnchor.test.tsx` mentions the head at all, which
is why jsdom never saw it: it lays nothing out, so a head of no height displaces
nothing.

**What is not settled** is the net over a whole cycle. If the arrival and the
departure were each a plain head-height and nothing else, they would cancel and
the reader would see a jerk rather than a move. The window pair says the leaving
alone is a 24-pixel move, which the commit arithmetic says should have been
compensated. Whoever fixes this should measure the cycle end to end before
deciding whether the anchor needs the head's height or the head needs to leave
the scroller.

This is #475.

## What this run did not reach

- **A release build.** Debug against Vite, so `StrictMode`, so every effect
  mounts twice. That is the harder case for an effect-ordering defect and the
  one worth walking; the shipped path is the unwalked one.
- **Libera.** No history capability there, so nothing is ever asked and none of
  this can be walked against it. Unchanged since #473.
- **A message arriving live while the reader is scrolled back.** Everything here
  lands above the viewport. What happens when something lands below it, in the
  same pane, at the same time, is untested — and `mergeByTime` is the path that
  would do it.
- **A split.** One pane, and the anchor shares a component with #307's restore.
  Two panes on the same conversation, one at the live edge and one scrolled
  back, is a case this run had no reason to open and no evidence about.
- **A page that arrives while another is in flight.** Both walks scrolled slowly
  enough that each page landed before the next was asked for. The label exists
  because they can overlap; nothing here made them.
