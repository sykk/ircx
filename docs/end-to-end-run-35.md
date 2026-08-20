# End-to-end run 35: the answer that is not a message

Walked 2026-08-20 against `ergo` 2.19 on loopback, release build, `Xvfb :90`.
The instrument is `docs/end-to-end-35/`.

## The question

A reaction and a reply are the two things this client draws that are not
messages: one is a chip under somebody's line, the other is a quote above your
own. Both are scripted — `session.rs` feeds the tags and asserts the events,
`Timeline.test.tsx` draws the chips — and neither had ever been watched against
a server. What a script cannot answer is whether the tag ircx writes is the tag
a server relays, whether the chip under a message is still there tomorrow, and
what a reader has to do to put one there.

## The instrument

Run 34's shape: `walk.py` holds the window and every socket in one process,
driven from a FIFO, so the ordering of a line and the photograph after it is
stated rather than hoped for. `irc.py` and `proxy.py` are run 34's unchanged —
the proxy sits between ircx and ergo on `127.0.0.1:6690`, because the app's own
raw log records what it queued rather than what it wrote.

What this run added is `sayid`: a reaction names the message it answers by
`msgid`, so the instrument has to know an id the server minted a moment ago. It
says a line, waits for that client's own echo, and keeps the id under a name the
later commands spell. `witness35` and `talker35` both register with
`echo-message`, which is the only way a client learns the id of what it just
said.

## What goes on the wire

Every outbound shape, read off the proxy rather than off ircx
(`reactions-wire.txt`):

```text
>> @+reply=b35cb6ghs8eas8685czae94bwe;+draft/react=🔥 TAGMSG #react35
>> @+reply=b35cb6ghs8eas8685czae94bwe;+draft/unreact=🔥 TAGMSG #react35
>> @+reply=b35cb6ghs8eas8685czae94bwe;+draft/react=hear\shear TAGMSG #react35
>> @label=ircx-9;+reply=b35cb6ghs8eas8685czae94bwe PRIVMSG #react35 :answering …
```

**The mixed spelling is the specification's, not a slip.** `+reply` is ratified
and `+draft/react` is not: the react spec says implementations SHOULD use
`+draft/react` and `+draft/unreact` "to be interoperable with other software
implementing a compatible work-in-progress version", and that the tag MUST be
used with the `+reply` client tag. Both halves of what ircx sends are what that
sentence asks for. Reading is wider than writing — `message.rs` takes either
spelling of either tag — and both were fed to it and drawn.

A reaction whose value has a space in it is escaped on the way out and arrives
whole: `hear\shear` on the wire, `hear hear 1` in the chip
(`typed-reaction.png`). The `+draft/react` tag puts no restriction on its value
and `hear hear` is a reaction.

## What draws

**Chips carry the count and the names.** Two people on 👍 and one on 🎉 is two
chips reading `2` and `1` (`two-chips.png`); the chip's label names who is on it,
and your own is written as `you` — `talker35, you` on the one this run joined.
Your own chip is outlined in the accent, so which of them is yours is legible
without reading a tooltip (`my-reaction.png`).

**Four malformed shapes were fed and none of them drew anything.** Each was
measured as two frames with nothing between them, byte-identical under `md5sum`:

- `+draft/react` with no `+reply` — a reaction naming nothing.
- `+draft/react` and `+draft/unreact` on one line, which the spec forbids.
- `+draft/react` naming a `msgid` this client has never held.
- a reaction from somebody `/ignore`d.

The first three are `message.rs` and `handle_tagmsg` declining to act on a line
that says nothing actionable. The fourth is the ignore, and it is watched
against a control: `witness35` sent the same emoji one second later and the chip
appeared (`ignored-reaction.png`), so the absence is the ignore rather than a
dead socket.

**Replies quote what they answer, and say so when they cannot.** Three shapes
went in and all three drew (`replies-drawn.png`): a reply to ircx's own message
quoting `walker35 — answering the message everyone will answer`, a reply
carrying the draft spelling `+draft/reply`, and a reply naming a message this
client has never seen, which draws *in reply to an earlier message* rather than
an empty quote or nothing at all.

**A reaction in a query lands in the query.** `handle_tagmsg` takes the target
from the sender's nick when the parameter is not a channel, and a reaction sent
to `walker35` while the query was closed was on the message when it was opened
(`query-reaction.png`).

**A reaction is not a message and moves no counter.** With the query unfocused,
a reaction into it left the window byte-identical: no badge, no unread, no seam.
That falls out of the same design that makes an ignored line silent — nothing
about a reaction reaches `count_towards_unread`.

## The defect: arming a reply leaves the caret behind

**#575.** The control that arms a reply is a button in the timeline. Clicking it
draws the banner over the composer — *Replying to witness35 …* — and leaves the
focus on the button (`reply-armed.png`). What the reader types next goes to a
button and is lost; Enter re-arms the same reply. The walk typed a whole
sentence into it and photographed an empty composer.

Nothing in `Composer.tsx` called `focus()` at all. The fix is an effect on the
armed msgid, and it only takes the caret for a reply armed while the composer is
mounted: one restored with a conversation the reader has come back to would move
the caret off whatever they were doing.

## Across a restart, out of the archive

The profile was kept and the app launched again on it. Every chip came back —
🎉 2, ✅ 1, `hear hear` 1, 👎 1 — and every reply quote with them, including the
fallback for the parent nobody has (`after-restart.png`).

**It is the archive rather than the server.** No `TAGMSG` arrived on the wire
after the reconnect; the reactions were read out of SQLite, where they sit one
row per person per emoji (`archive-reactions.txt`).

Two rows there are for messages this client never held —
`nosuchmsgidatall` and `notarealmsgid`, the ids the malformed feeds and a
mistyped `/react` named. That is the store's stated design: a reaction is kept
against the id whatever the window holds, so a page of history fetched later
brings its chips with it. The cost is that an id nobody will ever have keeps its
row.

## What the harness cannot see, and did not say so

**Tailwind v4 wraps every `hover:` and `group-hover:` rule in
`@media (hover: hover)`, and under `Xvfb` that query does not match.** The
timeline's row controls — pin, reply, add a reaction — are drawn
`hidden group-focus-within:block group-hover:block`, so in every walk this
harness has ever run they were invisible, and the walk reads as a client with no
way to reply to anything.

The probe is `hover-probe.html`, four media queries printed into a page. Under
`Xvfb`, WebKitGTK answers `hover: none`, `any-hover: none` and `pointer: none`
(`hover-under-xvfb.png`); the same engine on this desktop's real session answers
`hover=true anyhover=true fine=true anyfine=true`. So the controls are there for
a person and absent for the harness, and `SKILL.md`'s claim that `move` is how a
CSS `:hover` rule gets photographed was never true of a rule written this way.

**The way in is the focus twin.** `group-focus-within:block` is not inside the
media query, so clicking anything focusable in a row draws the pair beside it;
this run reached the reply control by opening the chips' own `+`, pressing
Escape, and clicking what had appeared (`picker.png`). Anything else in this app
drawn only on hover cannot be walked here at all.

## The picker, which nobody had opened

`docs/manual-verification.md` records that every timeline row is its own
stacking context and that `Reactions.tsx` opens its picker into one, with the
exposure never walked. It was walked here and the exposure does not reach it:
the picker is anchored `bottom-full`, so it opens upward over rows that paint
before it rather than after, and no message showed through it.

Opened on a row near the top of the scroller it is not clipped either — it
paints out over the channel header rather than being cut off
(`picker-at-the-top.png`). Ugly at that one position, and the only position
where anything is drawn over the header.

## What this does not claim

- **Anything about a server that is not ergo.** One `ergo` 2.19 on loopback,
  `CASEMAPPING=ascii`. `applyReaction` matches a nick by string equality rather
  than by the network's folding, so a server that hands back a differently-cased
  nick would leave a chip nobody can clear. Nothing here provoked one.
- **That another client drew any of this.** The peers on the socket parse; none
  of them renders. Everything above is one implementation talking to test
  sockets, which is the same gap the multiline and read-marker entries record.
- **Desktop notifications.** Nothing watched the notification bus, so "a
  reaction raises nothing" rests on the badge, the seam and the window not
  moving.
- **The pointer route to reacting to a message with no chips yet.** That control
  is hover-only, and the harness cannot see it. A person has it; this run
  reached it by focus instead.
- **Anything about timing.** Every step was driven and waited for.
