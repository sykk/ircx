# End-to-end run 33: the second session both features were written for

2026-08-19, a release build against a local `ergo` 2.19, on the walk in
`docs/end-to-end-33/`.

## The question

Two entries in `docs/manual-verification.md` asked for the same thing and had
been waiting for it since the features shipped: a second client. Read markers
wanted "a live server or bouncer with two sessions for one account"; multiline
wanted "an end-to-end walk with two clients". Everything either feature does on
its own is scripted — the parsing, the framing, the seam arithmetic, the
fallback — and none of that says whether two clients of one account agree about
what has been read, or whether a paragraph one client sends is the paragraph
another one draws.

## The instrument

**A second session is what needed building.** `MARKREAD` is relayed between
sessions of one *account*, so a walk needs SASL, and `window.mjs` seeded
`sasl_mechanism` and `sasl_account` as `NULL` with no way to set them. It now
takes `--sasl <account:password>` and writes the password where the app looks
for it — the `ircx` service in the OS keyring, under the network's id, which is
what `crates/ircx-store/src/credentials.rs` reads.

The first attempt at that seeded the mechanism as the bare word `PLAIN`, and the
app came up saying it had no networks configured. The column holds a serialised
`SaslMechanism`, so `PLAIN` deserialises into nothing and `network_from_row`
fails — which fails the whole list rather than the one row. This is the trap the
skill already documents for three columns in `messages`; it has a fourth.

`proxy.py` sits between the app and the server, because the app's own raw log
records what it queued rather than what it wrote. `session.py` is the second
session, driven from a FIFO so the walk can interleave it with the window.
`phase1_wire.py` is the same exchange with ircx not involved at all.

**The server side was established first.** Ergo relays `MARKREAD` between two
sessions of one account, and answers the query form for a session that arrives
afterwards. Without that, nothing an app-level walk found would mean anything:

```text
A >> MARKREAD #markwalk timestamp=2026-08-19T23:00:49.380Z
B << MARKREAD #markwalk timestamp=2026-08-19T23:00:49.380Z
C >> MARKREAD #markwalk                     (a session that arrived later)
C << MARKREAD #markwalk timestamp=2026-08-19T23:00:49.380Z
```

## What read markers do, watched from both ends

**Opening a conversation says so on the wire.** ircx marks read with the newest
server-time it holds, and the other session hears it:

```text
>> MARKREAD #markwalk timestamp=2026-08-19T23:00:52.461Z   ← the sixth line's own stamp
B << MARKREAD #markwalk timestamp=2026-08-19T23:00:52.461Z
```

**A marker set elsewhere takes exactly what it covers.** Six lines naming the
reader arrived in a channel that did not have focus, and the badge read six. The
second session marked the third of them; the badge read three, and nothing else
moved. `badge-partial.png`.

**And the seam lands where the other session left it.** Opening the channel
after that draws the unread rule between the third mention and the fourth,
reading `3 messages, 1 person, under a minute · 3 of them mention you` —
`seam-at-remote-mark.png`. This is the whole of what the feature is for, and it
holds.

**A query is the same and counts out loud.** Three private messages, badge
three; the second session marked the second of them, badge one.

**A query the reader has never opened is asked about by name.** `MARKREAD
talker33` goes out the moment the query opens, and again on every connect —
`request_query_markers`. Channels are not asked for: the server pushes those on
join, which ergo does.

**Across a restart the boundary comes back, as far as the server keeps it.**
With messages arriving while ircx was shut down and the second session marking
the first three read, the app came back, asked, and drew a badge of three — the
three it had not been told about. `query-unread.png`.

**What an account that is not always-on costs.** Before the account was made
always-on, the same restart asked and got `MARKREAD talker33 *`: ergo drops a
client when its last session goes, and the markers go with it. Nothing about
ircx changes that, and it is worth knowing before reading a `*` as a client
fault. ircx keeps no marker of its own across a launch — `read_markers` is in
memory and no migration holds one — so on a server that forgets, the boundary is
gone from both ends.

## What the walk found

**A channel's gap fill counts nothing toward unread.** Six lines naming the
reader arrived while ircx was shut down. It reconnected, asked
`CHATHISTORY AFTER #markwalk`, received all six, drew them tinted as mentions —
and the sidebar showed no badge and no dot. `channel-no-unread.png`.

The same shape in a query counts correctly, in the same reconnect, three minutes
apart: `query-unread.png` is a badge of three on messages that arrived the same
way. A control run with no marker anywhere said the same thing, so this is not
the read marker suppressing them: it is the channel path.

It contradicts the rule the code states for itself. `message.rs` says a gap fill
is unread — "What fills a gap is the opposite — it is what they were not here
for, which is what unread means. #223" — and a channel is where a reader
notices.

**No seam is ever drawn on a restored boundary.** The query that came back
saying three unread drew no rule above the first of them, and none appeared on
leaving and re-entering. `index.ts` declines it deliberately:

```ts
// A server backfill is what was said before anybody looked, so it does not
// move the seam that says where looking stopped. Core keeps it out of the
// unread counts for the same reason.
const seam = fresh.find((m) => m.source !== "serverHistory");
```

The second sentence is not true of a gap fill, and the badge of three is the
counter-example. So the reader is told there are three unread and shown nothing
that says which three.

**The client draws itself as typing.** `walkacct is typing…` sat above the
composer while the walk typed into it, on the reader's own nick. `handle_tagmsg`
computes `sender.is_self` for the ignore check and then emits `TypingChanged`
without consulting it, so a server that echoes `TAGMSG` under `echo-message`
tells the reader they are typing. `echotag.py` is a client with no account and
no second session, and its own `+typing` comes straight back — an account is not
needed to reproduce this.

## What multiline does

**The framing is right, and the blank line is a component.** One paste of a
paragraph, a blank line, and a 600-byte line went out as:

```text
>> @label=ircx-4 BATCH +99f2… draft/multiline #markwalk
>> @batch=99f2… PRIVMSG #markwalk :paragraph one, before the blank line
>> @batch=99f2… PRIVMSG #markwalk :
>> @batch=99f2… PRIVMSG #markwalk L001-…-L092-
>> @batch=99f2…;draft/multiline-concat PRIVMSG #markwalk L093-…-L120-
>> BATCH -99f2…
```

**A client that has the capability rebuilds what was typed, byte for byte.** The
four components reassemble — concat joins, anything else starts a line — into
the 641 characters that went into the composer, compared exactly rather than by
eye.

**A client that does not have it gets three messages and no blank line**, which
is the server splitting the batch rather than anything ircx did. Both clients
were on the same send.

**ircx draws one message.** One nick, one timestamp, the paragraph, the blank
line kept as a break, the long line wrapped: `multiline-one-message.png`.

**And it assembles one from a batch it receives.** The other client sent the
same shape — batch, paragraph, empty component, split line with
`draft/multiline-concat` — and the timeline drew a single message from
`multi33` with the 600 characters rebuilt whole. The seam above it counts what
arrived as `1 message, 1 person, under a minute` rather than as four.
`multiline-inbound.png`.

**A reply attaches to the whole thing.** A second client answered naming the
batch's `msgid`, and the quote drawn under it is the assembled message —
paragraph and long line in one elided line — not the component that carried the
id.

**With the capability gone the fallback is three labelled messages.** Ergo was
restarted with `multiline: max-bytes: 0`; ircx renegotiated without
`draft/multiline` (the status bar counts 18 capabilities where it counted 19),
and the same paste went out as:

```text
>> @label=ircx-7 PRIVMSG #markwalk :fallback paragraph, before the blank line
>> @label=ircx-8 PRIVMSG #markwalk L001-…-L092-
>> @label=ircx-9 PRIVMSG #markwalk L093-…-L120-
```

The blank line is dropped rather than sent as an empty `PRIVMSG`, and the
timeline draws three lines of one run where the negotiated send drew a paragraph
break. `multiline-fallback.png`.

## What this does not claim

- **Anything about Libera, or about a bouncer.** Both features were walked
  against `ergo` on loopback. A bouncer is the other half of what the read
  marker entry asks for and is untouched here.
- **That the markers survive on any server.** Ergo keeps them for an always-on
  account and drops them otherwise, and that is ergo's policy rather than a
  general one.
- **A rate or a timing for anything.** Every step was driven and waited for.
- **That the three findings are one bug.** They are in three different places —
  core's unread counting, the store's seam, and `handle_tagmsg` — and only the
  first two are about read markers at all.
- **That a real client sent the batch ircx received.** The inbound message was
  framed by `session.py` from raw lines, which is the specification's shape and
  not another implementation's reading of it.
