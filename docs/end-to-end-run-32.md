# End-to-end run 32: the answer to a question nobody is still asking

2026-08-15, release builds against a local `ergo` 2.19, on the walk in
`docs/end-to-end-32/`.

## The question

Run 30 held a page-back past `ROUND_TRIP_TIMEOUT` and photographed the pane that
gave up on it. Run 31 put a second pane beside it and closed on what neither had
touched:

> **Its answer is never seen.** The second ask is held seventy-five seconds too
> and the walk ends first, so what the client does with two answers to the same
> page-back is unwalked.

#540 is the shape that question has when it is answered badly: the late page
lands against the guard a pane armed for a later ask, the store reads it as that
ask coming back empty, and the conversation ends at a message the server was
never asked about. #541 is the fix — the batch carries the name of the ask it
answers, so a page can only conclude something about the question it belongs to.

Both were written from the code and from a store test. Neither had been walked.

## The instrument

`twoasks.py`, which is run 30's proxy with the delay made selective. It holds
the answer to the *first* page-back on a connection and lets the later ones
through, so the walk drives #540's sequence rather than waiting for it:

```text
1. wheel to the top      the first ask goes out, and is held
2. seventy seconds       ROUND_TRIP_TIMEOUT is sixty, so the pane gives up and
                         draws "The server has not sent this page yet"
3. wheel to the top      the second ask — same message, second label —
                         answered at once, and the reader reads it
4. wheel to the top      the third ask, behind the page that just landed
5. the held answer       let go, carrying the page step 3 already delivered
6. wheel to the top      the reading: does a fourth ask go out?
```

**The reading is a request rather than a picture.** What #540 costs is a
page-back that never happens again — `hasMore` latched false, `loadOlder`
returning `"skipped"` before it reads anything — and a claim about an absent
request is not one a photograph of a pane can make. The proxy's log has every ask
on it, and `read.py` reads the walk off that.

**Two builds, which runs 30 and 31 did not need.** Those walked a path nothing
had been down, so the same binary under a different delay was the control. This
walks a fix. `fixed` is #541 and `prefix` is its parent `ffe0c12`, both built the
way anybody builds it — `npm run tauri build -- --no-bundle`, no probe. A result
that comes out the same on the build before the fix has measured the walk.

**And three timings for step 5**, because where the stale page falls against
step 4 turned out to be the whole of what it can do:

| | |
|---|---|
| `15` | fifteen seconds after the third ask, on a conversation that has finished paging. This is the reader's own shape. |
| `behind` | on the heels of the third ask's answer, written immediately after its closing line — the tightest aim a proxy has. |
| `inflight` | while the third ask is still out: five seconds after it, with its own answer held five seconds longer. |

The first set was `15` and `behind` alone, and it is why the third timing
exists: thirty walks were nearly twenty, and the twenty said the two builds were
alike without having put the question to either.

## What the wire says

Five runs of each build under each timing, the arms alternating run by run.
`again` is whether a page-back went out after the stale page landed. The full
readings are `readings.txt`:

```text
                        #541's build         the build before it
15         run 1-5      asked again              asked again
behind     run 1-5      asked again              asked again
inflight   run 1-5      asked again              nothing, ever again
```

**The reader pages on, in twenty walks out of twenty, when the stale page lands
on a conversation that is not waiting for anything.** Both builds, both timings.
A page nobody is still asking for is filed and forgotten: every row of it is one
the window already holds, and nothing on either build concludes anything from
that.

**And on the build before #541 the reader's history ends, in five walks out of
five, when it lands during another ask.** Three asks went out in each of those
walks and three is the sequence, so nothing followed it: not when the answer the
pane was waiting for arrived, not on the wheel after that. `wedged.png` is that
pane — "Beginning of history" over `line 1002`, with a thousand and one lines
behind it on a server that was answering throughout.

**#541's build asks again in five walks out of five of the same arm**, five or
six asks to their three. `paging-on.png` is that step on the other binary: no
head over the pane at all, and the reader reading at `line 0634`.

## What the records say, which the wire cannot

A second pair of binaries carrying `VITE_PROBE=1`, on the same walk. Two
records: `asked`, a page-back returning, and `landed`, a server-history batch
reaching the store with whatever guard was up when it did. Neither is in the
tree — `probe.patch` is what was applied to each build, shipped rather than
described because the run turns on a value nothing already recorded. Four walks
are in `records.txt` and two of them are below.

The build before #541, on the arm that wedges:

```text
 100.231s  asked    outcome more      armed True  behind nw7esc9t
 100.240s  landed   arrived 200  fresh 200  guard nw7esc9t  hasMore True
 119.607s  landed   arrived 200  fresh 0    guard None      hasMore True
 124.594s  asked    outcome more      armed False behind vfm8aesq
 124.607s  landed   arrived 200  fresh 200  guard None      hasMore False
```

**The stale page concluded nothing on its own.** Line three is it: two hundred
rows, none of them new, arriving against `guard None`. `askedBehind` — the proxy
#540 is written about — was not armed, and on this build it never is for long,
which the next section is about.

**What it did was count.** `afterHistoryLanded` increments `historyLanded` on
every server-history batch, guard or no guard. Five seconds later the reader's
own third page came back, and `Timeline.tsx` compared the count it had taken
before asking against the count now:

```ts
const answered = (held?.historyLanded ?? landedBefore) > landedBefore;
const stillOldest = (held?.messages[0]?.id ?? oldest?.id) === oldest?.id;
if (outcome === "more" && answered && stillOldest) more = false;
```

A page had landed since it asked — the stale one. Its own oldest message had not
moved — the stale page carried nothing to move it, and the page that would move
it was still thirteen milliseconds behind this line. So the pane read #522's
rule, concluded the server had nothing behind that message, and wrote `hasMore`
false. `armed False` is that branch being taken rather than the arming one.

**So #540 is real end to end, and it arrives by the other of the two proxies the
issue names.** The issue's step 6 has the late page landing against `askedBehind`;
what a walk finds is `historyLanded`, the sibling that stands for the same
missing evidence. #541 let both go in the same commit, and this is the walk that
says the second one was load-bearing.

#541's build, in the same arm:

```text
 100.277s  asked    outcome more      behind fzuzzc2u
 100.286s  landed   arrived 200  fresh 200  answers fzuzzc2u  guard fzuzzc2u  hasMore True
 119.439s  landed   arrived 200  fresh 0    answers fzuzzc2u  guard 8jbj8cmu  hasMore True
 124.429s  asked    outcome more      behind 8jbj8cmu
 124.443s  landed   arrived 200  fresh 200  answers 8jbj8cmu  guard 8jbj8cmu  hasMore True
```

**The same landing, and this time the batch says whose it is.** Line three is the
stale page: `fresh 0`, arriving against a guard that *is* up — armed before the
third request went out and still up because that request is still out — and
naming `fzuzzc2u`, which is not the question `8jbj8cmu` the guard was armed for.
`hasMore` stays true. The reader's own page lands five seconds later, names the
guard, takes it off, and paging carries on.

That is the state the fix exists for, and no other arm of this run reaches it.
On the two settled timings the stale page is discarded by whatever happens to be
true when it arrives, which is not the same thing as being refused.

## Why the settled timings did not wedge, which took a set to find out

**The old build's guard is up for about eight milliseconds at a time.** It is
armed after `page_back` returns and taken off by the batch that answers it, and
the two cross on different channels: the batch waits out the pump's window
(`WINDOW`, eight milliseconds, `src-tauri/src/events.rs`) while the command's
answer does not. The five pairs in the `15` walk's records are nine, nine, ten,
fourteen and fifteen milliseconds apart. A stale page aimed anywhere else finds
`guard None`, which is what line three of that walk reads.

It is not always eight milliseconds — when the batch wins the race the guard goes
up *after* its own answer and stays up until the next ask, which in the `behind`
walk was fourteen seconds. Which way round it falls is a race, so a walk that
happens not to wedge has not shown anything about whether it can.

**And aiming at the window folds into it.** `behind` writes the stale page
immediately after the third answer's closing line, and the pump does what the
pump is for:

```text
 114.584s  landed   arrived 400  fresh 200  guard tccus5yd  hasMore True
```

Four hundred messages in one event — the answer and the stale page merged, both
being `MessagesAppended` on one lane inside one window — of which two hundred are
new. A batch with fresh rows in it concludes nothing about the end of history.
The guard was up for that landing, and the aim still missed: what a proxy can
point at is the socket, and by the time these two reached the store they were one
delivery.

**What is left is the round trip.** The harm needs the stale page to arrive while
another ask is out, and on a local socket that is ten milliseconds a page. The
`inflight` arm makes it ten seconds, which is what a slow link does — and a slow
link is the premise of the whole sequence, being what made the first answer late
enough to be given up on.

## What this settles

- **The client does not lose the reader's place over a second answer.** Thirty
  walks; in the twenty where the stale page lands on a settled conversation, both
  builds file it and page on. Run 31's open item, closed.
- **#540 reproduces in the assembled app**, five walks out of five, on the build
  that has it, with the reader left at a false end of a channel the server was
  still answering.
- **#541 holds where it is needed**, five out of five in the same arm, and the
  records show it holding on the evidence it added rather than on timing: a
  guard up, a page with nothing new in it, and the two naming different asks.
- **The path is `historyLanded` rather than `askedBehind`.** #540 named the
  guard; the walk found the count. Both went in #541.

## What it does not claim

- **A rate for anything.** The `inflight` arm is built to make the harm certain,
  not to say how often a real link opens that window. What can be said is what it
  takes: two page-backs outstanding and an answer arriving inside another's round
  trip.
- **That the two settled timings are safe.** They are timings this walk could
  aim, and the guard's own window is a race that this run watched go both ways.
  Twenty walks not wedging is twenty walks that missed.
- **A real server's late page.** The delay is a proxy's, as it was in runs 30 and
  31.
- **Anything about a split.** One pane throughout; #508's shape is two, and run
  31 is where that was walked.
- **That the frames measure anything.** `wedged.png` and `paging-on.png` are the
  same step of two walks and are worth looking at, but every reading in this
  run is a request on the wire or a record from inside the store.
