# End-to-end run 29: the count run 17 opened, on a channel with depth

Release builds of `b75edf2`, `61a98fa` and `61d8b23`, local `ergo` 2.19 on
`127.0.0.1:6677`, `#scrollback`.

Run 17 measured one difference between the build before #494/#496 and the one
after it, and could not explain it: on identical two-launch runs the fixed build
asked the server for a page **six times a run where the old build asked twice**,
and the old build's two was steady enough across fourteen runs to look like a
wall rather than a race. Runs 18, 27 and 28 each carried it forward untouched.
The candidate run 17 named was the `#487` guard skipping an ask it should have
made, which would mean a reader stopped short of history the server still holds
— worse than either issue claims.

Nothing since could look at it, because every paging walk had a channel that ran
out in two asks. Run 28 found `#scrollback` holds eleven pages, which is what
tells a wall from a channel ending.

## The two builds are the ones that were measured

`run29-before` is `b75edf2`, run 17's control, and `run29-after` is `61a98fa`,
its fixed arm — checked out as worktrees and built with
`npm run tauri build -- --no-bundle`, each carrying a byte-identical copy of
today's `run-ircx` harness. `61a98fa` has no Rust in it that `e72fc3b` did not,
so what separates the pair is the frontend: the two changes below and their
tests.

The third arm is `61d8b23`, which is what ships today and has #501, #508's
anchor work, #516, #520 and #522 on top of the pair.

## What the pair disagrees about

Both changes are in the archive read, and both are about the second visit to a
channel — a pane opening on an empty timeline with a full archive behind it. It
asks the archive with `before` null, which `load_history` answers with the
newest page it holds rather than a page behind anything, and the server's own
`CHATHISTORY LATEST` lands while that read is in flight.

```js
const oldest = older[0] ?? current.messages[0];   // b75edf2
const oldest = olderOf(older[0], live[0]);        // 61a98fa, #496
```

```js
messages: [...kept, ...timeline.messages]         // b75edf2
messages: ordered                                 // 61a98fa, #494 — merged by
                                                  // time when the page is not
                                                  // wholly behind the window
```

Read together they are a way for the guard to arm against itself. The ask goes
out from the archive page's first row, which in that race is a row from today
rather than the window's oldest; the page is filed in front of the window
unconditionally, so the window's head becomes that same row; and
`current.messages[0]?.id === current.askedBehind` is then true on every later
scroll, which is `loadOlder` answering `"skipped"` for the rest of the session.

That is the mechanism run 17's candidate describes. Whether the app reaches it
is what this run walks.

## The walk

`revisit.sh` is run 16's two launches — the first fills the archive, the second
opens a pane on it — with run 28's fourteen bursts on the end, which is enough
wheel to reach the start of an eleven-page channel and three bursts of slack.
The proxy is run 27's `replaypage.py` under `--pass`, which replaces nothing and
is there to write the log.

Two readers, because the chain and the ask are different questions.
`chain.py` is run 28's and counts the links: a msgid asked twice is #487, a link
unanswered is a page that never came. `reach.py` is this run's and reads what
each ask *named*, resolving the msgid through the line the server sent it on —
which is how #496 was found by hand in run 16, an ask whose msgid resolves to a
`time=` from today. It marks any ask naming a row newer than the oldest the
connection had delivered, and ends each connection with how far back the reader
actually got.

`depth.py` runs first, as run 28 established: `#scrollback` holds 2048 events
over eleven pages, ten full and a short one, and the walk's own join and quit
cost the far end two events a run.

## Loaded, the old build stops two pages in

Run 17's two-launch counts were all measured under thirty-two spinners, which is
what this arm restores. Three runs, and the control makes **one ask each**:

```text
run 1   1 ask   reached line 2188, with nine pages behind it
run 2   1 ask   reached line 2192
run 3   1 ask   reached line 2196
```

Not one of them is a walk that ran out of wheel. All fourteen bursts were
delivered, the session stayed up for another four hundred and forty-six seconds
after that single ask, and `#scrollback` had ten more pages the whole time. The pane says
nothing is wrong: no "Beginning of history", no error, nothing loading.

`stopped-short.png` is what the reader is left holding, and the frame carries the
cause above the symptom — `line 2384` at the top of the window, the
`From the server's history` seam under it, and `line 2188` under that. Later
lines above earlier ones, which is #494; the head of the window is therefore the
archive page's first row, which is what `askedBehind` names, which is the `#487`
guard matching on every scroll for the rest of the session.

So run 17's wall is a wall, its candidate was the right one, and the symptom is
the worse one it feared: a reader stopped short of history the server still
holds, told nothing.

## Quiet, it fires one run in three

The same control build on an idle machine: **10 asks, 1, 10**. Runs 1 and 3 walk
the chain to `line 0678` and `line 0540` with "Beginning of history" over it; run
2 stops after one ask at `line 2322`, exactly as the loaded runs do. `61d8b23`
alongside it is 10, 10, 10, reaching `line 0690`, `0694` and `0698`.

So load is a rate rather than a condition. The first quiet walk made ten asks and
nearly wrote "the builds are the same build when nothing contends" into this
file; one walk is not a reading of a race.

`stopped-short-quiet.png` is run 2, and it is the plainest frame this run
produced. At the top of everything the pane holds: **Today**, four `HistServ`
lines of the first launch's own join and quit — then **Wed 12 August**, then the
`From the server's history` seam, then `line 2322`. Today's rows above
yesterday's, which is the archive page filed in front of the window, drawn.
Under it is the guard comparing that row against `askedBehind` and finding them
equal for the rest of the session.

That also corrects what the loaded arm looked like it was saying. The reason
nothing between runs 18 and 28 caught this is not that those walks were quiet —
it is that they were made on a channel that ran out in two asks, where a build
that stops after two and a build that finishes after two draw the same frame and
put the same two lines on the wire. Depth is the instrument; load only makes the
race cheaper to catch.

## The fixed build walks the chain under the same spinners

`61a98fa`, same load, same channel, same fourteen bursts: **ten asks a run,
three runs out of three**, ten distinct msgids each, none repeated, none
unanswered, and `line 0558`, `0562`, `0566` at the top of the pane — the start of
history, four events further on each time because the walk's own join and quit
cost the far end two.

`reach.py` marks no ask on this arm as naming a row newer than the oldest the
pane held. That is #496 not happening: the two changes are a pair, and the ask
going out from the window's true oldest is what keeps the head where the guard
expects it.

One ask against ten, on the same machine, the same second and the same
manoeuvre. `reached-start.png` against `stopped-short.png` is the pair.

## The build that ships, and the run that has to be read rather than counted

`61d8b23` under the same load: ten asks and the start of history in two runs of
three, and **two asks** in the third.

That third run is not the wall, and the difference is in the frame rather than in
the count. `head-r3-midwindow.png` is a pane parked at `line 2108` with rows
running off the top of the viewport and the scrollbar off its top stop: the
reader never arrived at the top, so no page-back was due. The wedged control
frames are the opposite picture — the pane *at* the top of everything it holds,
the seam above the last row it was given, and nothing more coming.

What put it there is the load rather than the app. Thirty-two spinners is enough
to cost a wheel burst its effect: fourteen went out and the harness recorded
fourteen scrolls, and the scroller finished a third of the way down a window it
had reached the top of twice before. A walk that does not reach the top measures
nothing about what happens there, which is why this is reported as a run that did
not complete its manoeuvre rather than as one ask short of a chain.

Run 22 chose thirty-two spinners because the app behaved differently there and
not at sixteen. This is the cost of that choice arriving: at the level where the
race is reachable, the walk itself is no longer reliable, and the frame is what
tells the two apart.

## Run 17's own walk, counted again

`revisit.sh` reads to the top, which takes a minute and fourteen bursts. Run 17's
number came from run 16's walk, which is two bursts and over in seventeen
seconds, so `twobursts.sh` is that walk unchanged on the channel that now has
depth. Eight runs a build, same spinners:

```text
                    runs   asks   asks per run
b75edf2 (before)       8     21   1 1 4 4 1 2 4 4
61a98fa (after)        8     33   4 4 4 5 4 4 4 4
61d8b23 (ships)        8     33   4 4 5 4 4 4 4 4
```

Run 17 measured 1.8 against 5.9 and could say nothing about why. The ratio here
is smaller and the shape is the answer: **the control's arm is bimodal and the
fixed one is not.** Its 4s are runs that walked, four pages back to `line 1636`,
`1640`, `1652`, `1656`; its 1s are runs that stopped one page in, at `line 2224`,
`2228`, `2240`, `2243`. Four runs in eight wedged, and the run counted 2 is one
of them — its first launch made an ask of its own, and its second launch made
the single ask and stopped. The fixed build has no such runs: every one of its
eight reached the fourth page, `line 1660` through `1688`, one of them the fifth.

So a count of asks was never counting how eagerly a build pages. It was counting
how often the race fired, and each firing costs the reader the rest of their
history rather than one page of it.

The build that ships is the fixed build's twin here, run for run, and no ask on
either arm names a row newer than the oldest the pane held — which is #496 not
happening on sixteen loaded runs.

## What this settles

Run 17's count is explained, and it was a defect rather than an appetite. The
build before #494/#496 stops paging on a second visit to a channel under load,
after one page or two, and leaves the reader holding four hundred rows of a
conversation the server still has two thousand of. Nothing on screen says so:
the pane draws no end of history, no error and no spinner, and no scroll the
reader makes will ask again for the rest of that session.

The candidate run 17 named is the mechanism. It could not be confirmed then
because the channel it was measured on ran out in two asks, so a build that
stopped after two and a build that finished after two read identically. Eleven
pages is what tells them apart, and `reach.py` is what says where each one
stopped.

Both later builds are clean on every arm run here: three loaded chains of ten
apiece on `61a98fa`, the same on `61d8b23` bar one run the walk did not carry to
the top, and sixteen loaded two-burst runs between them with no wedge and no
mis-aimed ask.

## What it does not claim

- **Which half of the pair fixes it.** `61a98fa` carries #494 and #496 together
  and that is how run 17 measured it, so that is how this walks it. The
  mechanism argues that neither is sufficient alone — the mis-aimed ask is what
  arms the guard wrongly and the unordered prepend is what keeps it armed — but
  no build with one and not the other was made.
- **Run 17's figures.** Its ratio was 1.8 against 5.9 and this run's is 2.6
  against 4.1. Different channel depth, different machine, ten months of harness
  between them; what reproduces is the shape — a bimodal control against a
  uniform fixed build — rather than the numbers.
- **That a real reader meets this.** The load is thirty-two spinners on sixteen
  cores, which is a machine contending for CPU rather than a slow network. What
  it buys is a reachable race, not a claim about how often a real desktop
  reaches it.
- **Anything about #522's condition on a real server**, which is run 27's open
  item and is untouched here.
- **A quiet arm for `61a98fa`.** The quiet walks are the control and the shipping
  build, which is the pair the rate needed; the fixed build was walked loaded
  only, three runs of ten and eight two-burst runs. Nothing in them suggests it
  behaves differently on an idle machine, and nothing here has watched it do so.
