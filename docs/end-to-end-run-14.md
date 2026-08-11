# The fourteenth run: the same cycle, in the window it ships in

Run on 2026-08-10 against a local `ergo` 2.19 on `127.0.0.1:6677`, in the
assembled app on `Xvfb :90`, against `main` at `5066a9e`. Both builds: the debug
app against Vite, and the release app `npm run tauri build -- --no-bundle`
produced.

Run 13 fixed the landing page's anchor in headless Chrome and closed by naming
what it had not reached:

> **The assembled app.** This is Chrome against Vite, so it is the frontend's
> arithmetic and not WebKitGTK's. Run 12 walked the same cycle in the window and
> read +24 at the landing […] the same walk there now is unwalked.

This is that walk. **The release app holds the reader still** — six landings of a
200-message page, none of them moving the pane by more than 2px, where run 12
read +24 and +29 on the same cycle. The debug app does not: eight landings, four
of which moved the reader, one by 88px. And the wire has two defects on it that
no screenshot would have shown, both filed.

## The channel and the walk

`docs/end-to-end-12/seed_history.py` unchanged, against an `ergo` moved to
`:6677` to match it — 900 messages, `line 0001` to `line 0900`, every
seventeenth wrapping to three rows, the two seeders staying in the channel so
the in-memory history survives.

`end-to-end-14/walk.sh` is the walk: 120 steps, each a burst of 24 wheel
notches up the timeline, a screenshot immediately, 1.4 s, and a second
screenshot. **Nothing is sent between the two frames**, so any difference
between them is the app moving the pane on its own — run 12's instrument, and
`end-to-end-14/pairs.py` is what reads it, `md5sum` first and the harness's
`shift.py` only on the pairs that differ. A positive shift is content that moved
up the window.

Landings are 30 to 35 steps apart, which puts a wheel notch at 14–17px against
a message block's 57 — the pane needs about 2,800 notches to be read from the
live edge to line 0001, and this walk covers two thirds of it.

## The instrument had a hole, and the first three runs fell in it

Three walks straight at ergo read +24, −11 and 0 at their landings, and two of
those numbers are worth nothing. Against a loopback server a `CHATHISTORY`
answer comes back inside the 250 ms `import` takes to photograph the window, so
the page had already landed before the first frame of the pair was taken:

```text
request 23:50:23.227  after p032-t1 (23:50:22.733)  before p033-t0 (23:50:23.514)
request 23:51:53.777  after p072-t1 (23:51:53.359)  before p073-t0 (23:51:54.140)
request 23:53:24.482  after p112-t1 (23:53:23.994)  before p113-t0 (23:53:24.772)
```

Every one of them went out in the gap that also holds the wheel, which is the
one gap nothing can be attributed to. A pair reading zero there says only that
the walk missed it.

`end-to-end-14/delay.py` closes it: a proxy that passes what the client says
straight through and holds what the server says for 800 ms. The request goes out
on the wheel, the frame is taken 300 ms later, and the page arrives half a
second after that with nothing else happening — so the landing is bracketed by
construction rather than by luck. The status bar reads `Lag 801ms` for the whole
walk, which is how a screenshot says the proxy is in the path.

Delaying only one direction is what makes this safe: the client's own timing is
untouched, so nothing about when it asks, or how it draws, is being measured
through the delay.

## What the two builds do

Every row below is a landing, matched to the `CHATHISTORY BEFORE` in ergo's log
that asked for it, walked through the 800 ms proxy.

| build | landings | shift at each |
|---|---|---|
| release | 3 | 0, 0, 0 |
| release, again | 3 | +2, 0, +2 |
| debug | 4 | +2, **−88**, 0, **−22** |
| debug, `StrictMode` removed | 4 | 0, 0, **−42**, 0 |

`02-the-reader-holds.png` is a release landing. The two frames are the same
picture — line 0525 to line 0528 in the same places, to the pixel — and the only
thing that has moved between them is the scrollbar's thumb, which is 200
messages of new scroller above the reader. That is the whole of what the anchor
is for.

`03-the-reader-moves.png` is the debug landing measured at −88, on the same four
lines of the same channel. Line 0525 starts the top frame and line 0524 starts
the bottom one: the reader was pushed a message and a half down the timeline by
a page that landed above them.

**`StrictMode` is most of the difference and not all of it.** Removing it from
`src/main.tsx` and walking the debug app again takes three of the four
displacements away and leaves one, of 42px. So the anchor is not merely
double-mounting: something in the debug build's timing reaches a commit ordering
the release build's does not, four times in eight against none in six. The
release measurement is the one that says what a reader sees, and it says they
are held.

What would settle the rest is a measurement inside the window rather than of it.
`WEBKIT_INSPECTOR_SERVER=127.0.0.1:9333` does bring up a listener in the debug
app — that much is confirmed — but it answers neither HTTP nor a plain
WebSocket at `/`, `/socket` or `/inspector`, so run 13's numbers cannot be read
here without speaking WebKit's own inspector protocol. Nobody should reach for
that before deciding the residual matters.

## Two things on the wire

Neither is visible in a screenshot, and both are in every run of both builds.

**A channel opens by asking the server for the page it is already being sent.**
Within 500 ms of `CHATHISTORY LATEST`, and before anything is scrolled, ircx
asks for a second page:

```text
00:00:02.355  CHATHISTORY LATEST #scrollback * 200
00:00:02.499  @label=ircx-1 CHATHISTORY BEFORE #scrollback msgid=eavv2ib6… 200
```

That msgid is not a message. `CHATHISTORY AROUND` on it, from a second client,
answers `walker joined the channel` — the reader's own join line, the newest
thing in the pane. Replaying the request byte for byte returns 200 messages,
`line 0701` to `line 0900`: exactly the page `LATEST` is already delivering.
Seven runs, seven of them, both builds. This is #486.

**The release app asks for every page twice when the answer comes back fast.**
Straight at ergo, each landing is two `CHATHISTORY BEFORE` requests carrying the
same msgid, 36 to 66 ms apart:

```text
@label=ircx-2 CHATHISTORY BEFORE #scrollback msgid=sii2yyi5kuzt67pepjv79nn5si 200
@label=ircx-3 CHATHISTORY BEFORE #scrollback msgid=sii2yyi5kuzt67pepjv79nn5si 200
```

Three of three landings in one run and one of one in another. It does not happen
in the debug build, and it does not happen in the release build through the
800 ms proxy — which is what says it is a race the fast answer wins rather than
anything about the scroll that asked. This is #487.

## What this run did not reach

- **The beginning of history.** 120 steps reads back to about line 0237, which
  is four pages and not five, so the short page and the `Beginning of history`
  seam are not in this run. Run 12 walked those to line 0001 and #472 is what
  they were for; nothing here bears on them.

- **The empty pane.** `04-the-empty-pane.png` is one frame, from the first walk
  of the day: the timeline drawn with nothing in it at all, at the moment a
  page was asked for with the scroller at the top. The frame 1.4 s later is a
  normal pane. It has not happened again in six walks, and one frame is not
  enough to file — it is here so that the next run knows to watch for it.

- **A page landing while the reader is at the live edge.** Everything here is a
  reader who has scrolled back. The pane that is following has no anchor to hold
  and is a different path.

- **Two panes on one conversation.** Unchanged from run 12, which named it for
  the same reason: the anchor shares a component with #307's restore and nothing
  has yet put two panes on one channel with a page landing in one of them.

- **A machine under load.** The displacement the debug build shows is a timing
  one, and every measurement here was taken on an idle machine. What a busy one
  does to the release build is the obvious way the residual could stop being
  debug-only, and nothing here has asked it.
