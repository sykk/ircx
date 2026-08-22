# End-to-end run 48: the seam a search jump was taking

Debug build against Vite, `ergo` 2.19 on 127.0.0.1, Linux/WebKitGTK under
`Xvfb`, one pane at 1200x800. Four sittings of one walk in `docs/end-to-end-48/`
— two on the branch of #624, two on `main` — and `records.txt` is what they
printed. The only difference between the arms is `src/store/index.ts`.

## What was owed

Two things, both of them a frame nobody had taken.

#622 shipped on run 47's evidence and was **never watched in the running
client**: a rule where the window stops, and a pill that reads the tail back
rather than scrolling to a row it already sits on. Tests assert both; no walk
had seen either.

#623 was worse off. It was read off the store rather than found — `replaceHistory`
wrote `{ ...EMPTY_TIMELINE, messages }`, and two of the fields that reset are
not facts about the window being filed — and #624 fixed it with three tests and
no frame at all. Run 47 named the question and left it alone in as many words.

## The arrangement, and the one thing run 47 did not need

Run 47 could search a channel the moment it was full. This walk has to **make a
seam first**, because there is no unread rule in a conversation the reader has
been sitting in.

So: five hundred lines said into the channel while ircx watches, caught up, no
rule anywhere. The reader goes to another conversation, twelve more lines are
said behind their back, and the reader comes back — which is what opens a seam,
`seamAt` taking the first live message that lands while the pane is not the
active one. Then `Ctrl+F`, `0120`, Return, into the middle of the archive; six
more lines said to a window that has stopped; and `Ctrl+Shift+L` back to the
present.

`talker.py` is run 47's, unchanged, three of them this time — one nick per burst
and no two bursts overlapping, because a walk that reads the line numbers as an
order cannot afford ergo filing one connection's queue late.

One step is new and is not a convenience. After the jump the reader is in the
middle of what was filed, and #622's rule is at the far end of it, so the walk
scrolls there: `wheel 647 400 200`, overshot rather than counted, and the
scroller clamps. Run 47 reached the same place by leaving the conversation and
coming back — which no longer lands there once there is unread, for the reason
below.

## What the seven frames read

| frame | painted | |
|---|---|---|
| at the live edge | `0478..0500` | five hundred lines watched, caught up |
| come back to it | `0001..0010` | **#625** — the oldest message held |
| `Jump to latest` | `0493..0512` | `12 messages, 1 person, under a minute` |
| jumped | `0108..0130` | the hit centred, in order |
| scrolled to the window's end | `0197..0219` | where a reader reading on ends up |
| six more lines said | `0205..0518`, one step at `y 559` | **#622 draws** |
| `Jump to latest` | `0501..0518` / `0498..0518` | **the arms differ** |

Every row of that table is identical across both sittings of both arms except
the last, and the last differs only between arms.

## What #622 does, watched

`after-talk.png`. The window ends at `line 0219`, `line 0513` follows it, and
between them the client draws **`Messages in between are not shown`** in the
date rule's grey. The `Jump to latest` pill is in the corner of the same frame.

Run 47's equivalent frame is the same two messages with nothing between them and
no pill, drawn as an ordinary change of speaker. That is the whole of #622,
and this is the first time it has been on screen.

## What the arms disagree about

`latest.png`, after `Ctrl+Shift+L` reads the tail back over the jumped window.

On `main`, `line 0500` runs straight into `line 0501` under a change of speaker.
The rule that was there four frames earlier — the reader's own place, twelve
messages they had not read — is gone, and nothing on screen says it ever
existed. The sidebar still carries the dot.

On the branch of #624 the same frame draws **`18 messages, 2 people, under a
minute`** between them: the seam still names `line 0501`, and the digest has
grown by the six lines that arrived while the reader was in the past. The rule
comes back with the tail, which is what the fix claims.

The message counts corroborate it without anybody reading the text. The same
pane paints 21 messages on `main` and 18 on the branch, twice each: three
messages' worth of height is what the rule takes, and it is not there.

## What the walk found that it was not looking for

**The pane comes back to the conversation at `line 0001`.** All four sittings,
both arms, so it is neither #622 nor #623 — and 512 messages above the rule the
reader came back for. The client's own record from the commit after the return:

```json
{"kind":"scroll","top":24,"sh":14687,"ch":629}
```

Twenty-four pixels into a conversation fourteen thousand pixels tall, with no
`restore` record and no `follow` record anywhere in that window. Nothing placed
the pane; it never moved. That is **#625**, and the mechanism is a one-shot
`useLayoutEffect` that latches before its scroll rather than after it — spending
its single attempt on a pane that has not been laid out, forty lines below a
comment explaining, about the restore, why one attempt cannot be enough.

The only thing that says the rule exists is the `12 unread · Latest` pill in the
corner, which is how this walk got to the seam at all.

## What this run claims, and what it does not

It claims #623 on the running client, twice on each arm, single variable.

- **Half of #624 is not walked.** The fix carries two fields across
  `replaceHistory` and this arrangement only exercises one. The seam here comes
  from a live arrival; `readMarker` needs a server that sets one, which means an
  account and `--sasl`, and it stayed null for the whole of every sitting. The
  half that is unwalked is the half that lasts longer — nothing but the server
  sets that field, so losing it lasts the session.
- **Not the release build.** #599's question again. Neither finding turns on
  layout arithmetic; both are a rule drawn or not drawn from a field the store
  either kept or did not.
- **One shape of return, for #625.** A pane retargeted from another conversation
  by the palette, in one window. A conversation opened for the first time after
  a relaunch takes the same effect and was not watched.
- **Nothing about a hit in another conversation.** Run 47 left it open and so
  does this: every jump here is inside the conversation already on screen, which
  is the case `leftBehind` declines for. A jump that arrives somewhere else
  crosses `showTarget` as well, and that is where the remaining doubt is.
- **Nothing about the search overlay itself.** The sender and age filters, the
  bookmarks mode, the saved searches and the ranking are still untyped-into
  after two runs.

`docs/measurements.md` has no figure at stake.

## What the harness learned

- **A walk about unread has to manufacture the unread**, and that costs a
  conversation to be away in and a talker that waits for a mark. It is worth
  saying because the arrangement is the hard part: the state a defect needs is
  not the state a client sits in.
- **`window.mjs` had 5183 written into it** while `vite.config.ts` reads the
  port out of `tauri.conf.json`, so a session holding the port could not be
  worked around by moving `devUrl` — the harness went on waiting for a line
  naming the old number. It reads the same file now. Another session had the
  port for the whole of this run, which is how it was found.
- **A reader parked mid-window cannot see the end of it**, and the end is where
  the interesting rule is. `wheel` overshot into the clamp is the cheap answer;
  counting notches is not, a notch not being a constant between panes.
- **Run 47's way back to the window's tail is now a different frame**, because
  #625 changes where a return lands as soon as there is unread. A walk that
  reuses an earlier walk's navigation is reusing an assumption about the state
  it leaves the pane in.
