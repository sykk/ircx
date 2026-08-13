# End-to-end run 22

Run 21 left one recommendation standing after #507 took the other: **a release
walk of something already covered.** Runs 18 to 21 are release builds and every
walk before them is the debug build against Vite, which means `StrictMode`,
which means each effect mounts twice. The WebKitGTK accessibility run named the
path where that would show — the restore, which is the code path that behaves
differently under a double mount — and said plainly that what it left unwalked
was the easier one.

So this run takes runs 12 to 19's own cycle, changes nothing about it except the
build, and adds the one condition none of them had: **the pane comes back from a
stored layout rather than being opened.** What is counted is what reaches the
socket.

## What it walks

An ergo of this run's own on 6712, from run 21's `ergo.sh` — the port checked
against the pid in the socket's own line, not merely answered. `#restore` holds
800 numbered lines from `seed.py`, run 12's seeder with its three constants moved
onto the command line, and its two clients stay resident because ergo destroys an
unregistered channel the moment it empties.

Each run is two launches through `window.mjs` with one `tap.py` in front of both,
so a session number tells them apart:

1. Join `#restore`, take the join's page, write the archive, **split the pane**
   with `Mod+\`, keep the profile.
2. Open on that profile as it stands. Wait. Then eight wheel bursts to the top,
   which is what asks for the page behind.

Six runs a build, and the two arms taken one after the other rather than
together — run 17's rule, and it holds on an idle machine.

## The instrument every paging run used is blind to the launch this one is about

`asks.py` counted `CHATHISTORY LATEST` and `CHATHISTORY BEFORE`, which is what
runs 16 to 19 counted, and reported that a restored launch asks the server for
no history at all. It asks for two things neither verb covers:

```text
> CHATHISTORY TARGETS timestamp=2026-08-13T11:11:36.759Z timestamp=...  50
> CHATHISTORY AFTER #restore timestamp=2026-08-13T11:11:36.759Z 200
```

What changed while the app was down, then the gap closed per conversation.
Neither appears in a first launch at all.

**They were already on disk.** `docs/end-to-end-19/before-run1-wire.log` is
committed to this repository and carries one of each; run 19's own tap recorded
them and its instrument stepped over them. Run 19 reported ten asks in its second
session and there were twelve on the wire. Nothing it concluded was wrong — it
was counting page-backs and it counted them correctly — but four runs of the
paging arc had a catch-up path in their evidence and no eyes on it.

## The restore, in the build that ships

The split comes back. `release-split.png` is the tree at the end of the first
launch, two panes on `#restore` with a roster each; `release-restored.png` is the
second launch on that profile, and it is the same tree.

## The paging cycle, in the build that ships

Six runs, and the same six lines (`release-asks.txt`):

| | session 1 | session 2 |
|---|---|---|
| asks | `LATEST` | `TARGETS`, `AFTER`, then 4 × `BEFORE` |

No ask repeated in any run, which is #487's duplicate absent from 24 page-backs.

`heads.py` reads where the reader's own head was each time, because
`CHATHISTORY BEFORE #restore msgid=X` names the oldest message the pane holds and
the seeded lines are numbered. Every run walks back a full page a time, to the
start (`release-heads.txt`):

```text
run1 session 2: line 0606 -> line 0406 -> line 0206 -> line 0006
run2 session 2: line 0610 -> line 0410 -> line 0210 -> line 0010
run3 session 2: line 0614 -> line 0414 -> line 0214 -> line 0014
run4 session 2: line 0618 -> line 0418 -> line 0218 -> line 0018
run5 session 2: line 0622 -> line 0422 -> line 0222 -> line 0022
run6 session 2: line 0626 -> line 0426 -> line 0226 -> line 0026
```

200 lines a step, four steps, no short one — run 19's `steps.py` test for a
wasted ask, passed on the restore rather than on a channel open. Where each run
starts drifts four lines from the last, which the control section spends.

## The control, which is the whole point of the run

The variable is the mount regime, and `StrictMode` only double-invokes in
React's development mode — a production bundle strips it. So the control cannot
be a release binary with a flag turned over; it has to be the debug build
against Vite, which is what runs 1 to 17 drove.

That build wants port 5183, and 5183 was held throughout by the main checkout's
dev server, which belongs to another session. Waiting was not the only option:
`tauri.conf.json` is the only place the number appears — `vite.config.ts` reads
`devUrl` and takes the port out of it — so the control ran on 5184. Same source,
same `StrictMode`, same dev server, one different number, reverted afterwards.

Six runs, and the arms did not overlap:

| | first launch | restore | page-backs | repeated |
|---|---|---|---|---|
| release, single mount | 1 × `LATEST` | `TARGETS`, `AFTER` | 4 × `BEFORE` | none in 24 |
| debug, double mount | 1 × `LATEST` | `TARGETS`, `AFTER` | 4 × `BEFORE` | none in 24 |

And the head walks the same distance on both (`debug-heads.txt`), 200 lines a
step and four steps to the start.

**The answer to run 21's question is that there is no difference.** The double
mount reaches the socket nowhere: the priming loop's second entry meets
`loadingOlder`, which is store state rather than anything a mount owns, and
returns `"skipped"` before `ipc.loadHistory` is called. What that buys is
retrospective — runs 12 to 17 counted asks on a build nobody ships, and their
counts are the shipped build's counts.

It is worth saying what this does not license. The two arms agree on **what is
asked for**, which is what those runs measured. It says nothing about the timing
they also reported, and a debug build against Vite is slower in ways this walk
made no attempt to hold still.

The drift is the check that the two arms are the same experiment. Each run joins
and quits twice, so four join and quit events enter the channel's history per
run, and a 200-message page carries four fewer seeded lines than the run before
it. The release arm starts at `line 0606` and ends at `0626`; the debug arm's
own smoke run took `0630`, and its six pick up at `0634` and end at `0654`. +4 a
run, across the boundary between the arms, without a step out of place.

## The pane nobody touched

`release-scrolled.png` is the frame after the bursts. The left pane is at
`line 0001` under "Beginning of history". The right pane has not moved: it holds
the join digest and the channel's own system rows, exactly where
`release-restored.png` left it, while 800 messages were prepended to the
conversation both panes share.

That state is unwalked. Every run in the paging arc drove one pane, so a second
view over one store entry — receiving a page it did not ask for, from a reader
who is not in it — has never been photographed before.

**What it does not show is the anchor.** The right pane is at the live edge, and
a pane at the live edge staying there is the follow path rather than the
arithmetic #478 and #485 built: there is nothing above the viewport for a
prepended page to push.

## The pane nobody touched, parked

`parked.sh` is that walk with the second pane scrolled 300 notches up the archive
first, so there is history above it and a row to measure it by. Then the left
pane pages, twice.

The parked pane asked for nothing. Its 300 notches sit inside the 200 messages
the restore read from the archive, and the first `CHATHISTORY BEFORE` of the
session carries `@label=ircx-1` at t=45.2s — after the left pane's first burst,
and after the parked frame was taken. Every page in this walk was asked for by
the other pane.

`paneshift.py` is `shift.py` with one pane's columns rather than the window's, so
a shift is that pane's own and not the two of them averaged. Nine runs, two pages
each, eighteen landings (`parked-shifts.txt`):

| the parked pane moved | landings |
|---|---|
| 0px | 13 |
| −24px | 3 |
| +24px | 2 |

Residual 0.00 on every one of the eighteen, which is the band matching exactly:
where it moved, it translated rather than redrew.

**So a page lands in a pane whose reader did not ask for it, and about one time
in four that reader moves by exactly one line of text.** It goes both ways, which
rules out anything inserted once above them — a separator arriving at the archive
boundary would only ever push down. `scrollAnchor.ts` restores an absolute
position for this exact reason, `scrollTop = start - delta`, so that growth above
the viewport costs nothing, and it is 0px in thirteen of eighteen.

The mechanism is not established here and this run does not guess at one. What is
established is the state: two panes over one `timelines[key]`, one reader
scrolling and one not, and the one not scrolling settling a line away from where
they were left. Every run in the paging arc drove a single pane, so nothing has
been in a position to see it.

Filed as #508.

## Three harness findings

**A port is not the only way to a dev server.** 5183 was held by the main
checkout's Vite for the whole run, and `window.mjs` needs it for a debug walk.
Waiting on another session was not required: `tauri.conf.json` is the only place
the number is written, `vite.config.ts` reads `devUrl` and takes the port out of
it, and `window.mjs` waits on the served URL. Three lines, one of them a regex,
and a debug arm runs beside somebody else's dev server. Run 19 and run 21 both
found that a name and a port are not identities; this is the same fact from the
other side, where the answer is to stop sharing the number rather than to wait
for it.

**`grep '> CHATHISTORY'` finds none of the page-backs.** ircx labels its history
requests, so the line on the wire is `> @label=ircx-1 CHATHISTORY BEFORE …` and
a pattern anchored on the arrow and the verb together matches only the two the
Rust side sends unlabelled. `asks.py` searches the body wherever the verb sits,
which is why its counts and a hand grep disagreed for ten minutes.

**A `wait` in a walk script is not the walk's clock.** `wheel 400 400 -1600`
sends 1600 events one at a time and takes around fifteen seconds, so the frames
in this walk sit tens of seconds from where adding up the waits puts them. Lining
the frames up against the wire by arithmetic gave an ordering that could not have
produced the screenshots; the labels on the asks are what settled it.

## What this does not say

**Nothing about timing.** The two arms agree on what is asked for, which is what
runs 12 to 17 measured and the reason the control was run at all. A debug build
against Vite is slower in ways this walk made no attempt to hold still, and any
figure from those runs is still a debug figure.

**Nothing about #496.** Run 20 asked for nothing further on it and this run
walked nothing towards it. The narrow path it left open — a pane restored before
its join completes — is still open and still judged not worth a walk.

**Nothing about a mechanism for #508.** Eighteen landings and a distribution is
the whole of what is claimed.

## For the next run

#508 is the thing this run leaves, and it should not be walked next. It has a
state rather than a timing — two `Timeline` mounts over one `timelines[key]` —
and runs 18 and 20 both ended by saying that where a defect has a state, the test
is the instrument and the walk is the confirmation. Five runs went into #496
before that lesson took; the cost of ignoring it is on the record twice.

What a walk would still be worth doing on: the split layout is now known to
survive a restart with both panes, and nothing has driven the divider, a pane
holding a different conversation from its neighbour, or a restore of a tree
deeper than one split.
