# End-to-end run 28: eleven pages, and the two ends of a chain

Release build at `baf4b3e`, local `ergo` 2.19 on `127.0.0.1:6677`, `#scrollback`.
Ten walks: three quiet, three under load, three with the answering batch
emptied, and one control with nothing emptied.

Run 27 shipped `PageBackOutcome::Deferred` and closed with four things it had
not settled. Two of them are what this run is: whether the ordering the fix
turns on holds where the answer is not instant, and the empty-batch route, which
was still argued from the code. It also wanted something run 17 asked for and
nothing since has had — a channel with enough behind it that a walk makes a
dozen asks instead of two.

## The channel already had the depth

Run 17 found `#scrollback` drifted: 900 seeded lines pushed back by a hundred
sessions of join and quit noise, so a walk reached the start of history in two
asks where it used to take five. Every paging figure since was measured through
that, and the plan here was to seed it again.

It did not need it. `depth.py` asks the way the client asks — `LATEST * 200`,
then `BEFORE msgid 200` until a page comes back short — and `depth.txt` is what
it answered:

```text
page  1: 200  'line 2368 …' … 'depthprobe joined the channel'
…
page 11:  48  'line 0526 …' … 'line 0573 …'

#scrollback: 2048 events behind the live edge, over 11 pages
```

Some run since 17 filled it to the ceiling, and what binds now is ergo's own
`history.channel-length: 2048` rather than drift. Eleven pages: ten full and a
short one.

**Two things that reading is worth carrying.** A page is counted in *events*, so
every walk's own join and quit costs the far end two lines — the oldest went
from `line 0502` to `line 0526` between the probe that opened this run and the
one that closed it, so a walk photographing the start of history photographs a
slightly different line each time. And a channel at the ceiling cannot be
deepened by seeding it: 2048 is what the server will hold whatever is sent.

So `depth.py` is the check to make before trusting a paging count, and not the
seeder this run expected to write.

## What eleven pages buy that two cannot

A count of asks has one thing to say: whether one ask became two. A chain of ten
has two more, and both are failures no previous walk could have seen —

- a link asked twice, which is `#487`; and
- a link that stops early, which is a reader left short of history the server
  still holds, and the worse of the two because the pane says nothing is wrong.

`chain.py` reads both off the wire, per walk, with the size of the batch that
answered each ask and the round trip. The proxy is run 27's `replaypage.py`
under `--pass`, which replaces nothing: the instrument that found #522 watching
the fix work.

## The chain, quiet and under load

Three walks each, fresh profile every time, identical in everything but the
thirty-two spinners:

```text
              asks  distinct  repeated  unanswered  last page  round trip
quiet   ×3      10        10         0           0         48      2–4 ms
load    ×3      10        10         0           0         48     8–19 ms
```

Ten asks is the whole chain — the join's own `LATEST` is page 1 and ten
`BEFORE`s reach pages 2 to 11 — and the eleventh page comes back at 48 rows,
which is the history running out. Six walks for six identical chains;
`chain-quiet.txt` and `chain-load.txt` are the tables.

`chain-start.png` is the end of it: **Beginning of history** above `line 0506`,
which was the oldest ergo still held at that launch. `load-start.png` is the
same frame from the load arm, above `line 0516` — ten lines on, for the reason
the depth section gives.

**The load arm is the ordering question, and what it can answer is narrower than
it looks.** Run 27 noted that core emits the batch and the outcome on different
channels and that every walk it made saw the batch first. Load is the only lever
here — tmpfs profile, local socket — and it moved the round trip by five times
without moving the chain. What it cannot do is say which order any particular
page took: nothing on the wire records that, and both orders end in the same
state by construction. That part is the suite's, and it is already asserted from
both sides — `index.test.ts`'s *"is answered by a page the window keeps nothing
of"* for the answer-first order, `Timeline.test.tsx`'s *"stops paging when that
page landed before the answer did"* for the other. What this arm adds is that a
machine under contention finds no third order that ends anywhere else.

## The empty batch

Run 27 left this one argued: a page-back answered with a batch carrying nothing
ends as `End` rather than `More`, so it is a different sentence again and no
walk had read it. Both halves are tested — `an_empty_page_is_the_history_running_out`
in core, *"is the beginning of history once the server has none either"* in the
frontend — and the seam between them had never been put on a wire.

It cannot be walked against ergo directly, which is worth stating because it
took a while to notice: `#scrollback` holds 2048 events, the client asks in
pages of 200, and 2048 is not a multiple of 200. The last page therefore comes
back *short* rather than *absent*. Same branch in `message.rs`, different line
on the wire. A real server reaches the empty batch only where its history
divides exactly by the page size.

So `emptypage.py` — the third of these proxies, and the simplest, because it
holds no state about what the client was sent on joining. `holdpage.py` drops
the batch whole, which is `Waiting`. `replaypage.py` fills it with rows the
client already has, which is `More` and #522. This one keeps the batch and drops
what is inside it, which is `End`.

```text
   14.053 ~~  dropped 200 out of +2
```

Three walks, one ask each, page size 0, and no second ask after a scroll that
goes down and comes back up — run 27's manoeuvre, because a wheel at `scrollTop`
0 raises no scroll event and a pane that had wrongly given up would ask again
here. `empty-says-so.png` is the frame: **Beginning of history** above `line
2360`, the top of the page the join itself delivered, with ten pages still on
the server behind it.

**The control is what makes that mean anything.** The same walk with the same
proxy under `--pass` asks twice, keeps going, and draws no end of history —
`empty-control.png`, the reader at `line 2083` with the rest above them. One
frame says the history stops here and the other does not, on the same build,
the same channel and the same bursts.

## The label that never went out, which was a PING

The first chain read ten asks under labels `ircx-1` to `ircx-11` with `ircx-8`
missing, and a label allocated but never sent would be a page-back the client
composed and dropped. It is not. Five lines above the gap:

```text
  115.039 ask @label=ircx-7 CHATHISTORY BEFORE #scrollback msgid=7qggk… 200
  120.001 --> PING ircx8
  134.041 ask @label=ircx-9 CHATHISTORY BEFORE #scrollback msgid=pv9fm… 200
```

`session.rs` mints the keepalive token out of the same counter the request
labels come from — `ircx8` against `label=ircx-8` — so a walk quiet enough to be
pinged has a hole in its label sequence for every ping. Nothing collides and
nothing is lost; the two namespaces differ by a hyphen.

It cost the time it takes to read the code twice, which is why `chain.py` now
collects the pings and subtracts them, and reports only what is left. **A wire
log is a shared numbering, and a gap in it is a question rather than a finding.**

## What this run does not claim

- **It does not separate two builds.** A pre-#522 build reads the same here, and
  necessarily: the wedge needs a page carrying nothing the pane already holds,
  and a real page-back down a real chain carries two hundred new rows every
  time. Run 27 did that separation with a proxy and it stands. This is coverage
  of a path nothing had walked, and the six clean chains mean what they mean
  because the chain had ten links and two named ways to fail, not because a
  control failed them.
- **The empty-batch walk is a proxy's empty batch.** No server has been observed
  producing one. The condition is stated above and is arithmetic rather than
  exotic, but it is still inferred.
- **Run 17's asks-per-walk difference** — six a run against two, between the
  #494 and #496 builds — is not touched here and is still unexplained. This run
  makes it cheaper to look at: the channel now has the depth that measurement
  wanted, and `chain.py` reads the shape rather than the count.
- **Whether a real server produces #522's condition** is run 27's first open
  item and remains open.
