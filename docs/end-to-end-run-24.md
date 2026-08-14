# End-to-end run 24: #508 from the inside, and its mechanism

Release build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`.
Scripts in `docs/end-to-end-24/`; `run.sh` is the whole of it.

## The question

#508: two panes on one conversation, one parked in the archive with nobody
touching it, and a landing in the other one moving it by 24px. Run 22 measured 5
in 18, #510's arms 4 and 2 in 72, run 23 2 in 72 on a channel whose rows can
change height. Five walks and three test PRs had ruled out the head arriving and
leaving, the anchor's placement, the restore still reconciling, a history rule
landing above the reader, and a mounted row losing a line to regrouping.

All of them photographed the pane before the landing and after it. **A
photograph cannot tell the two possible defects apart**: a band of text 24px
lower is either `scrollTop` written to the wrong place, or `scrollTop` written to
the right one with the content above the reader growing under it afterwards.

So this run asks the window.

## The instrument

`probe` is a Tauri command that appends lines to the file `IRCX_PROBE` names.
A file rather than a console message because WebKitGTK writes none anywhere the
process can see — `enable-write-console-messages-to-stdout` is off and wry never
turns it on — so a release window has no other way to say anything.

`src/lib/probe.ts` buffers and flushes every 100ms, off the layout path the
records come from, and **is compiled out unless the build asked for it**:
`VITE_PROBE=1` at build time, or `ON` is a false constant and the calls are
branches the minifier drops. Checked rather than assumed — a build without it
carries no record, no queue and no call site, and what survives is the one line
of `ipc.ts` that would make the call, unreferenced, because it is a member of an
object the rest of the app uses. So the app anybody runs raises no record and
calls no command.

Which means the build measured here is not the build that ships, and that is the
first thing this run checks rather than asserts.

A record goes out on every commit of `usePrependAnchor`, on every scroll event,
and at the two other places that write `scrollTop`. Each commit record carries
where the reader's own message was drawn on the commit before and where it is
drawn now, so

    moved = (drawn - top) - held.delta

is how far the message under the reader's eyes travelled during that commit, and
`before` against `top` says whether anything wrote to the scroller to make it
happen. `x`, the scroller's left edge, is what names the pane: a view id is
arbitrary and the frames are photographs.

## The walk

`parked.sh` is run 23's — the same channel, the same arrangement, the same notch
counts, the same three frames — with two environment variables added. A rate is
only comparable to one taken the same way. The scripts that are not the
instrument are called by path out of `docs/end-to-end-23/` rather than copied.

## What 100 landings did

50 runs, two landings each, in the pane whose reader asked for nothing
(`parked-shifts.txt`):

| the parked pane | landings |
|---|---|
| pixel-identical | 81 |
| differed, measured +0px | 13 |
| **moved −24px** | **6** |

**The instrument did not make it worse.** 6 in 100 against run 23's 2 in 72 on
the same walk, Fisher two-sided p = 0.47 — the same rate as far as 172 landings
can tell, which is not very far and is why the arms are reported rather than
pooled. The probe is not what is being measured.

## The mechanism

`read.py` turns a landing into a ledger of the parked pane. Run 4, whose own
records are `run4-probe.log` and whose two frames are `run4-a-parked.png` and
`run4-b-one-page.png`; runs 14 and 17 agree with it to the pixel:

```text
     ms  kind    branch   msgs  before     top   held  moved
  12631  commit  head      204    6621    6645 zihgnm      0
  12635  commit  none      204    6632    6632 zihgnm     24
  12637  commit  none      204    6632    6632 uudaun      0
```

1. The left pane asks for a page, so `loadingOlder` goes true — and the "Loading
   older messages" head is drawn in **both** panes, because that state belongs to
   the conversation rather than to the pane that asked.
2. In the parked pane the anchor's `head` branch does exactly its job:
   `scrollTop` 6621 → 6645, the head's 24px, and the reader's message is left
   where it was. `moved` is 0 on that commit.
3. **Then something writes `scrollTop` again before the next commit**: 6645 →
   6632.
4. That next commit takes branch `none` — `movedInList` is false, because no
   *message* changed place; only the head appeared — so nothing puts the reader
   back. Their message ends 24px lower.

**So it is neither of the two things a photograph could have been hiding.** It is
a correct write, undone by a second write from somewhere else, with nothing
arranged to notice.

### Who writes the second one, and why it costs exactly 24

The writer is the virtualiser's `applyScrollAdjustment`, correcting for a row it
has just measured above the fold. It computes the new position as
`getScrollOffset() + delta` — and `getScrollOffset()` returns
`@tanstack/virtual-core`'s **cached** `scrollOffset`, which is refreshed only
from its `scroll` event listener. The anchor assigns `el.scrollTop` directly, and
WebKit delivers the scroll event for that assignment asynchronously. In the
window between the two, the cache holds the position from *before* the anchor
wrote.

The arithmetic says so in all six, `before` on the anchor's own commit being the
stale baseline:

| | anchor's baseline | anchor wrote | virtualiser wrote | its delta |
|---|---|---|---|---|
| run 4 | 6621 | 6645 | 6632 | +11 |
| run 14 | 4889 | 4913 | 4900 | +11 |
| run 17 | 4232 | 4256 | 4243 | +11 |
| run 24 | 10257 | 10281 | 10422 | +165 |
| run 32 | 9297 | 9321 | 9420 | +123 |
| run 50 | 10667 | 10691 | 10722 | +55 |

Every one of them is `baseline + delta`, never `anchor's position + delta`. The
correction itself is right; what it discards is the 24px the anchor had just
added. **That is why the shift is always exactly one head's height and never any
other number**, however large the row measurement that triggered it.

It also settles something run 22 read the other way. That run measured 3 moves of
−24 and 2 of +24 and concluded the cause could not be anything inserted once
above the reader, since an insertion can only push down. But the head *leaving*
is the same race with the sign reversed: the anchor subtracts 24, the stale write
discards that, and the reader ends 24px higher.

### The discriminator, over every arrival

`heads.py` finds every commit where the head arrived in the parked pane — 151 of
them across the 50 runs — and reports whether anything wrote to the scroller
before the next commit (`head-arrivals.txt`):

| between the two commits | arrivals | reader moved |
|---|---|---|
| nothing wrote | 145 | 0px, all of them |
| something wrote | 6 | **+24px, all of them** |

The six are runs 4, 14, 17, 24, 32 and 50, which are the six landings the
photographs say moved. No false positive and no false negative in 151.

## Why every earlier arm answered 0px

The race needs a first measurement of an above-fold row to land between the
anchor's write and the scroll event carrying it. `layoutHarness.ts` drives frames
and `scrollTo` by hand — #510 built it that way because jsdom implements
neither — so in the harness the event and the commit are ordered by the test.
The window this defect lives in does not exist there, and five arms measuring 0px
were each measuring an app that cannot have the bug rather than an app that does
not.

The three moves at the first landing all carry delta +11 and the three at the
second carry +165, +123 and +55, which is consistent with what triggers the
correction at all: `resizeItem` compensates an item whose top is above the fold
only on its **first** measurement, or on a re-measurement of one lying entirely
above it. A landing measures rows the pane has never drawn.

## The arm with the fix

The anchor now sends the scroll event itself, at the moment it assigns
`scrollTop`, rather than leaving the virtualiser to hear about the move a frame
later. Same build, same walk, same machine, same server, run straight after the
control (`fixed-shifts.txt`, `fixed-head-arrivals.txt`):

| the parked pane | control | with the fix |
|---|---|---|
| pixel-identical | 81 | 80 |
| differed, measured +0px | 13 | 20 |
| **moved −24px** | **6** | **0** |

Fisher two-sided p = 0.029 on the landings that moved.

**And the mechanism is gone rather than merely quiet**, which is the stronger
half. Of 149 head arrivals in the parked pane, **none** had anything write to
the scroller between the anchor's commit and the next, against 6 of 151 in the
control (p = 0.030). The correction the virtualiser applies is computed from
where the pane is rather than from where it was, and at that position it does
not apply at all.

## What no test covers

The race is not reproducible in `layoutHarness.ts`, and two sweeps went looking:
134 parked positions on a head arrival, then 51 more on the shape the second
landing has, with every write to the parked scroller recorded. In all 185 there
is **exactly one write, the anchor's**, where the live app makes two. The
harness settles the layout between actions, so a first measurement of a row
above the fold never straddles a head arrival there.

So the evidence for this fix is the arm above and not a unit test, and
`docs/manual-verification.md` says so.

## What this leaves

#508 has a mechanism, reproduced 6 times in 100 landings on the shipping walk,
predicted exactly by the records, grounded in the library's own source rather
than inferred from pixels, and answered by a fix that takes it to 0 in 100 on
the same walk.

Two things this run deliberately did not do:

- **The head in a pane that asked for nothing is left alone.** `loadingOlder`
  belongs to the conversation, so a parked pane draws a line saying its reader's
  history is loading when it is not, and paid a 24px correction for the
  privilege. The correction is right now, so the line is a question about what
  the app should say rather than about where a pane sits, and it wants deciding
  on its own evidence.
- **The rate is bounded, not zero.** 100 landings can only say the fix took a
  6% failure below about 3%, and the arm that says so ran on a build with the
  probe compiled in. What carries the claim past that is the discriminator
  going to 0 of 149: the write that did the damage stopped happening, rather
  than stopping being visible.
