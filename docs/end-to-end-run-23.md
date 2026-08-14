# End-to-end run 23: the parked pane on a channel whose rows can change

Release build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`.
Scripts in `docs/end-to-end-23/`; `run.sh` is the whole of it.

## The question

#508: two panes on one conversation, one of them parked in the archive with
nobody touching it, and about one landing in four moving it by exactly one line
of text. Run 22 measured it at 5 in 18. #510's control measured 4 in 72 against
2 in 72 after a fix, which is a coin flip.

Then the harness went in, and #511 and #512 ruled five mechanisms out without
reaching one: the head arriving and leaving, the anchor's placement, the
restore's `scrollToIndex` still reconciling, a history rule landing above the
reader, and a mounted row losing a line to regrouping. Every arm answered 0px.

**The channel was the reason to doubt that.** `docs/end-to-end-22/seed.py` says
in its own header what it is for — nothing opening with `[` or with `nick:`, two
speakers alternating every line — chosen to keep `groups.ts` out of a paging
measurement. It works, and it means no group is ever assigned, no run is longer
than a message, and a page landing cannot alter a row that is already on the
screen. Every measurement of #508 to date has been taken on a channel where the
likeliest cause is seeded out.

So this run brings a channel where rows can change, and drives run 22's walk on
it unchanged.

## The seed

Three people speaking in runs of up to four lines, so blocks form. A declared
topic every 40th line, its name drawn from three that recur — the same name said
again rejoins the group it opened rather than opening a second, so where a page
boundary falls decides which block opens each group and draws its name. An
address wherever the speaker has just changed, which is the other grade
`groups.ts` assigns. Every line still carries `line NNNN`, so a screenshot names
the message at the top of the viewport, and a declared line draws without its
bracket.

**The property is measured rather than intended.** Hold 200 of these lines as a
window and land the 200 behind them as a page:

| | rows in the window | drawing something different afterwards |
|---|---|---|
| run 22's channel | — | 0 |
| run 23's channel | 86 | **12** |

A different number of messages in the block, or the topic's name gone from over
it. Run 22's channel changes none of its own.

The first frame of the walk shows it reaching the app: topic names drawn over
blocks in both panes, an address in the run above them, three speakers in the
roster.

## The walk

`parked.sh` is run 22's, unchanged in arrangement, because the arrangement is
the one #508 was measured in. Two launches a run: one to seed a profile and
split the pane, then a restore on that profile. The right pane is wheeled 300
notches up the archive and left alone; the left pane pages back twice. Three
frames — parked, after one page, after two — and the right pane's own columns
are the measurement.

Every run's wire log says the same thing, which is what makes the frames
readable: one `CHATHISTORY LATEST` on the first launch, then `TARGETS`, `AFTER`
and three `BEFORE` on the restore. The parked pane asks for nothing.

## The instrument, which the smoke run corrected

Stillness is pixel identity over the pane's own columns before it is anything
else. `paneshift.py` slides a band and always answers with an offset, and
#510's control caught it reporting −202px at residual 0.00 over a pane that was
byte-for-byte identical, so an offset on its own is not evidence that anything
moved. `still.py` answers first and `paneshift.py` is asked only to name a
difference already known to exist.

Two things the two-run smoke settled about that instrument:

- **`-metric AE` does not return a pixel count in this build.** The first
  version of `still.py` reported "2.48e6 pixels differ" over a crop of 192,200
  pixels; a full 1200×800 frame scores 5.5e8, or 569 per pixel. The crop was
  applying correctly the whole time — cropping first and comparing gives the
  identical figure — so the fault was in reporting a magnitude at all. Zero or
  not zero is the whole of what it can carry.
- **`differs` is not `moved`.** 20 of the 72 landings below differ without the
  text moving at all, and what differs in them is not what was expected — see
  the spine, under the results. Every landing that differs goes to
  `paneshift.py` rather than being counted as a shift.

## What 72 landings did

36 runs, two landings each, in the pane whose reader asked for nothing
(`parked-shifts.txt`):

| the parked pane | landings |
|---|---|
| pixel-identical | 50 |
| differed, measured +0px | 20 |
| **moved −24px** | **2** |

Both moves are first landings — run 9 and run 14 — and both are exactly one line
of text at residual 0.00, which is the signature run 22 measured. **#508
reproduces on the build that ships today**, at 2 in 72.

**It did not get worse on a channel that groups**, and that is the result this
run was for. #510's arm on run 22's channel, same build, measured 2 in 72. This
one measures 2 in 72. Two arms that agree exactly cannot separate the
hypotheses, so grouping is not indicated as the cause — the seed that makes rows
change height changed nothing about the rate.

### The 20, which are the spine

`run2-spine-only.png` is a difference image of the parked pane across a landing
that measured +0px. What differs is a **vertical line down the left rail** — the
group's spine, arriving or leaving where the landing page regrouped the messages
already on the screen — and the scrollbar's thumb, which moves because the
conversation grew above.

So the regrouping this seed was built to cause **does reach the parked pane**,
in 20 of 36 first landings, and in every one of those 20 it moves no text. The
mechanism #512 tested in the harness and found held is here observed holding
against a real server, twenty times.

Second landings differ twice in 36. The first burst is where the regrouping
lands, which follows from the page that carries it.

### The 2, which moved

`run9-a-parked.png` and `run9-b-one-page.png` are the pair. Afterwards the pane
sits one line lower: `line 0720 ack` has appeared at the top of the viewport and
every line below it is 24px further down, the whole band translating at residual
0.00. A difference image shows every row doubled, which is what a translation
looks like and what a redraw does not.

Something above the reader gained a line and the pane was not put back. The
wire log for that run (`run9-wire.log`) is the same as every other run's — one
`LATEST` on the first launch, then `TARGETS`, `AFTER` and three `BEFORE` — so
the parked pane asked for nothing, as in every run of this arm.

## What this leaves

#508 is reproduced and not explained. What is new:

- It survives the #510 fix, on the shipping build, at about 3 in 100 landings.
- Grouping is not it. The channel built to regroup rows already drawn measures
  the same rate as the channel that cannot regroup anything.
- The regrouping is visible and harmless: 20 landings where the spine changed
  under the reader and not one pixel of text moved.
- When it does move, it moves by one line, and the line arrives *above* the
  reader — content sits lower afterwards rather than higher.

The next attempt has 72 more landings to compare against and a channel that can
be made to do almost anything. What it has not got is a mechanism, and five
walks and three test PRs have now failed to find one; the next thing worth
trying is instrumenting the release build itself at the moment of the landing,
rather than photographing what it left behind.
