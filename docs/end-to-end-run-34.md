# End-to-end run 34: the person who is not there

2026-08-20, a release build against a local `ergo` 2.19, on the walk in
`docs/end-to-end-34/`.

## The question

Ignoring somebody shipped in #563 and nothing had ever watched it work. Every
claim it makes is a claim about absence — no row, no unread, no notification,
no archive record, no CTCP reply — and absence is the one thing a unit test
proves least convincingly: the assertion passes whether the line was silenced
or never sent. A live run can put the line on the wire, photograph the window
either side of it, and read the archive afterwards.

The rest of the question is what an ignore is *not* allowed to take away:
kicks, modes, topics and the member list, which the design keeps on purpose.

## The instrument

`walk.py` holds the window and every socket in one process, driven from a FIFO.
Run 33 kept its second session in a program of its own; an ignore needs the
ordering stated rather than hoped for, because the evidence is a photograph
taken after a line that should have changed nothing. `proxy.py` and `irc.py` are
run 33's, unchanged, and `session.py` is run 33's too — the clients that had to
outlive a restart of the app were run from there rather than from `walk.py`,
which owns the window's lifetime.

**Two frames with nothing between them is the assertion.** A silenced line is a
window that did not move, so `md5sum` on the pair is the whole test, and where
it is quoted below the two frames were byte-identical.

**The witness is the control.** `witness34` says the same kind of thing at every
step and is never ignored, so each absence is measured against a presence one
line later. Without it a broken socket and a working ignore photograph the same.

## What an ignore does, watched from both ends

**It takes effect at the door, on the next line.** `/ignore talker34` typed in
the channel, and the line after it is gone while the witness's is drawn:

```text
talker34 >> PRIVMSG #ignore34 :first line after the ignore, nobody should see this
witness34 >> PRIVMSG #ignore34 :witness after the ignore
```

The confirmation lands in the conversation it was typed in — *Ignoring talker34.
Nothing they say from now on is kept.* — and nothing else moves. `door.png`.

**A mention from an ignored person raises nothing at all.** With the channel
unfocused, `walker34: this mentions you and must not raise anything` left the
window byte-identical, and the witness's mention one second later moved it and
put a badge of 1 on the channel. The seam counts the same way: *1 message, 1
person, under a minute · 1 of them mentions you*.

**A private line opens no query and a CTCP draws no answer.** Three lines from
an ignored person — a `PRIVMSG` to the reader, `\x01VERSION\x01`, `\x01PING\x01`
— left no row, no query in the sidebar and, on the wire, no reply:

```text
11:26:53 << talker34 PRIVMSG walker34 :\x01VERSION\x01      (before the ignore)
11:26:53 >> PRIVMSG talker34 :\x01VERSION ircx 0.1.0+910339c…\x01
11:28:07 << talker34 PRIVMSG walker34 :\x01VERSION\x01      (after it)
                                                            (nothing)
```

`ctcp-wire.txt`. The same question asked twice, thirteen minutes apart, is the
cleanest form this evidence takes.

**Coming and going is silenced and the roster is not.** An ignored person's part
and rejoin drew no row and no digest, and the member list lost them and got them
back — the frame before their part and the frame after their rejoin are
identical. The witness's identical cycle drew *1 left, 1 joined*. `presence.png`.

**A `/me` and a `NOTICE` are speech and go with it**, and the witness's of each
are drawn beside the absence. `action-and-notice.png`.

**The typing indicator goes too.** `tagger34 is typing…` sat above the composer
on a `@+typing=active TAGMSG`; ignored, the same line drew nothing.
`typing-before.png`, `typing-after.png`.

**What it deliberately leaves.** An ignored person took ops, set the topic and
kicked the witness, and all three are drawn — the topic bar, the topic row and
*talker34 kicked witness34 from #ignore34 — kicked by somebody the reader
ignores*. These change the channel rather than say something.
`kick-and-topic.png`.

**A rename does not escape it.** `talker34` became `talker34b`: no rename row,
the roster and the query took the new name, the next line was still gone, and a
bare `/ignore` in the server tab answered *Ignored on this network: talker34b*.
The store had followed too — `SELECT * FROM ignored` reads `walk|talker34b`.
`rename.png`.

**Case is folded the way the network folds it.** `/ignore TALKER34B` silenced
`talker34b` on a server advertising `CASEMAPPING=ascii`, and `/ignore walker34`
was refused with *You cannot ignore yourself.*

**The inspector says so.** Opening the ignored member from the roster:
*You are ignoring talker34b. Nothing they say is kept.*, with **Stop ignoring**
beside it. `inspector.png`.

## The hole in the archive, read out of SQLite

**Nothing was arranged and nothing was written.** The whole `messages` table
after the walk, everything from the ignored person in it:

```text
talker34|"join"    |#ignore34|talker34 joined #ignore34            (before)
talker34|"privmsg" |#ignore34|control line one, before any ignore  (before)
talker34|"server"  |talker34 |talker34 asked for CTCP VERSION      (before)
talker34|"mode"    |#ignore34|took ops
talker34|"topic"   |#ignore34|talker34 set the topic of #ignore34 to …
talker34|"kick"    |#ignore34|talker34 kicked witness34 from #ignore34 — …
```

Five lines of speech, a part, a rejoin, a rename, a private message and two
CTCP requests happened in between and none of them is there. The witness's
every row is.

## Across a restart, and across a gap

**The ignore survives and the gap fill obeys it.** With ircx shut down, the
ignored person said two lines in the channel and the witness said two. On the
next launch ircx asked `CHATHISTORY AFTER #ignore34` and drew the witness's two
— one of them tinted as a mention — and neither of the other's. `gap-fill.png`.
The settings dialog listed *talker34b on walk* with **Stop ignoring** beside it,
under the mutes. `settings.png`.

**A first attempt at this measured nothing, and the reason is worth keeping.**
The clients were closed before the app came back, which emptied `#ignore34`;
ergo drops an unregistered channel's history with its last member, so the gap
fill returned one line and both people's messages were equally absent. A walk
that shuts everything down is a walk where nothing can be told apart. Run 33
wrote down the same shape for an account that is not always-on.

**Un-ignoring restores nothing, and says so.** *No longer ignoring talker34b.
What they said meanwhile was not kept.* Their next line drew; the silenced ones
never came back, in the window or in the archive. `unignored.png`.

## What the walk found

**A CTCP reply is answered as if it were a request** — #572. CTCP keeps two
clients from trading the same line forever with one rule: a request is a
`PRIVMSG`, a reply is a `NOTICE`, and a `NOTICE` is never answered. ircx breaks
both halves — `handle_incoming_ctcp` replies on whatever command the request
arrived on, and nothing above it asks what that command was.

```text
>> PRIVMSG walker34 :\x01PING probe1\x01     (a request)
<< PRIVMSG witness34 :\x01PING probe1\x01    (ircx's reply — the same line)
>> PRIVMSG walker34 :\x01PING probe1\x01     (fed back, as a peer would)
<< PRIVMSG witness34 :\x01PING probe1\x01    (answered again)

>> NOTICE walker34 :\x01PING probe2\x01      (this is what a reply looks like)
<< NOTICE witness34 :\x01PING probe2\x01     (answered anyway)
```

`ctcploop.py` is a peer that follows ircx's own rule. It ran to 8 exchanges and
then to 40, stopped by a counter in the probe and by nothing at either end;
`ctcp-loop.png` is what that leaves in a query, and every row of it is
archived. It found this run because an ignore is the only thing that stops it:
`/ignore` typed mid-flight cut the second run dead at 16.

**The ignore itself is sound.** Thirteen claims, each watched happen, and
nothing in it needed changing.

## What this does not claim

- **Anything about a server that is not ergo.** One `ergo` 2.19 on loopback,
  `CASEMAPPING=ascii`. A network folding `rfc1459` would fold `talker[34]` and
  `talker{34}` together and nothing here tested that.
- **That an ignore hides what somebody else says about them.** ergo's HistServ
  narrates a channel's history as its own `PRIVMSG`s, so *talker34b joined the
  channel* is drawn from `HistServ` while the ignored person's own `JOIN` is
  not. Nothing keyed on a nick can catch a third party's prose, and a bot
  relaying a bridge is the same shape.
- **A rate or a timing for anything.** Every step was driven and waited for.
  The CTCP loop's pace is the client's own 500ms line pacing and was not
  measured.
- **That an ignore made while a network is disconnected can be undone from the
  settings dialog.** The list was read on a connected network; the disconnected
  case is still only argued for.
- **Desktop notifications.** Nothing was watching the notification bus, so
  "no notification" rests on the unread count and on `count_towards_unread`
  never being reached.
