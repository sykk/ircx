# End-to-end run 19

Run on 2026-08-12 against the same local `ergo` 2.19 on `127.0.0.1:6677` runs 15
to 18 used, in the release app, on the last thing run 17 left open: **#496's
rate, counted on a channel that can pay for it.**

Run 17 reached the same verdict run 16 did and said plainly that it had not
earned it:

> A duplicate needs two asks to be a duplicate, and the control makes exactly
> two per run — where run 16's control run that *did* show the duplicate made
> five. Fourteen runs here buy about 25 asks; run 16's four bought about 20. The
> exposure is comparable, so 0 against 1 separates nothing.

This run changes one variable: the channel. Everything else — the walk, the
reader, the two commits, the idle machine — is run 16's.

## The channel had run dry, and why that is not a detail

`#scrollback` held run 12's 900 seeded lines, `line 0001` to `line 0900`, and
every walk since has joined and quit. Ergo replays both as `HistServ` messages,
and its in-memory buffer is `channel-length: 2048` events. A hundred-odd
sessions of join and quit noise had pushed the seeded lines out of it.

The symptom on the wire was the one run 17 measured: a walk reached the end of
what the server could give it after two pages and stopped asking. Not because
the client gave up, but because there was nothing behind the landing page except
its own history of arriving and leaving.

Before re-seeding, the newest 50 messages the server held were 50 out of 50
`HistServ` join and quit lines.

## Re-seeding, and the ten minutes nobody had budgeted

Run 12's `seed_history.py` takes a count, so re-seeding is one command — and the
count matters. 2400 into a 2048-event buffer fills it entirely with seeded
history and evicts the noise, which is the most a walk can be given without
touching the server's configuration.

What that hid is worth writing down, because it nearly produced a walk against a
moving channel. **`seed_history.py` printing "seeded 2400 messages" means the
socket took them, not that the server did.** Ergo's `fakelag` allows a burst of
five commands and then two per second per client, so two seeder clients deliver
about four messages a second and 2400 lines take **ten minutes** to reach the
history buffer.

Probing the channel immediately after the seeder's own success line found the
newest message at `line 0405`, with noise still interleaved and pages coming
back in an order the seed did not choose. That is not a defect in anything; it
is a walk started in the middle of a write. `awaitseed.sh` polls the highest
`line NNNN` the server holds until it stops moving, which is the condition the
"seeded" line was standing in for.

After the drain, ten pages of seeded history sit behind the landing page:

```text
landing page: 200 msgs, 199 seeded, range 1700..1898
page  1: 200 msgs, 200 seeded, 1500..1699
page  2: 200 msgs, 200 seeded, 1300..1499
...
page  9: 200 msgs, 100 seeded, 0001..0100
page 10:  46 msgs,   0 seeded
page 11: empty — server has nothing further
```

## The exposure this buys

A trial run made **ten asks** where run 17's made two, and its last frame drew
`line 0370` under "Beginning of history" — the walk consumed every page the
server had.

That last part is the useful property rather than a flourish. Twelve scroll
bursts against ten available pages means the walk **saturates**: it runs out of
history before it runs out of scrolling, so both arms take the full exposure the
channel can give and a small difference in how fast a build pages cannot show up
as a difference in how much it was asked to page.

```text
                     asks per run   where
run 16 (control)              ~5    900 seeded lines, before the drift
run 17 (control)               2    the drifted channel
run 19                        10    2400 seeded lines
```

## What the walk is

Run 16's `wire.sh`, unchanged in shape. The first launch builds the archive and
keeps the profile; the second opens on it, which is the only way to get a pane
whose timeline is empty while the archive behind it is not — the pane asks the
archive with `before` null, `load_history` answers with the newest page it holds,
and the server's own `CHATHISTORY LATEST` lands while that read is in flight.
That is the shape #496 needs.

`dupes-deep.sh` adds the twelve bursts and the per-run bookkeeping, and reads
the result with run 17's `ahead.py` — the same reader, checked against run 16's
committed `control-duplicate.txt` before it was pointed at anything new, where
it still reports the one duplicate that log contains.

**Unloaded, deliberately.** Run 16 saw the duplicate on an idle machine; run 17
saw none under thirty-two spinners. The one condition a duplicate has ever
appeared in is the idle one, and adding load would have changed two variables at
once. `dupes-deep.sh` takes a spinner count for the other arm.

## The count

Twelve two-launch runs a build, control first, one arm after the other because
they share a machine and `target/release/ircx` both.

```text
                      runs   sessions   asks   ahead   unresolved   repeated   not settled
b75edf2 (before)        12         24    120       0            0          0             1
2f2b128 (after)         12         24    120       0            0          0             4
```

Ten asks in every run on both builds, without exception. **Zero duplicates on
the build that has #496**, against six times run 17's exposure and six times run
16's.

### What that is worth, which is more than run 17's zero

Run 17's zero was explained away by its own exposure, and correctly: fourteen
runs bought 25 asks, run 16's four bought 20, and 0 against 1 at that size
separates nothing. That explanation does not survive this run.

Run 16 saw one duplicate in about twenty control asks. If that were the rate, 120
asks would be expected to produce about six, and the chance of seeing none is
roughly two in a thousand. So the duplicate run 16 photographed was **not a
one-in-twenty event**. It needed something this walk does not reproduce, and the
missing ingredient is not the amount of paging — that has now been ruled out by
raising it fivefold and changing nothing.

### The builds are identical on every measure this walk takes

Not merely equal in the count. The page-backs themselves are the same:

```text
before  10 asks  steps: 49.6 49.6 50.1 50.1 50.1 50.1 50.1 50.1 50.1
after   10 asks  steps: 49.5 49.6 50.1 50.1 50.1 50.1 50.1 50.1 50.1
```

The seeded channel is 200 messages to a page and fakelag let the seeder write
about four a second, so a page is fifty seconds of history. Every ask on both
builds moves the head a full page.

The five crossings the run recorded — one before, four after, every one between
67 and 73 ms — are run 17's settle-window artifact, discounted by the reader
that exists to discount them. One against four out of 120 asks apiece is not
being offered as a difference between the builds: it is four events, in the band
where the tap and the client disagree about what has been filed, and run 17's
whole lesson about that band is that it is where a small count means nothing.

Run 17 found one difference between these builds in the running app and this run
finds none, which is consistent: the difference run 17 measured was the paging
guard wedging, and run 18 fixed that on the other side of `waiting`. It never
appears here because nothing in this walk leaves a page unanswered.

## A fourth way to see a defect that is not there

Run 17 collected three and this run adds one, in the same shape: a story that
fit the data until the data was measured rather than read.

The control arm's first page-back names the newest end of the seeded block, and
#496 is precisely an ask computed from the wrong end — `older[0]` is the
conversation's oldest only while the page is behind the window. So the first ask
looked like it was asking the server for the page the archive had just handed
the pane: a wasted round trip, in every run, invisible to `repeated` because the
two asks name two different msgids.

It was reported as a likely live sighting of #496 before it was checked.

`steps.py` checks it without needing to know anything about the archive. A
wasted ask moves the head by less than a page and the next ask closes the gap;
the run above is nine full steps with no short one anywhere, on both builds. The
archive's page and the first server page are **adjacent, not overlapping**. No
ask was wasted, and the shape that suggested otherwise was the ordinary one.

The discipline that caught it is run 17's, arriving for the fourth time: an
instrument, not a reading. What made it catchable in a minute was that the claim
had a number attached — if the first ask is wasted, the first step is short —
rather than being a description of what the log looked like.

## Three things about the harness

**`seed_history.py` printing "seeded" means the socket took the lines.** Ergo's
`fakelag` allows a burst of five commands and then two a second per client, so
two seeders deliver about four messages a second and 2400 lines take ten minutes
to reach the buffer. A probe run on the seeder's own success line found the
newest message at `line 0405`, noise still interleaved, and pages coming back in
an order the seed did not choose — a channel mid-write, which would have been
walked as a channel. `awaitseed.sh` waits for the condition instead.

**`ahead` is not a meaningful column for this arm**, and run 17 printed it
anyway. `ahead.py` says in its own docstring that the walk starts on a fresh
profile, so everything the window holds came over the wire — which is what lets
"the oldest delivered" stand in for "the oldest held". A two-launch walk breaks
that: most of what the second launch's window holds came off disk and never
crossed the tap. The zeros in that column above are honest only in the sense
that nothing was flagged; they are not evidence about ordering. `repeated` is
wire-only and stays valid, which is why run 17 counted with it.

**`pgrep -x ircx` matches another session's app.** The script that was to swap
the binaries between arms waited for any process named `ircx` to exit, and a
debug build from another session had been running on this machine all along. It
would have waited for ever. Matching on the worktree's own path is the fix, and
the general form is the one already in this project's notes: a shared machine
means a name is not an identity.

## What this run did not settle

- **#496 in the application, again.** Four runs have now failed to reproduce it
  from the outside, and this one removes the explanation the last one offered.
  The fix is right — `Timeline.test.tsx` covers it and the reasoning in #497 is
  sound — but the walk that shows it in the app has not been found, and the
  search has now cost more than the fix did.
- **Whether the two-launch walk can reach it at all.** The condition #496 needs
  is an archive read answered with a page that is not behind the window. This
  channel may no longer present it: the seed is one contiguous block, so the
  first launch archives a page that *is* behind everything the second launch
  sees. Run 16's channel had yesterday's history under today's join noise, which
  is a different shape, and the one sighting anybody has came from it.
- **Load.** Unloaded on purpose, for the reason given above. Run 17's loaded arm
  found nothing on a channel too shallow to say so; a loaded arm on this channel
  has not been run.

## For the next run

Run 18 settled its defect in a unit test and then confirmed it in the app in six
walks. This run spent twenty-four walks on a race and confirmed nothing, which
is the fourth time in a row for that question.

The recommendation is not another arm. **If #496 is to be seen in the
application, the next attempt should manufacture its precondition rather than
wait for it** — inject messages between the two launches, so the second launch's
archive is genuinely behind a server that has moved on, which is the shape run
16 stumbled into and nobody has built on purpose. If that does not produce it
either, the honest conclusion is that the fix is verified by test and the app
walk is not the instrument for it, and this line of runs should stop.
