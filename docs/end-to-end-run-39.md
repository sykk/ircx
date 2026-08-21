# End-to-end run 39: a pane at the live edge, beside one in the archive

Release build, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under `Xvfb`.
Scripts in `docs/end-to-end-39/`; `run.sh` is the whole of it.

## The question

`docs/manual-verification.md` has carried the same sentence since run 12:

> **Two panes on one conversation**, one at the live edge and one scrolled back.
> The anchor shares a component with #307's restore and no walk has opened both.

Every split measured since is the other arrangement. Runs 22, 23 and 31 park the
right pane a few hundred notches up the archive and page the left one back, which
is the shape #508 was reported in and the reason those runs exist — but it is two
panes both reading history, and the pane that is *not* reading history is the one
a reader spends their day in. What a prepend does to a pane at the tail, what an
append does to the pane beside it that is not, and what the reader can do from
either has never been photographed.

This run is that arrangement, and the pane at the tail is arranged by leaving it
alone: a restored pane opens at the live edge, so the walk skips a command rather
than needing one.

## The arms

Ten, and two of them are controls — which is the point of them: the first reading
this run took looked like a finding and the controls are what took it away.
`one.sh` is run 31's `parked.sh` with the
parking moved to the other pane; `run.sh` alternates the arms run by run, which
is run 25's arrangement against a machine that gets busy halfway through a set.

| arm | what lands | what it is for |
|---|---|---|
| `live` | a second client's line, left pane parked | the append, across a split |
| `pageback` | a page-back, nothing said | the prepend, against a pane at the tail |
| `both` | a page-back, after lines arrived while it was held | the two interleaved |
| `split` | the split itself, made from the archive | #307's half of the question |
| `send` | the reader's own line, typed into the parked pane | what the reader can do |
| `jump` | the pill, after three lines arrived | where it lands when the tail moved |
| `atlive` | the same line, with neither pane parked | control: is it the parking? |
| `single` | the same line, with no split at all | control: is it the split? |
| `sendone` | the reader's own line, no split | the same, with no second pane to see it in |
| `sendfail` | a line into a channel that refuses it | what the reader is told when it fails |

`latepage.py` is under `pageback` and `both` and nothing else. A page-back off a
local ergo is answered inside the wheel burst that asked for it, so there is no
pair of frames to straddle it with; held forty seconds — past the longest burst
run 31 measured, twenty short of `ROUND_TRIP_TIMEOUT` — the client is still
waiting when its page lands, which is the ordinary case rather than run 30's. A
line said by a second client needs no proxy at all: `say` returns on the echo.

## What held

Four walks an arm — a probe and three of a set — on the release binary, against
one `ergo` per channel. Distances are `paneshift.py`'s over each pane's message
column; `rows`/`pane` are that column and the whole pane compared pixel for
pixel, which is how a landing that moves nobody still shows itself.

| arm | the pane in the archive | the pane at the tail |
|---|---|---|
| `live` | `+0px`, rows still | `-94px`, rows differ — it followed |
| `pageback` | `+0px`, rows differ at the landing | `+0px`, rows still |
| `both` | `+0px`, rows differ at the landing | `+0px`, rows still |
| `send` | `+0px`, rows still, **pane still** | `-94px` — the other pane drew it |
| `jump` | no strip found — it went to the tail | `-190px`, the three lines |
| `atlive` (control) | — | `-94px` in both panes |
| `single` (control) | — | one pane, it followed |
| `sendone` | `+0px`, 14 of 14, pane still | — |
| `sendfail` | `+0px`, 14 of 14, pane still | — |

**The arrangement holds.** A page-back landing in the pane reading history moves
neither it nor the pane at the live edge, in either arm, in all four walks each:
the anchor holds the asking pane at `+0px` while its rows change underneath it —
run 23's seed regroups where a page abuts what is drawn — and the pane at the
tail stays where it is, its own reading `rows still` with only `pane differs` at
the landing, which is the scrollbar thumb shortening for two hundred messages
that arrived above. A line arriving live moves the parked pane by nothing and
takes the pane at the tail down by exactly the row it drew.

`both` is the interleaving and it is no different: three lines arrive while the
page is held, the pane at the tail follows each of them, and the page then lands
against a pane that has been sitting at the top of its content with *Loading
older messages* over it for forty seconds (`held-and-live.png`). Nothing about
the append got in the way of the prepend.

**The split made from the archive keeps the reader's place, and gives the new
pane the live edge** (`split-from-the-archive.png`). That is #307's half of the
question, in the order that had never been walked: the three arms above split
before anybody had scrolled anywhere, and this one reads first and splits after.
The original pane comes back on the line it was reading — `line 0363` in the walk
pictured, at the top of both frames — and the pane that appears beside it opens at
the tail rather than inheriting where its sibling was.

**The pill lands on the tail that moved.** Three lines arrive while the pane is
parked; the pill was drawn before any of them; clicking it lands on the newest,
with the two panes then showing the same last row (`jumped-to-the-tail.png`).

## What the run found

**A line the reader sends from a pane scrolled back leaves the pane where it
is** — #590 — and with one pane there is nothing anywhere in the window that
says it was sent at all.

The walk is `sendone`: one pane, parked a few hundred notches up a 400-message
channel, a click into the composer, a line typed, `Return`. The second client
heard it —

```text
:walker!~u@rdze739dpbgxn.irc PRIVMSG #live39 :a line typed into the pane that is in the archive
```

— and the window did not move: 14 strips of 14 agree on `+0px`, the message
column is pixel for pixel what it was, and so is the whole pane. Comparing the
frame before the reader typed with the frame after they sent, **the only pixels
that differ in the entire window are the composer's focus ring**
(`nothing-but-the-focus-ring.png`, the difference of the two frames). The line
is drawn, correctly, below the fold — in the split arm the other pane shows it
arriving — and the pane the reader typed into never goes there.

There is no rule for it to have broken. `jumpLatest` in `Timeline.tsx` is
reached from the pill, from the seam's *Latest* and from the `timeline.latest`
hotkey, and from nowhere else; the effect that follows the tail is guarded on
`followingRef.current`, which a scrolled-back pane has already set false. Nothing
in `Composer` touches the anchor. `git log -S jumpLatest` turns up one commit,
which added unread navigation — so this is a case nobody handled rather than a
decision somebody took, and no test asserts the present behaviour either.

**What makes it worth more than the reader's own line being out of sight is what
else is drawn there.** A message that fails carries its failure on its own row —
`MessageRow.tsx` draws `delivery.state === "failed"` and the retry for the run it
failed with — and a server that refuses one answers with a numeric that
`numeric.rs` turns into a system row at the tail:

```text
`#refuse39` would not take your message — …
```

Both land at the bottom of a timeline the reader is not looking at. The
`sendfail` arm walks exactly that: `refuse.py` gives `warden` the empty channel,
lets run 23's seeder fill it, and moderates it afterwards, so the archive is
there to park in and the next line typed into it comes back `404`.

It does, and the window says nothing at all (`refused-and-said-nothing.png`):
`+0px` on 14 strips of 14, rows still, pane still, and the second client heard
nothing because the server took nothing. Sending the pane to the tail afterwards
finds what was there the whole time (`refused-at-the-tail.png`).

## Two more, from the same frame

Neither is about panes. Both are on `refused-wire.txt`, which is the whole of the
exchange:

```text
>> @+typing=active TAGMSG #refuse39
<< :ergo.test 404 walker #refuse39 :Cannot send to channel (+m)
>> @+typing=done TAGMSG #refuse39
<< :ergo.test 404 walker #refuse39 :Cannot send to channel (+m)
>> @label=ircx-1 PRIVMSG #refuse39 :a line typed into the pane that is in the archive
<< @label=ircx-1 :ergo.test 404 walker #refuse39 :Cannot send to channel (+m)
```

**A typing notification the channel refuses is reported as the reader's message
being refused** — #591. Two rows of

```text
`#refuse39` would not take your message — Cannot send to channel (+m)
```

are drawn before the reader has sent one: they are the answers to
`+typing=active` and `+typing=done`, which the composer sends as the reader
types. `on_other_numeric` in `session.rs` describes a `404` without
knowing what was refused, and `numeric.rs` words it as a message either way.

**A message the server refuses stays drawn as one that was sent** — #592. The `PRIVMSG`
went out labelled and came back refused *on that label* — `labeled-response`
answering the exact question it exists to answer — and nothing matches the two.
The optimistic copy went to `Sent` when it was written to the socket and stays
there: peak text brightness on the refused row is `0.852446`, the same figure as
a delivered line and an ordinary archive line in the same theme, where a row
still `Pending` would be drawn at `--pending-opacity`, 0.55 in `ircx-dark`. The
`Failed` state exists, `MessageRow` draws it with the retry for the run it failed
with, and `abandon_unwritten` is the only thing that ever sets it.

## The sidebar's unread mark, which is not this run's to settle

The first frames of the `live` arm looked like a finding and are not one. A line
arrives, a pane on that conversation draws it as it lands, and the sidebar puts
an unread mark on the row for the conversation the reader is looking at.

It survived the split as an explanation for about ten minutes, which is what the
controls are for. `atlive` takes the same reading with neither pane parked and
gets the same mark; `single` takes it with no split at all and gets the same mark
again. So it is not the arrangement, and the mechanism is in
`followFocus` (`src/lib/bridge.ts`), which is the only caller of `mark_read`:

```ts
const at = targetKey(view.network, view.target);
if (at === last) return;
```

Read once, on arrival at a conversation. Everything said while the reader stays
there is counted by `count_towards_unread` in `crates/ircx-core/src/message.rs`
and nothing clears it until they leave and come back.

`docs/manual-verification.md` already names this, in the words of somebody who
knew it was a judgement rather than a bug:

> A conversation left focused while messages arrive is marked read once, on
> arrival at it. Whether a badge should reappear underneath a pane the user is
> looking at but not reading is not settled.

What this run adds is that it is not hypothetical and not rare: it is every line
said while you watch, on a release build against a real socket, in every arm that
said anything (`unread-while-watching.png`, the sidebar row before the line and
after it). `UnreadMark` carries the count in its accessible name, so what a
screen reader is told grows with it. Settling it is a product decision and this
run does not make one.

## What this does not claim

- **Anything about two conversations in a split.** Both panes here are on one
  channel, which is the arrangement the gap named. The other half of what
  `docs/manual-verification.md` records as unsettled — a channel in the other
  pane keeping its count until that pane is focused — needs two conversations
  and is not walked.
- **A rate.** The `+0px` readings are four walks apiece and three for `sendfail`,
  not a hundred: they say
  the arrangement holds, not how often it fails to. Runs 24 and 25 are what a
  claim about a rate looks like in this project.
- **The head's whole cycle**, which is still what `#475` left open. This run
  photographs a landing either side; whether the head's arrival and its departure
  cancel is measured by neither frame.
- **A window with a manager on it.** `Xvfb` with none is what these walks run
  against, and the focus rules that need one are run 21's business.

## What the harness learned

**Do not edit a script while a set is running it.** `one.sh` was edited twice
during the first run of this set, and bash reads a script by byte offset rather
than loading it whole: both edits landed inside an invocation, which resumed
mid-token and printed `syntax error. Last token seen: /`. The arm looked like a
walk that ran and could not be read — the first launch had already kept its
profile, so the directory held `first.log`, `hold.log` and `wire.log` and no
frames at all. Two arms were lost that way and re-run on their own afterwards.

**One pane is one column, and `reading.py` still reads two.** `paneshift.py`'s
columns are a split's; against a single pane the second of them lands in the same
timeline a few hundred pixels to the right, where this seed's repeated lines give
its strips somewhere else to match. It answered `+0px` on the left column and
*the strips do not agree on a distance* on the right, on frames that are pixel
for pixel identical. The left column is the reading for a single-pane arm; the
right is noise, and is left in rather than special-cased because a script that
quietly reads one thing in one arm and another thing in another is worse.
