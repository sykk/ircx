# End-to-end run 30: the page that comes late, and the reader it moves

2026-08-14, release builds against a local `ergo` 2.19, on the walk in
`docs/end-to-end-30/`.

## The question

Run 26 closed on the one thing it could not do. `holdpage.py` drops the batch
answering a page-back and never sends it, which is what makes the waiting state
stable enough to photograph — and means every answer in that run is held:

> **What no walk here holds is a page that lands.** What the head does as the
> page it named arrives — the line going, the anchor correcting for the rows
> that came with it — is `Timeline.layout.test.tsx`'s, still.

That commit is worth reaching because `scrollAnchor.ts` makes a claim about it
that nothing has watched. The head is inside the scroller and displaces every
row below it, and where it *leaves*:

> Its departure needs no term of its own: it leaves on the commit that prepends
> the page, where the offsets on both sides are measured from the top of the
> scroller and carry it.

## The instrument

`latepage.py` is run 26's proxy with the drop made a delay. Held past
`ROUND_TRIP_TIMEOUT` — sixty seconds, `src-tauri/src/state.rs` — the client
stops waiting, and the page then lands against a pane that gave up on it:
`loadingOlder` false again, `askedBehind` never armed, and the oneshot the
outcome would have travelled on dropped at the timeout. A real link rather than
an invented one: the timeout's own comment names 45 seconds a page as the slow
link that found #491.

The control is the same binary on the same walk with the page held twenty
seconds instead of seventy-five, so the client is still waiting when it lands.
That is the ordinary case every other run has measured, and the arms differ by
whether the client had given up and by nothing else.

The arms turn out to differ in one way the walk did not arrange, and it is the
one the question is about. On the late arm the head leaves *on* the landing
commit — `headPx 0` against a `margin` of 24 that is a commit behind it. On the
control it had gone several commits earlier, and the landing commit's `lag` is
0. So the sentence quoted above is a sentence about the late arm specifically,
and the control is a build of the same app where the case does not arise.

## What the frames say

Three walks an arm on the build anybody builds, `still` and `after` beside every
landing so that a distance means the landing rather than a pane that was
drifting anyway:

```text
                     still      landing      after
late    run1          +0px        +38px       +0px
        run2          +0px        +22px       +0px
        run3          +0px        +22px       +0px
in time run1          +0px       +106px*      +0px
        run2          +0px         −2px       +0px
        run3          +0px        +46px       +0px
```

`*` six of eleven strips, which `shift.py` reports and this table keeps: a mode
that thin is a reading rather than a measurement.

**The pane is motionless except when the page lands.** Twelve `still` and
`after` readings at zero, on frames two seconds apart either side, is the whole
of what says the middle column is the landing's.

**The reader moves when the page arrives, and does so in both arms.** The late
arm's three are tight — 22 to 38px, at 10 to 11 strips of 14. The control's are
scattered from −2 to +106 and one of them is the thinnest reading in the run. So
what this establishes is that a landing page displaces the reader; it does not
establish that a late one displaces them further, and nothing here should be
quoted for that.

`owed.png` and `landed.png` are the pair from `late run1`: the head reading
"The server has not sent this page yet" over the top of the content, and the
same pane 1.8 seconds later with two hundred rows above it.

## What the records say, which the frames cannot

The probe build carries `probe.ts`'s record per commit, and it separates the two
things a photograph cannot: a `scrollTop` written to the wrong place, and one
written to the right place and then moved. On the landing commit, the same in
every walk that recorded one:

```text
the landing       msgs  403  top   9245  branch moved
  the write       drawn 9381 - delta 136 = 9245, and the pane went to 9245
  the head        headPx 0 against margin 24, lag -24
```

**The write is exact and the claim in `scrollAnchor.ts` holds.** The anchor put
the reader's message where it was recorded, `drawn - delta`, and the head's
departure is carried by `lag` with no term of its own — on the one commit where
the head is in the DOM and the margin does not know it yet, which is the commit
that comment is about. That sentence has now been watched rather than argued.

**What moves the reader is the fourteen commits after it.** The virtualiser goes
on measuring rows for real, and the anchor's own record of the message at the
top of the scroller drifts while nobody scrolls: `delta -2` at the landing
against `-13` and `-57` at the end of the settling, in two walks of the same
shape. That is the half of #508 the fix in #515 bounded rather than closed, in
the pane that asked for the page rather than the pane beside it, and it is on the
build that ships.

## What this run got wrong first, which is worth more than the table

**The first set measured nothing, six walks out of six.** The waits were counted
from the screenshot taken after the wheel, on the assumption that the ask goes
out at the end of the burst. It does not: a pane asks the moment it reaches the
top of its content, and the burst goes on scrolling against a top it has already
reached for however many notches are left — so the ask can precede the first
frame by ten seconds. Both frames landed after the page, the reader was
identical in them, and the arm reported `+0px` three times an arm. A frame that
appears in both walks separates nothing; here it was the same frame twice.

It was caught by aligning a frame's mtime against the probe's own wall clock and
finding "the frame before the landing" 0.37 seconds after it. `latepage.py`
stamps the release with an epoch now and `pick.py` chooses the straddling pair
against it afterwards, which is why the burst is twenty-six frames: the walk
cannot know when it is asking, so it photographs a window and the reading picks.

**A drift was attributed to the wrong event twice before that.** The +38px was
first read as the landing's, then — on frames labelled by a clock that was six
seconds out — as something the pane did on its own while owed a page, with an
archive-rows hypothesis built on top of it that the records then refuted
(`msgs` never changes between the settling and the landing). It was the landing
all along. Two lessons, both already in this directory's history: a frame's
label is not its timestamp, and a hypothesis that survives one walk should be
put to the records before it is put in a report.

**`shift.py` mislocked before it was made to disagree with itself.** A single
strip of this seed's prose matches a hundred rows, and a strip inside one line
catches a nick and a clock the seed repeats — run 25's `paneshift.py` failure,
met again. It takes fourteen strips now, requires a majority to agree, and
prints the spread and how many were redrawn, so a thin reading looks thin.

## What this settles

- **A page that arrives after the client has given up is drawn correctly.** The
  head's sentence goes, the rows land above the reader, and the pane is not
  wedged: run 26's open item, closed.
- **The anchor's write on that commit is exact**, and the head's departure needs
  no term of its own, which is what `scrollAnchor.ts` says and what nothing had
  watched.
- **The reader is nonetheless moved by tens of pixels**, by the settling after
  the write rather than by the write. #532.

## What it does not claim

- **That a late page moves the reader further than a timely one.** Both arms
  move and the control's readings are the noisier of the two. Three walks an arm
  is not enough to separate them and this run does not try.
- **A cause for the scatter.** 22, 38 and 46px are not one number, and nothing
  here says what decides which. The settling drift the probe reads — −11 and
  −55px in two walks — has the same spread, which is suggestive and is not a
  mechanism.
- **Anything about a split.** One pane throughout. #508's own shape is two, and
  what the pane beside this one does when a late page lands is untouched.
- **A real server's late page.** The delay is a proxy's. What makes it plausible
  rather than invented is `state.rs`'s own note about a 45-second page, not an
  observation.
- **The empty-batch and duplicate-batch routes**, which are runs 27 and 28's and
  are not revisited here.
