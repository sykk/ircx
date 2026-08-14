# End-to-end run 25: the two fixes in the build that ships

Release build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`.
Scripts in `docs/end-to-end-25/`; `run.sh` is the whole of it.

## The question

Run 24 answered #508 and said what its answer did not cover:

> the build measured here is not the build that ships

The arm that took the parked pane's shift from 6 in 100 to 0 in 100 ran on a
binary with `VITE_PROBE=1` compiled into it — a record raised on every commit of
either timeline, a queue, and an IPC call every 100ms. That is the honest cost
of instrumenting from inside, and it leaves the claim resting on a build nobody
runs.

#516 is the same gap from the other end. The head that says a page is loading
belongs to the pane that asked now rather than to the conversation, and that fix
landed on `Timeline.layout.test.tsx` alone. It has never been in front of a
window.

So this run puts both in front of one, on the binary anybody would install.

## The two builds

Both are `npm run tauri build -- --no-bundle` with `VITE_PROBE` unset. The
control is the tree at `fd85cb8`, which is where run 24's control arm was taken;
the fix is `main`, carrying #515 and #516. The two commits are three files apart
and none of them is Rust, so the arms are one frontend bundle apart and the
binaries name theirs:

```text
control  /assets/index-DMQkW2_N.js
fixed    /assets/index-xgZDHXxK.js
```

**The probe is gone rather than merely off**, which is the claim this run exists
to make and therefore the one it checks rather than asserts. Built without the
flag, the whole of what survives in the bundle is one member of the object
`ipc.ts` exports:

```text
certificateFingerprint:i=>U("certificate_fingerprint",{path:i}),probe:i=>U("probe",{lines:i})
```

No record, no queue, no flush, no call site. It is unreferenced, and it is there
because the rest of that object is used.

## The walk

Run 23's, unchanged: the same channel seeded to 800 lines by the same
`seed.py`, two panes on one conversation, the right one parked 300 notches up
with nobody touching it, the left one paging back twice, three frames. A rate is
only comparable to one taken the same way, and the rates this is read against
are run 23's 2 in 72 and run 24's 6 in 100.

**The arms alternate rather than following one another.** Run 24's ran back to
back, so an hour of drift on a machine several sessions share — another
session's build, the fan — sits inside its p-value. Alternating puts that drift
in both arms. That is the one change to the method, and it is why `one.sh`
exists: run 23's loop is over runs, and the interleave needs the loop outside.

**The two arms did the same amount of paging**, which is what makes a rate per
landing comparable at all. Three notches of wheel is a fixed input; how many
pages it draws out of the server is the client's answer to it, and both fixes
touch what a pane believes it is owed. `pages.py` counts the `BEFORE` asks on
the walked launch:

```text
control  148 pages over 50 runs — 48 runs asked 3, 2 asked 2
fixed    151 pages over 50 runs — 49 runs asked 3, 1 asked 4
```

## What 100 landings an arm did

| the parked pane | control | with #515 and #516 |
|---|---|---|
| pixel-identical | 80 | 87 |
| differed, did not move | 16 | 13 |
| **moved** | **4** | **0** |
| landings | 100 | 100 |

Every move is −24px, one line height, on the first landing. Fisher two-sided
p = 0.121.

### The control, without the instrument

**4 in 100, against run 24's 6 in 100 with the probe compiled in.** That is the
half of run 24's caveat that mattered: the instrument was not the experiment.
#508 is on the binary that ships, at a rate the instrumented build measured
correctly, and the records run 24 read were records of the app rather than of
the recording.

### The fix, and what this run does not establish

0 in 100, and p = 0.121 — short of run 24's 0.029 on the same walk at the same
size. This arm is consistent with the fix working and does not on its own
demonstrate it. What carries #515 is still run 24's discriminator, which is a
stronger instrument than a rate: the write that did the damage went from 6 of
151 head arrivals to 0 of 149, so the mechanism stopped happening rather than
stopping being visible.

A second interleaved batch would settle the rate, and was declined as not worth
two hours against a mechanism already established. The bound this leaves is the
one run 24 left: 0 in 100 puts the fixed arm's rate under about 3%.

## The instrument over-counted, and this is where it showed

`measure.sh` called five landings moves. One of them was not.

```text
run42 a-parked->b-one-page  shift -202px (residual 0.01)
```

−202px is the exact figure `still.py`'s docstring records from #510's control,
and its cause is written down there: `paneshift.py` slides an 80px band over a
channel that repeats itself every couple of rows and takes the best-scoring
offset, so it can lock onto a wrong one and report it at a residual a real
translation would be proud of. `still.py` was built as the guard against this
and only answers whether *anything* changed; on run42 something had, so the
landing went through to be given a size, and a size is what it got.

The message column settles it. Between those two frames it is **byte-for-byte
identical** — 0 by absolute error over x 748–1050 — while the four real moves
score around 5.5e8 there. A pane that translated draws different text at every
row. Run42's text did not move at all; only the spine beside it changed.

So `tally.py` now reads a move off the message column, and asks `paneshift.py`
only how far a move already established went. The three states are unchanged;
what changed is which evidence decides the third.

**Runs 23 and 24 are not affected**, and that was checked rather than hoped.
Every landing either of them counted is −24px exactly — one line height, never a
mislock — and run 24 has a second, independent discriminator over the same
landings: the probe records say something wrote to the scroller in exactly those
6 head arrivals and in none of the other 145. Two instruments agreeing on the
same six is not something this failure mode can produce.

## The middle row is the spine, and cannot be the head

`measure.sh`'s comment reads a landing that differs without moving as the head
that says a page is loading, drawn in a pane that asked for nothing because
`loadingOlder` belonged to the conversation. Run 24's table carried that
reading, and it is wrong twice over.

Run 23 had already photographed the real cause and named it — `run2-spine-only.png`,
"the group's spine, arriving or leaving where the landing page regrouped the
messages already on the screen". This run counts what that run photographed, by
splitting `still.py`'s crop at the spine and asking each band separately
(`where.py`, over all 200 landings):

| where the difference sits | control | fixed |
|---|---|---|
| spine band only | 14 | 8 |
| message column only | 2 | 0 |
| both bands | 4 | 5 |

The fixed arm's five "both" are five landings scoring an identical 293837 in the
message column, and a difference image says why they are identical: the whole of
it is the word `tcache`, one topic label arriving over a run. That is a
regrouping, three orders of magnitude away from a translation's 5.5e8, and the
gap is why the two need no threshold anybody has to choose.

**And the head cannot be that row at all in this arrangement.** The parked pane
sits about 720 lines below the top of its own content, so the head is far above
the fold and has no pixels there to change. Its only reachable effect on a
parked pane is through content height — the anchor correcting for a row that
arrived above the reader, which is a *move*. So #516's contribution belongs
beside #515's in the bottom row of the table, not in the middle one, and the
middle row was never going to go to zero.

## What this leaves

- **#508 is on the build that ships**, at 4 in 100 landings with no instrument
  in it. Run 24 measured 6 in 100 with one, and run 23 2 in 72 with none.
- **The fix arm is 0 in 100** and this run's p is 0.121, so the arm is
  consistent with run 24 rather than an independent confirmation of it.
- **A landing that differs without moving is the spine or a topic**, in both
  builds, and #516 is not visible in that row because nothing about the loading
  head ever was.
- **`paneshift.py` will name an offset for a pane that did not move**, twice
  observed now across three runs, and the message column is what refuses it.

What no walk here has watched is the head itself. #516 changed a sentence at the
top of a pane, and every frame this run took is of a pane parked far below it —
so the fix is verified in the sense that nothing regressed around it, and
unverified in the sense that nobody has photographed the line it governs.

**That walk is harder to build than it looks**, and the difficulty is worth
writing down rather than discovering twice. The line is a row at the top of the
timeline, so a pane that can show it is a pane scrolled to the top of its own
content — which is the condition on which that pane asks for a page itself, and
a pane that asked is one #516 says *should* draw the line. Photographing the
case the fix is about needs a pane whose head is on screen and which has not
asked, and reaching the top is what does the asking. Holding the server's
answer with `docs/end-to-end-15/stepdelay.py` gives the frame time to be taken
but does not resolve that; it wants an arrangement nobody has designed yet.

So `Timeline.layout.test.tsx` is what holds #516, and `docs/manual-verification.md`
now says the live path is open rather than covered.
