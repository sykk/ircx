# End-to-end run 16

Run on 2026-08-12 against the same local `ergo` 2.19 on `127.0.0.1:6677` that
run 15 used, in the release app, on the residual run 15 could not reduce and on
the two fixes that came out of reducing it.

Run 15 photographed a pane drawing its own opening rows above the history,
twice in ten walks, and said what would settle it: **a reading of the store's
list rather than of the window**, which run 14 had wanted for its own residual
and neither run got. This run has one, and it is the useful part of it —
`pageBack` sends the oldest message the window holds, so every
`CHATHISTORY BEFORE` on the wire *is* the frontend's own head, stated by the
client, in a form nobody has to read a screenshot to judge. `tap.py` records
both directions and `asked.py` resolves the msgid back to when it was said.

**What this run did not do is confirm the fix.** The headline is negative and
the shape of it matters more than the result: twenty walks separate the two
builds by nothing at all, because the walk everybody has been running does not
reproduce the defect in the *old* build either. What separates them is one
observation, four runs apart, of a different shape entirely.

## The instrument

`tap.py` forwards a session and writes both sides down. It holds nothing —
run 15's `stepdelay.py` exists to bracket a page *landing*, and what run 16
needs is not when a line arrives but what the client asked for.

Two things it got wrong first, both of which read as a clean result:

- **A request is not at the head of its line.** ircx labels a page-back, so the
  line is `> @label=ircx-1 CHATHISTORY BEFORE …`, and a `grep` anchored on the
  verb counted twenty requests as zero. The first reading of this run was
  "no page-backs at all", which is a sentence about a regular expression.
- **A tap that cannot bind reads an empty log rather than saying so.** Run 15
  left a `stepdelay.py` on each of 6691-6695, still running four hours after
  its walks ended and still holding the ports its own doc tells the next run to
  use. They were left alone; run 16 works higher up. Anything here that names a
  port names a free one.

## The head, twenty times

Ten walks against the fixed build (`e72fc3b`) and ten against the build before
it (`b75edf2`), each a fresh profile, each opening `#scrollback`, filling from
the join's `CHATHISTORY LATEST`, and reading back to the top. The channel is
still run 15's — 900 `line NNNN` messages seeded on 2026-08-11, which is what
puts a `Yesterday` between them and the walk's own day.

Both builds, all twenty walks, identically:

```text
walk  LATEST  BEFORE   asked from
   1       1       2   2026-08-11T12:16:28.505Z   2026-08-11T12:15:38.436Z
   2       1       2   2026-08-11T12:16:29.006Z   2026-08-11T12:15:38.937Z
   …
  10       1       2   2026-08-11T12:16:33.012Z   2026-08-11T12:15:42.942Z

days asked from   ['2026-08-11']
asks from today   0
```

`tapped-walks.txt` is the log that came from, cut to the lines `asked.py`
reads so it can be run again.

Every ask names yesterday, and each walk's second ask is older than its first.
A head stamped *today*, in a window that also holds yesterday, is what #494's
inversion would look like from here, and there is not one in twenty walks.

**This is not evidence the fix works.** The control says the same thing, and
the control has the defect in it. What the timings show is why: the first
page-back goes out around sixteen seconds in, long after the join's page has
landed, so the pane's priming read of the archive happened against an archive
that was still empty — and an empty archive returns nothing to file in front of
anything. The race #494 describes never gets a chance to happen. Run 15 saw the
inversion twice in ten walks of this same shape, so something about those two
is not in these twenty, and this run cannot say what.

`01-head-at-the-foot.png` and `02-read-back-into-yesterday.png` are the shape
when it is right, for the next run to have something to compare against.

## The second launch is a different path

Nothing had walked a pane opening on an archive that already holds the channel,
and it does not do what a first launch does. There is no `CHATHISTORY LATEST`
in it at all:

```text
  15.874  > CHATHISTORY TARGETS timestamp=…T17:25:47.622Z timestamp=…T17:25:57.032Z 50
  16.873  > CHATHISTORY AFTER #scrollback timestamp=…T17:25:47.622Z 200
```

It catches up from where it left off rather than asking for the newest page.
That matters to #494 and #496 because both are about something landing while
the archive is being read, and `AFTER` is that something on every launch after
the first. `03-second-launch.png` is the pane it produces.

It is also why the first attempt at this saw nothing: a twelve-second window
ended while the catch-up was still the newest thing on screen, before any
scroll had asked for a page. The walk scrolls now.

## One duplicate, on the old build

The first two-launch walk against `b75edf2` asked the server for the same page
twice:

```text
  68.011  > @label=ircx-4 CHATHISTORY BEFORE #scrollback msgid=qwqsxqp8f5hsxkzcnavim86drn 200
  68.048  > @label=ircx-5 CHATHISTORY BEFORE #scrollback msgid=qwqsxqp8f5hsxkzcnavim86drn 200
```

Thirty-seven milliseconds apart, same msgid, two labels. That is the `#487`
guard not firing, which is exactly what #496 said would happen when
`askedBehind` is free to name a row that is not the window's head —
`control-duplicate.txt` is the session it came from.

It is the only one. Counting repeated msgids over four two-launch runs per
build:

```text
                     runs   with a repeated page-back
b75edf2 (before)        4                           1
e72fc3b (after)         4                           0
```

**Four runs against four cannot tell one-in-four from none**, and this run does
not claim they can. What it has is a defect seen once, on the build that has
the fault in it, in the shape the issue predicted, and not seen on the build
that does not — which is a reason for the next run to walk this path a few
dozen times, not a verdict.

## What this run did not settle

- **Whether #494 and #496 are fixed in the live app.** Both are races, both are
  rare, and the walk that reproduces either reliably has not been found. The
  fresh-profile walk does not reproduce #494 even in the build that has it.
  The two-launch walk reproduces #496's duplicate about a quarter of the time,
  which is enough to hunt with and not enough to conclude from.
- **A machine under load**, still. Run 14 named it, run 15 named it again, and
  this run reached for it and ran out of walk before it got there. It stays the
  obvious way run 14's debug-only residual could stop being debug-only.
- **The inverted head itself.** It has a mechanism, a test and a fix; what it
  does not have is a second sighting. Run 15's two frames are still the only
  ones.

## For the next run

The instruments are in `docs/end-to-end-16/`. `tap.py` and `asked.py` are the
reusable pair and the argument for them is general: **a client that asks the
server questions is a client that will tell you what it thinks it holds**, and
that is cheaper and sharper than photographing a window. Anything about the
order of a timeline can be asked this way.

`dupes.sh` is the shape a frequency question wants — the same walk against one
binary, several times, counted rather than read. Point it at forty runs rather
than three and the table above becomes a number instead of an anecdote.

Two things worth carrying:

- **A walk that passes on both builds has measured neither.** Twenty of the
  twenty walks here are in that category. Building the control was what turned
  a clean result into an honest one, and it cost one release build.
- **`--keep` leaves its profile behind.** Every two-launch run here left one
  under `/tmp/ircx-window-*`; they are the archives the second launches opened
  and nothing deletes them.
