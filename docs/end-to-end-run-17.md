# End-to-end run 17

Run on 2026-08-12 against the same local `ergo` 2.19 on `127.0.0.1:6677` runs 15
and 16 used, in the release app, on the two defects run 16 left fixed in a test
and unverified in the application.

Run 16's headline was negative and its reason was precise: twenty walks
separated the two builds by nothing, because the walk everybody had been running
did not reproduce the defect in the *old* build either. It named what it had not
settled, and this run takes the first of those — **a machine under load**, which
runs 14, 15 and 16 each named and none of them ran.

**Neither #494 nor #496 is reproduced in the application.** Eighty fresh-profile
walks under load and twenty-nine two-launch runs, split between the two builds,
and the count is zero on both for both defects. What this run has that run 16 did
not is the reason the count is zero rather than merely the count, an instrument
that has been made to admit it, and one measured difference between the builds
that is not either issue.

## Load is not a fourth item on the list

Runs 14, 15 and 16 carried "a machine under load" as an open question of its
own. It is not one. It is the instrument #494 needs, and the argument is in the
code rather than in the wish.

#494 is a race between two reads. `loadOlder` asks the archive with `before`
null, awaits it, and the server's own `CHATHISTORY LATEST` lands while it is in
flight; the archive's answer is then filed in front of the window. Which read
wins is the whole of it, and on this machine the archive wins nearly every time:

- the profile is under `/tmp`, which is a **tmpfs**, so `load_history` is a RAM
  read behind `idx_messages_timeline`, and
- ergo is a local socket a millisecond away.

So loading the *disk* would do nothing, and run 15's `stepdelay.py` — which
holds the server's side — tilts the race the wrong way: a page held back lands
*after* the archive read rather than during it. What stretches the archive read
is the CPU. `load_history` is a 200-row page followed by `attach_reactions`,
`attach_annotations` and `attach_raised`, and each of those runs **one statement
per message** — six hundred executions behind a Tauri command, on a runtime
whose threads have to be scheduled. Contend for those and the read stretches;
the socket does not.

Thirty-two `while :; do :; done` loops on sixteen cores is the level this run
used. It is enough to change what the app does — the walks take 42 s each rather
than 40, and the two builds part company on how often they page back at all —
and not enough to reproduce the defect.

## Three ways to see a defect that is not there

The useful part of this run is that it produced **three** false positives before
it produced a number, and each was caught by a different discipline. Run 16
spent one release build to turn a clean result into an honest one. This run
spent three readings.

### The date had started to drift

Run 16 read the *day* the asked-from message was said, and called an ask stamped
today the inversion. That was sound while `#scrollback` held run 15's 900 lines
from 2026-08-11 and nothing else. It is not sound now:

**every walk joins and quits, and ergo replays both as `HistServ` messages.**
After run 16's twenty-eight sessions the newest 200 messages the server holds
are mostly today's join and quit noise, and this run added eighty more sessions
to it. The oldest row a *correct* head names is drifting into today on its own.
Run 16's test was on its way to reporting the defect in the build that does not
have it, and nothing about the test would have looked wrong while it did.

The question was never about a date. It is whether the head the client asks from
is the oldest row it holds, which the wire answers without one.

### The minimum was read after the file rather than at the ask

The replacement compared each ask against the session's *finished* minimum. That
reported **19 of run 16's 20 clean walks** as inversions: a walk pages back more
than once, so the second ask names the oldest of a page that arrived after the
first ask, and every earlier ask is behind it by construction.

It was caught by running the new instrument against run 16's committed logs
before running it against anything new. **An instrument that cannot reproduce the
last run's answer is not ready to give this one's.**

### A tap reads the socket, not the client's list

This is the one worth carrying, because it qualifies run 16's own headline.

Run 16's general claim was that **a client that asks the server questions will
tell you what it thinks it holds**, and that this is cheaper and sharper than
photographing a window. The first half is true. The second half has a condition
nobody had stated: the tap sees bytes cross the socket, and the client sees them
some milliseconds later, after it has parsed, stored and re-rendered them. An
ask that goes out while a page is arriving therefore looks exactly like an ask
from the wrong end of a list — except that the client had not been given the
list yet.

Without a settle window, eighty walks flagged sixteen asks: **eight on each
build**, which reads as a fix that changes nothing at all. Every one of the
sixteen named its row between **1 and 13 milliseconds** after the older rows hit
the tap:

```text
walk   ask at older seen  ask names / oldest on wire
   3   99.609     0.007s  2026-08-11T12:16:57.534Z  2026-08-11T12:16:07.475Z
   4  141.070     0.004s  2026-08-11T12:16:58.034Z  2026-08-11T12:16:07.976Z
  15  615.495     0.001s  2026-08-11T12:16:13.483Z  2026-08-11T12:15:23.415Z
  …
flagged 8   gap min 0.001s  median 0.007s  max 0.011s
```

Seven milliseconds is not long enough for the client to have parsed a page,
written it to SQLite, merged it and decided to ask for another. The ask was
settled before those rows reached it. `ahead.py` now discounts any ask that
crossed a page in flight, and **reports how many it discounted** — a run where
that number is large and the count is zero has not shown the client is ordered,
only that the walk asks while pages are landing.

This one nearly shipped as a sighting. The calibration run that motivated the
whole load arm — one walk at thirty-two spinners, on the build with the defect,
asking from `12:16:55` while holding `12:16:05` — had a gap of **6 ms**. It was
this artifact, and it was reported as the first sighting of #494 in the app
before the gap was measured.

## The count

Forty walks against each build at thirty-two spinners, control first, the arms
run one after the other because the load is the variable and two arms at once
would each be measuring the other. Every walk on both arms recorded at least one
ask, so no walk was spent.

```text
                    walks   asks   ahead   unresolved   repeated   not settled
b75edf2 (before)       40     69       0            0          0            11
61a98fa (after)        40    121       0            0          0             8
```

`ahead` and `unresolved` are #494's two shapes and `repeated` is #496's. All
zero, on the build that has both defects in it.

### The #496 arm, and why its zero is worth less than it looks

Fifteen two-launch runs against each build at the same load, counted with the
same reader:

```text
                    runs   asks   repeated   asks per run
b75edf2 (before)      14     25          0   2 2 2 2 2 2 1 2 2 1 2 2 1 2
61a98fa (after)       15     89          0   6 × 14, and one 5
```

One control run is missing because its walk produced no wire log at all.

Zero repeats on both. **That is not fourteen runs' worth of evidence**, and the
asks-per-run column is why. A duplicate needs two asks to be a duplicate, and
the control makes exactly two per run — where run 16's control run that *did*
show the duplicate made five. Fourteen runs here buy about 25 asks; run 16's
four bought about 20. The exposure is comparable, so 0 against 1 separates
nothing, and this run reaches the same verdict run 16 did by a longer road.

What is new is knowing *why* the walk is cheap now. The two-launch walk pages
back until it reaches the start of what it can see, and `#scrollback` has
drifted: a hundred-odd sessions of join and quit noise have pushed run 15's 900
seeded lines back, so a walk reaches the end sooner and asks less on the way.
The same drift that was about to break run 16's date test has quietly taken most
of this walk's exposure with it.

A count of #496 wants a channel with a great deal of history behind the landing
page, so that each run makes a dozen asks rather than two. Re-seeding is the
cheap part; the arm is then the one `dupes.sh` always described.

### The one thing that did separate the builds

The fixed build asks the server for a page far more often than the build before
it, on the same walks, in **both** arms:

```text
                    fresh-profile walk    two-launch walk
b75edf2 (before)      69 over 40  (1.7)     25 over 14  (1.8)
61a98fa (after)      121 over 40  (3.0)     89 over 15  (5.9)
```

The two-launch figure is the striking one: six asks a run against two, and the
control's two is so consistent that it looks like a wall rather than a race.

That is not a defect sighting and it is reported as an observation rather than a
mechanism. The candidate: what changed in `prependHistory` is what the window's
head *is* after a page is filed, and the head is what both the `#487` guard and
the next ask are computed from —

```js
if (current.messages[0]?.id === current.askedBehind) return "skipped";
```

— so a window whose head is not its oldest row can match `askedBehind` when a
correctly ordered one would not, and skip the ask it would otherwise make. That
would mean the old build stops paging back early, which is a reader who cannot
reach their own history rather than a reader who sees it out of order.

**It is the only difference between the two builds this run measured in the
running app**, it is consistent across 69 walks, and it wants a walk of its own
rather than a sentence here. It is also the first thing any of runs 14 to 17 has
found that distinguishes the builds at all.

## The harness was guessing, and only load showed it

The first loaded walks all died before reaching the server:

```text
Error: no such table: networks
    at seedNetwork (window.mjs:222)
```

`window.mjs` launches the app once to let it create and migrate the archive,
kills it, sleeps **1500 ms**, and then writes a network row into the SQLite file.
The window appearing is not the schema existing, and 1500 ms stood in for the
condition. On an idle machine it held. Under thirty-two spinners it did not, and
every walk failed in a way that reads as *the app* failing under load.

It waits for the `networks` table now, with the app still up — which is the
whole of the correction. The first attempt waited after the kill and timed out
after a patient 30 seconds on a table nothing was left running to write.

**That fix then moved the failure rather than removing it.** The 1500 ms had
been covering two conditions, not one: the migration finishing *and* the app
dropping its SQLite lock. Replacing it with a schema check and a 250 ms pause
left the second uncovered, and the #496 arm started failing on
`database is locked` — one run in ten, under load, in a way that again reads as
the app rather than the harness. Both halves are conditions now: the seed
retries while the file is locked, and neither wait is a duration. The arm was
restarted from zero afterwards so that every run in the count sits on the same
harness.

This is the same shape as the defect the run is chasing, twice: a fixed delay
standing in for a condition somebody could have asked about. It is test
infrastructure rather than the app, and both arms of this run use a
byte-identical copy of it.

## What a frame does and does not show

Run 15's evidence for this defect was two screenshots, and this run went looking
for the same thing in the frames of the walks the wire had flagged. Control walk
3 draws `line 0893`, `0894`, `0895` under `Yesterday`, then the
`From the server's history` seam, and then `line 0693` onwards — later lines
above earlier ones, which reads as exactly the inversion.

**It is not, on its own.** Control walk 5, which the wire did not flag, draws the
same shape: `0897`, `0898`, `0899`, the seam, then `0698`. Whatever puts a block
of 08xx above a block of 06xx is in both, and a frame that appears in the flagged
and the unflagged walk alike separates nothing. Both are kept —
`control-w03-flagged.png` and `control-w05-unflagged.png` — because the pair is
the evidence and either alone is a misreading.

That is run 16's lesson arriving from the other direction. A walk that passes on
both builds has measured neither; so has a frame that looks broken in both.

## What this run did not settle

- **Whether #494 is fixed in the live app.** Unchanged from run 16, and now with
  a load arm ruled out at this level as well. Eighty walks, zero sightings on the
  build that has the defect. The walk that reproduces it has still not been
  found, and the two-read race it needs has not been shown to be reachable from
  a fresh-profile walk at all.
- **Load above thirty-two spinners.** The level was chosen because it changed the
  app's behaviour and sixteen did not; it was not raised until the walks stopped
  completing, and where that ceiling is has not been measured.
- **The asks-per-walk difference**, which is the only separation this run found
  and has a candidate explanation rather than a verified one. If the guard is
  what does it, the old build's reader stops short of their own history, which
  is a worse symptom than the one #494 describes and is not what either issue
  claims.
- **#496's rate**, again. Fourteen control runs bought no more exposure than run
  16's four, because the channel has drifted and the walk now asks twice where it
  used to ask five times.

## For the next run

`ahead.py` and `gap.py` are in `docs/end-to-end-17/`, and the settle window is
the part to carry rather than the count. The general form of run 16's argument
survives with a condition attached:

**A client that asks the server questions will tell you what it thinks it holds
— but only about the rows it has had time to file.** Anything read off a tap is
a statement about the socket until the arrival times say otherwise, and the gap
that made sixteen asks look like eight inversions per build was seven
milliseconds wide.

The other half of that: **check a new reader against the last run's logs before
pointing it at new ones.** Two of this run's three false positives were caught
that way, and the third was caught only because the first two had made it a
habit.
