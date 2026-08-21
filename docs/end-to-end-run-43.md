# End-to-end run 43: the anchor held, and the reader moved

Debug build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`. Run 40's
arrangement, unchanged: two panes on one channel, one parked inside the block an
arriving page merges into and the other taken to the top so it asks, with
`docs/end-to-end-30/latepage.py` holding the answer twenty seconds so it lands on
a pane at rest.

Ten walks. Six on the binary anybody builds, four with #606 taken back out. The
`fold` record described below arrived in the middle of the set, so two walks of
each arm carry it and the other six carry the anchor's reading alone.

## What #601 asked for

> Something that names the reader's line rather than their row. […] I would
> rather add that and re-walk than read another frame table.

The addition is on the anchor's own records: the reader's message by id, how far
into its row its line is drawn, the transform of that row, and where the line
lands against the top of the pane. `docs/end-to-end-42/line.py` reads it back and
`docs/end-to-end-43/held.py` is the subtraction.

The first four walks of `main` used it, and it said the reader held to the
pixel — four of four:

```
right pane: anchor y -1295 -> -1295 (+0px), within 30 -> 689 (+659px)
```

`within` is what says the walk was in the arrangement rather than measuring a
reader nothing reached: the page merged into the reader's own row and put 659px
of itself above their line.

## The control, which is where the run turned

`ship` is `main`. `control` is `main` with #606's tie-break reverted —
`git checkout e963c62^ -- src/store/index.ts`, one file, the merge deciding a
shared millisecond towards the window again.

The control moved the parked reader, in the frames, exactly as run 40 measured
it: `629..639` before the page and `621..629` thirty seconds after it in three
walks of four, `622..630` in the fourth. Run 40's own table reads `0630 → 0622`.

**And the records said the reader held.** `anchor y -1367 -> -1367 (+0px)`, in
the same walk, on the same pane, in the same second.

That is not the instrument failing. It is the instrument answering a question
one word away from the one being asked, and the two words are what #601 is:

- the **anchor** names the first message of the row under the scroll offset. In
  this arrangement that row is a run of sixty, and it starts a screen or more
  above the top of the pane — 1295px above it, in these walks;
- the **fold** is the message at the top of the pane, which is what the reader is
  reading.

A page merging into that row *below the anchor's message and above the fold*
moves everything the reader can see, and every term the anchor computes reads
held — because the message it holds did not move. The hold is not wrong. It is
holding the wrong thing.

## Both messages, and the arithmetic closes

`fold` now rides the records beside `line`, latched at the landing from the
commit before it. Two walks each way:

| arm | anchor | fold | frames |
|---|---|---|---|
| ship | +0px | +0px | `629..638` → `629..638` |
| ship | +0px | +0px | `629..638` → `629..638` |
| control | +0px | **+547px** | `629..639` → `622..630` |
| control | +0px | **+618px** | `629..639` → `621..629` |

The `within` terms say why, and they are the whole mechanism on one line. In both
arms the fold's own message gains the same 659px above it inside the row — the
page is the same page. What differs is how much of that the anchor's message
gained:

| arm | anchor `within` | fold `within` | the difference |
|---|---|---|---|
| ship | 30 → 689 (+659) | 1285 → 1944 (+659) | 0 |
| control | 30 → 71 (+41) | 1285 → 1944 (+659) | 618 |
| control | 30 → 142 (+112) | 1285 → 1944 (+659) | 547 |

With the tie-break, the arriving page goes in front of the messages it ties with,
which is above the anchor: the anchor sees the whole 659px and corrects for the
whole of it. Without it, the page waits behind every tied message and goes in
*below* the anchor's own line — 41px of it above, 618px of it between the anchor
and the reader's eyes — and the correction is short by exactly what the frames
show.

## What this run claims

**#601 is #602.** The displacement it reports is the mis-ordered merge putting an
arriving page between the reader's anchor and the reader, and #606 fixes it. Six
walks on `main`: the anchor `+0px` in all six, the fold `+0px` in the two that
carry it, and the parked pane painting `629..638` in the frame before the page
and in the frame thirty seconds after it, every time. Four with the tie-break
out: the same `+0px` on the anchor, the reader moved in all four.

Two things it does not claim:

- **that the anchor is right in general.** It holds the first message of the
  reader's row, and this run is a demonstration that where the row is a run of
  sixty, holding that message is not holding the reader. Nothing in this walk
  moves the fold with the order fixed — but nothing here rules out another
  arrangement that does, and the fold record is now the way to ask;
- **anything about the release build.** Every walk here is the debug binary
  fetching the frontend from Vite. Run 42 established that #602 reproduces
  identically on both, which is why this run could afford ten walks at two
  minutes rather than six.

`docs/measurements.md` has no figure at stake. The 250–580px in #601 was a real
distance, measured on a real defect, and it is the same defect as #602's.

## What the harness learned

- **A record that names one message is a record of one message.** The reader is
  two things — what the anchor holds and what the fold shows — and in a channel
  that speaks in runs they are a screen apart. A walk that reads only the first
  passes on a build that displaces the reader by 618px.
- **The landing commit cannot be asked anything.** Its rendered window is the one
  the *old* scroll offset asked for, and `scrollTop` has already been written to
  the new one: the same row reads `rowtop=332` there and `rowtop=13398` on the
  commit after. Both readings here start two records back — the commit record and
  the stack record are written by one effect.
- **A probe's record is an argument, and an argument is evaluated.** `probe` is a
  branch the minifier drops; the object handed to it is not. A record that reads
  the DOM has to be skipped at the call site or the app anybody runs pays for it,
  which is what `probing` is for.
- **305 notches is still the parking**, on this binary as on run 40's release
  one, and `park.sh` says so in a fifth of a walk. `band.py` is the check that
  the pane landed in the band rather than the assumption that it did.
