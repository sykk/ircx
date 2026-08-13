# End-to-end run 18

Run on 2026-08-12 against the same local `ergo` 2.19 on `127.0.0.1:6677` runs 15
to 17 used, in the release app, on the thread run 17 left at the top of its
list: **the only difference between the two builds it could measure in the
running application.**

Run 17 found the fixed build asking the server for a page 3.0 times per walk
against the old build's 1.7, and 5.9 against 1.8 in the two-launch arm,
consistent over 69 walks and explaining neither #494 nor #496. Its candidate was
the `#487` guard, and its verdict was that the difference "wants a walk of its
own rather than a sentence here."

It had one. **The guard can wedge a conversation, the wedge is in `main`, and
both builds separate on it cleanly and deterministically.** Three walks a build,
1 ask against 2, 3/3 either way — where runs 14 to 17 needed forty walks apiece
to separate nothing.

## The defect

`loadOlder` arms the guard before it asks:

```js
store.setAskedBehind(key, oldest?.id ?? null);
outcome = await pageBack(network, target, oldest);
```

and the guard refuses any later scroll that would ask the same question again:

```js
if (current.messages[0]?.id === current.askedBehind) return "skipped";
```

That is #487 and it is right: the page does not arrive down the call that asked
for it, so between the answer coming back and the page landing the pane's oldest
message is still the one it just asked about, and every scroll event of a wheel
burst computes the identical request.

What disarms it is the page landing and moving the oldest message. **Nothing
else does, short of a reconnect** — `forgetPageBacks` is the only other writer
of `askedBehind`, and it fires on a connection event.

So a page that never lands never disarms it. Three ways for that to happen, and
none of them is exotic:

- the server ignores the request,
- it answers with an **empty batch**, which appends nothing, or
- it answers with a batch carrying only what the pane already holds, which is
  #486's shape and which `mergeByTime` files as nothing new.

In all three the reader is left at the top of a conversation whose `hasMore` is
still true, being told the server has not sent the page yet, and **no scroll
they make will ever ask again.** The history is on the server and the client has
stopped going to get it.

That is a worse symptom than the misordering #494 describes, which is what run
17 suspected when it wrote the difference down.

## The fix, which is one line and needs no timer

`page_back` already distinguishes the case. `ask_server` gives the round trip
sixty seconds (`ROUND_TRIP_TIMEOUT`), and `Waiting` is what comes back when that
deadline is spent — the answer is not merely absent, it is *late*, and it is
late by a minute before the awaited call even returns.

So the guard comes off on `waiting`:

```js
more = outcome !== "end";
if (outcome === "waiting") store.setAskedBehind(key, null);
```

The ask it named has already outlived its own deadline, so a later scroll is not
the duplicate #487 was worried about. #487's bursts were the same msgid 37 to 40
ms apart; this one is a whole round trip later.

**It cannot become a burst either, and that is why no timer is wanted.**
`loadingOlder` is set before the archive read and cleared only by
`prependHistory` at the end, so it covers the entire sixty seconds of the retry
— and `loadingOlder` is the first thing `loadOlder` checks. One retry per round
trip is the ceiling, enforced by machinery that was already there. A timer would
have been a second, weaker copy of it.

The priming loop that reads until a pane can be scrolled does not spin on this
either: a `waiting` outcome adds no messages, so `now === held` latches
`stalled` and the effect stops. The retry is the reader's scroll, which is the
right thing to have asked for it.

## The instrument

`holdpage.py` is a proxy that passes every byte through untouched **except the
batch answering a `CHATHISTORY BEFORE`**, which it drops.

Run 15's `stepdelay.py` was the wrong tool here and the reason is worth keeping.
It holds everything the server says; past sixty seconds it holds `PING` with the
rest, and a client that reconnects has left the state under test rather than sat
in it — a reconnect is precisely what clears `askedBehind`. The walk would have
disarmed the guard by the only other route there is and reported a fix that was
not there.

Dropping one batch leaves the session up, the client's own asks unheld, and
nothing missing but the page. The status bar in both frames below says
`Connected` with 15 caps negotiated, sixty-five seconds into the wait.

`--pass` drops nothing and is the same proxy otherwise. It was run first:

```text
   10.430 ask CHATHISTORY BEFORE #scrollback msgid=_iiw8keybbiuypq6pb3dy8vf63w 200
   14.245 ask CHATHISTORY BEFORE #scrollback msgid=_dtn5c397zps66injddumc46mfe 200
   21.725 ask CHATHISTORY BEFORE #scrollback msgid=26fkwtriv7745y8i5vgksr9jha 200
   33.926 ask CHATHISTORY BEFORE #scrollback msgid=8i78vmifqyhpbx9jrcfkmw6qfe 200
```

Four asks, each naming an older message than the last: pages arriving, the guard
disarming as each lands, the client walking back through history the way it
should. An instrument that cannot show the working case is not evidence about
the broken one, which is run 17's discipline applied before the count rather
than after it.

## The count

Three walks a build. Not a race — the only timing in it is a deadline the walk
waits out — so three is not run 17's forty for the same reason a deterministic
result is not a rate.

```text
                    walks   asks/walk   dropped/walk
b75edf2-style (before)  3           1            202
with the fix            3           2            404
```

`dropped` is the proxy's own count of swallowed lines: 202 is one batch of 200
messages with its `BATCH +`/`BATCH -` either side, so the control's server
answered once and the fix's answered twice. Both builds' asks were answered by
ergo and neither reached the client.

The fix's second ask names **the same msgid as its first**, about ninety-three
seconds later:

```text
   10.412 ask @label=ircx-1 CHATHISTORY BEFORE #scrollback msgid=_quxmmhkiixv79xy4zt2mga8uwa 200
  103.653 ask @label=ircx-2 CHATHISTORY BEFORE #scrollback msgid=_quxmmhkiixv79xy4zt2mga8uwa 200
  111.639 end asks=2 dropped=404
```

The same question again is exactly what a retry is, and the sixty-second gap
plus the walk's own scrolling is where the ninety-three comes from. The control
logs one ask and then nothing for the rest of the walk, however much it is
scrolled.

## The frames, which separate too

Run 17's warning was that a frame appearing in the flagged and the unflagged
walk alike separates nothing. These do separate, and in the reader's own terms.
Both are taken five seconds after the same scroll, sixty-five seconds after the
page-back that was never answered:

- `control-wedged.png` — "The server has not sent this page yet", unchanged from
  the frame before the scroll. Nothing was asked and nothing is happening.
- `fix-retrying.png` — "Loading older messages". The retry is in flight.

The wire is still the evidence and the frames are corroboration: they are walk
1's, while the count is 3/3.

## What this run did not settle

- **Whether a real server produces the condition, and how often.** The proxy
  reproduces the *effect* — a page that never lands — and not any particular
  cause. #491's origin is a run where a page took 45 seconds, so slow pages on
  this path are real; sixty is the threshold and nothing here measures how often
  a live network crosses it.
- **The empty-batch and duplicate-batch routes**, which are argued from the code
  above rather than walked. The walk drops the batch outright. All three end in
  the same place — `askedBehind` naming a message nothing moved — so the fix
  covers them, but only the dropped one has been seen.
- **#494 and #496**, still unreproduced in the application after runs 16, 17 and
  this one. Nothing here changes their standing.
- **Whether this is the whole of run 17's asks-per-walk difference.** It is a
  mechanism that produces exactly that difference and it is now demonstrated.
  Run 17's walks had no proxy dropping anything, so what left their old build
  asking less often was some page not landing for an ordinary reason, and this
  run has not shown which.

## For the next run

The thread run 17 named is closed, and the way it closed is the part to carry:
**it was settled by a unit test before any binary was built.** The wedge was
reproduced in `Timeline.test.tsx` in the component, the walk was built only once
the test said the state was reachable, and the walk then confirmed it in the
assembled app on the first attempt.

Runs 14 to 17 spent eighty walks apiece failing to reach two races from the
outside. This one reached a deterministic defect from the inside in one test,
and the eighty walks became six. Where a defect has a state rather than a
timing, the test is the cheaper instrument and the walk is the confirmation —
not the search.
