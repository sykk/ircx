# End-to-end run 47: the conversation a search leaves behind

Debug build against Vite, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under
`Xvfb`, one pane at 1200x800. Two sittings of the same walk, frame for frame
identical, in `docs/end-to-end-47/`. `records.txt` is what they printed.

## What was owed

Nothing. Runs 39 to 46 were one thread — the anchor, the pane, and what moves a
reader parked in the middle of a conversation — and #616 closed it. This run
went looking for an area no run had been in, and search is the largest of them:
forty-six runs and not one has typed into `SearchOverlay`, let alone pressed
Return on a hit.

What made it worth the walk rather than a reading is one line. `jump`
(`src/components/palette/SearchOverlay.tsx:99`) does not scroll to the message
it found — it **replaces the conversation** with a window read out of SQLite
around it, and then scrolls. Every question the last eight runs asked about a
reader's position assumed the list under them was the conversation.

## The arrangement, and why it is not run 45's

Search reads the client's own archive, and the archive holds what the client
*received*. Run 40's seeder fills a channel before ircx joins it, so the client
meets those lines as history from the server and, in run 45's walk, never at
all. Here they have to be said **while ircx is sitting in the channel**, which
is what `talker.py` is: the same three-lengths body, waiting on a mark, because
`ss` is still the only command `window.mjs` has that another process can see.

Five hundred lines, then `Ctrl+F`, `0120`, Return. `load_history_around` answers
101 messages before the hit and 99 after it, so a hit 380 messages back leaves a
window that ends well short of the present — which is the arrangement, and the
only parameter this run has.

Then three questions in order: does leaving the conversation and coming back
bring the present with it, what does the channel's next line do, and where does
`Jump to latest` go. The last is sent as `Ctrl+Shift+L` rather than clicked,
because by then there is no pill to click — which is a reading rather than a
convenience.

## What the four frames read

| frame | painted | |
|---|---|---|
| at the live edge | `0478..0500` | the conversation, followed |
| jumped | `0108..0130` | the hit centred, in order, no step |
| away and back | `0197..0219` | the window's own tail, and no pill |
| six more lines said | `0204..0219`, `0501..0506` | one step, 281 messages wide |
| `Jump to latest` | the same frame | it was already on the last row it holds |

**The jump itself is correct** and that is worth saying first: the pane centres
the message the reader asked for, drawn in order, with its neighbours either
side. What is wrong is everything the window is not.

The client's own words, from a `stack` probe in the last frame:

```json
{"i":4,"run":"1-8 20-219","says":208},
{"i":5,"run":"501-506","says":6}
```

Two runs, 218 messages, out of the 506 the archive held while it was drawing
them. `line 0219` at 12:06 with `line 0501` under it at 12:07, drawn as an
ordinary change of speaker — no rule, no marker, nothing. That is **#618**.

**What ends it is a relaunch**, watched on the kept profile: the pane comes back
at `0493..0506`, continuous. The archive was never wrong and the timeline is in
memory, so the strand lasts exactly as long as the process does.

## What the probe found that the walk was not looking for

`run: "1-8 20-219"`. Lines `0009` to `0019` are not in the window the jump
opened, and not in the page the pane read behind it either. Thirteen messages
share `16:06:28.475Z` in that archive, `line 0020` among them, and
`load_history` filters `m.timestamp < ?3` with no tiebreak while ordering by
timestamp *and* rowid. Everything sharing the oldest held message's millisecond
falls between the window and the page, and the next ask names a bound that has
moved past them.

Run by hand against the archive the walk kept, the store's own statement answers
`line 0008`. That is **#619**, and it is not #253 — that one is the server's
`CHATHISTORY AFTER`, fixed with a msgid selector, and never came near the
archive's own paging.

## What this run claims, and what it does not

It claims both defects on the debug build, twice each.

- **Not the release build.** #599 exists to ask whether these differ, and run 46
  is the shape of answering it. Neither finding here turns on layout arithmetic
  — one is a list that is missing its tail, the other is SQL — so the release
  build is a check rather than a question, and it has not been made.
- **One speaker for the whole channel**, after the first walk showed why. Three
  sockets put `line 0120` between `0101` and `0102` in the archive, faithfully
  recorded from an ergo that read one connection's queue late, and a run that
  reads a step in the numbers as a hole cannot afford a seed that invents one.
  What that costs is the grouping: a real channel's blocks are several people's,
  and how a hole reads across a change of speaker is not something this walk saw
  more than once.
- **Nothing about the rest of the overlay.** The sender and age filters, the
  bookmarks mode, the saved searches and the archive's own ranking were not
  typed into. A query matching more than one message was not tried, and neither
  was a hit in a conversation other than the one on screen — which takes the
  same `jump` through `showTarget` and is the likelier way a reader meets it.
- **Nothing about the unread seam.** Whether the badge and the rule survive a
  window being replaced under them is a question this run left alone.

`docs/measurements.md` has no figure at stake: nothing here is a startup, memory
or size claim.

## What the harness learned

- **The archive is the second instrument, and `--keep` is what makes it one.**
  Every earlier run read the pane against itself — a screenshot, or a probe
  record of what the pane thought. Both findings here are a *difference*: what
  the pane drew against what SQLite held, and neither is visible from one side
  alone. A walk whose subject is history should keep its profile by default.
- **A seed of three sockets is a seed with an order it did not choose.** Run
  40's own docstring says so, and run 40 does not mind because it reads page
  boundaries. This one had to be told twice — once by a frame that looked like
  #602 and once by the archive that explained it.
- **A missing control is a reading.** `Jump to latest` was sent by hotkey
  because the pill was not drawn, and the pill not being drawn is the client
  saying it is caught up. The frame that carries the finding is the one where
  the harness had to work around the UI.
