# Manual verification

Things no agent can check, because they need a real account or a human watching
the assembled app. Nothing here is covered by `cargo test` or `npm test`.

## IRCv3 multiline

The negotiated limits, outbound batch framing, fallback, inbound assembly and
echo matching are scripted.

**The end-to-end walk is done** (2026-08-19, `docs/end-to-end-run-33.md`),
against `ergo` 2.19 with a second client on the socket. A paragraph, a blank
line and a 600-byte line pasted into the composer went out as one
`draft/multiline` batch with the blank line as its own component and the long
line split on `draft/multiline-concat`; the second client reassembled the 641
characters that were typed, compared byte for byte rather than by eye. A client
without the capability received three messages and no blank line, which is the
server splitting the batch. ircx drew one message in both directions — its own
send, and a batch the other client framed — and a reply naming the batch's
`msgid` quoted the assembled message rather than the component that carried the
id. With `multiline: max-bytes: 0` on the server ircx renegotiated without the
capability and sent three labelled `PRIVMSG`s, dropping the blank line rather
than sending an empty one.

What that leaves: **a bouncer, and a second client that draws rather than
parses.** Everything above is one implementation talking to test sockets.

## IRCv3 read markers

Capability negotiation, query marker requests, local updates, remote partial
updates and unread-seam movement are scripted.

**The two-session exchange is walked** (2026-08-19,
`docs/end-to-end-run-33.md`), against `ergo` 2.19 with a second session of one
account. Opening a conversation sends `MARKREAD` with the newest server-time
ircx holds and the other session receives it; a marker the other session sets
takes exactly the messages it covers out of the badge — six mentions to three,
three private messages to one — and the unread seam lands between the covered
run and the rest. Across a restart, with messages arriving while ircx was shut
down, the query's badge came back as the three the other session had not
covered.

The walk found three defects and all three are fixed: a channel's gap fill
counted nothing toward unread where a query's counted (#565, the watermark was
being moved by the rejoin that ended the outage), the client drew its own nick
as typing where a server echoes `TAGMSG` (#567), and a boundary restored from a
marker was counted and never drawn (#566), so a reader was told there were three
unread and not which three.

**The restored seam is walked** (2026-08-20): six mentions arrived while ircx
was shut down, the account's other session marked the first three, and the
relaunched client drew the rule between the third and the fourth — the same
`3 messages, 1 person, under a minute · 3 of them mention you` the live path
draws, on a boundary that came back from the server.

Two caveats worth knowing before repeating it. `ergo` keeps an account's
markers only while the client is always-on — otherwise the last session leaving
takes them, and the client's own ask comes back `*`. And ircx keeps no marker
across a launch: `read_markers` is in memory and nothing writes it down, so on a
server that forgets, so does the client.

What that leaves: **a real bouncer**, which is the other half of what this entry
asked for.

## Ignoring somebody

What an ignore does to the session, the archive and the roster is scripted.

**The end-to-end walk is done** (2026-08-20, `docs/end-to-end-run-34.md`),
against `ergo` 2.19 with a witness client saying the same kind of thing at every
step. `/ignore` takes effect on the next line; a mention from an ignored person
left the window byte-identical where the witness's moved it and raised a badge;
a private line opened no query and two CTCP requests drew no answer, thirteen
minutes after the same request had been answered; a part and a rejoin drew no
row while the roster lost them and got them back; a `/me`, a `NOTICE` and a
`@+typing=active TAGMSG` were all silenced; and the kick, the mode and the topic
an ignored person set were all drawn, which is the design. A rename was
followed into the session, the sidebar, the bare `/ignore` list and the
`ignored` table. Across a restart the ignore held and the channel's gap fill
brought back the witness's two messages and neither of the other's.

The archive was read out of SQLite rather than off the screen: five lines of
speech, a part, a rejoin, a rename, a private message and two CTCP requests
happened while the ignore was on, and none of them is in `messages`.

The walk found #572, which is not about ignoring: ircx answers a CTCP that
arrived on a `NOTICE`, and replies on whatever command the request arrived on,
so two ircx clients trade the same `PING` until something outside stops them.
An ignore was the only thing that stopped it.

What that leaves: **a network that folds `rfc1459`** — ergo advertises
`CASEMAPPING=ascii`, so `talker[34]` against `talker{34}` is untested;
**an ignore made while a network is disconnected**, undone from the settings
dialog, which is argued for and not watched; and **the desktop notification**,
which nothing on the walk was listening for.

## Strict Transport Security

The parser, policy expiry, plaintext upgrade decision and cached-policy
enforcement are covered by unit tests. A live server with a publicly trusted
certificate still needs to verify the whole exchange: advertise `sts=port` on
the plaintext listener, advertise `sts=duration` on TLS, restart ircx, and
confirm it connects to the TLS port without touching the plaintext listener.

Also expire or remove the TLS listener while the policy is current and confirm
ircx keeps retrying TLS rather than falling back to plaintext.

## SASL against real services

**The rejection path is verified.** `crates/ircx-core/tests/sasl_probe.rs` connects
to Libera with PLAIN credentials for an account nobody has registered, which
draws the same `904` a wrong password does. Observed on the wire: `904`, then
`SaslStatus::Failed`, then `ConnectionStatus::Failed`, and `001` never arrives —
registration is abandoned rather than continuing as a stranger. It needs no
credentials, so run it whenever the SASL path changes:

```text
cargo test -p ircx-core --test sasl_probe -- --ignored --nocapture
```

**The success path is verified** by the owner against a real NickServ account on
2026-07-30: `903`, the status bar naming the account, and registration
completing after it.

What that leaves:

**A wrong password on a registered account is verified** by the owner on
2026-07-31: `904`, `SaslStatus::Failed`, `ConnectionStatus::Failed`, and no
`001` — registration abandoned rather than continuing as a stranger, the same
as for a nonexistent account.

It found the wording. Libera answers `904` with "SASL authentication failed",
and the sentence built around it read "SASL authentication with Libera.Chat
failed — SASL authentication failed". It now names the account and says where
to change it.

What that leaves:

- **`ECDSA-NIST256P-CHALLENGE`**, which ircx does not implement.

**`EXTERNAL` was a gap in the client rather than in the walking** (#373), and
#401 closed it. The entry that stood here said a run with a certificate and a
TLS listener would only fail, because `tls.rs` built both configurations with
`with_no_client_auth` and nothing anywhere read a `.pem`. That was true until
2026-08-04.

**It is now the only SASL mechanism whose success path a test can re-run.**
PLAIN's and SCRAM's needed a real account on a real network and are recorded
below as walked by the owner; certfp needs neither, because a server matching a
fingerprint builds no chain to an authority — a self-signed certificate made in
half a minute is as good as any other. `crates/ircx-core/tests/external_ergo.rs`
is the script, and the notes at the top of it are the setup in full.

Run on 2026-08-04 against `ergo` 2.19 on `127.0.0.1:6698`, with an account
holding one fingerprint:

```text
>> AUTHENTICATE EXTERNAL
<< AUTHENTICATE +
>> AUTHENTICATE +
<< 900 * * certwalk :You are now logged in as certwalk
<< 903 * :Authentication successful
<< 001 certwalk :Welcome to the ErgoTest IRC Network
   status: Connected
```

**With a certificate no account claims**, generated the same way and never
registered — the control, without which the run above would look the same as a
server that checked nothing:

```text
>> AUTHENTICATE EXTERNAL
<< 904 * :SASL authentication failed: Invalid account credentials
   sasl:   Failed
   status: Failed          ← and no 001: registration is abandoned
```

**With no certificate set at all**, nothing is sent: the client refuses it
first, and registration carries on unauthenticated to `001`. That asymmetry is
deliberate and predates this — a server's refusal is fatal, a refusal to ask is
not.

**What the run found**, which no unit test had: the sentence after a `904` said
*"Check the account name and password in this network's settings."* to a user
logging in with a certificate. That is the exact complaint #373 made about the
message sent *before* one could be presented, still true of the one that comes
back, and reachable only once EXTERNAL could get that far. It now reads
*"Register this certificate's fingerprint with the account — on the network, not
here."*, which is both the right field and the right machine.

Not covered: a certificate that expires mid-session, and a network that revokes
a fingerprint while a client holds a connection made with it. Both are the
server's answer rather than the client's, and neither has been provoked.

**Both SCRAM hashes are walked**, and this section is not where that is written
down: see **SCRAM** below, which covers SHA-256 against `ergo`, SHA-512 against
Libera over TLS 1.3, both failure paths, and a proxy that cannot prove itself.
Three of those walks are scripted in `crates/ircx-core/tests/scram_ergo.rs` so
they can be re-run against a change to `scram.rs` rather than done again by
hand.

> This section said "ircx requests PLAIN only" until 2026-08-03, which stopped
> being true when SCRAM shipped and was contradicted by the SCRAM section forty
> pages down. A file this size can disagree with itself; a claim about what is
> unverified is worth grepping for before it is trusted.

> Testing a wrong password by sending `/msg NickServ IDENTIFY` does **not**
> exercise SASL. SASL happens during registration, before you can message
> anyone; a failed NickServ login afterwards leaves the SASL session it already
> established untouched. Change the credential in the network's settings and
> reconnect.

## Things the Libera runs left unverified

The first run (PR #43) left four gaps. The second (PR #48) closed three of them
in `crates/ircx-core/tests/libera.rs`: a member list split over 31 replies in
`#libera`, a server-initiated PING answered after 136 seconds of silence, and a
cold start timed from process exec to the first frame the compositor was handed.
What is left:

- **A dropped socket is walked** (#246, 2026-08-01), which the first two runs
  could not provoke. A proxy in front of ergo was cut and restored while the
  channel kept talking: the status bar counted down, the client reconnected and
  rejoined, and what was said in the outage came back bounded as history and
  counted as unread.

  It found the near side of the gap never moving. `restore` runs once, at
  startup, and the query search read its watermark on every registration — so a
  reconnect asked from the launch rather than from the drop, a window that only
  grows against a `TARGETS` limit that does not. Seen by reading the two
  requests side by side on the wire: the channel's own `AFTER` had moved and the
  `TARGETS` had not. The near side is taken again when a connection ends.

- **Netsplit recovery.** Nothing can provoke one politely, and none happened
  during either run. The member list half is now scripted instead:
  `a_netsplit_takes_its_half_of_the_channel_and_gives_it_back` in
  `crates/ircx-core/tests/session.rs` divides a hundred-member channel with a
  burst of QUITs carrying a split reason, brings them back with a burst of
  JOINs and a second NAMES, and asserts nobody is lost, doubled or stripped of
  their rank. A rejoin arriving before the QUIT that explains it has its own
  test.

  **Both halves of what that left were watched on 2026-08-01**, against a local
  ergo driven through a netsplit-shaped burst: thirty-one clients joining at
  once, seven renaming, all of them leaving.

  The timeline holds. Sixty-nine events fold into one line — `31 joined, 7
  renamed, 31 quit.` — with room either side, which is the whole of what the
  digest is for.

  **The roster did not**, and that is where a real defect was: seven people
  renamed and then left, and their old names stayed in the member list for the
  rest of the session. `handle_nick` re-keyed the member correctly and said only
  that somebody had arrived under the new name, so the frontend — which holds a
  list of names — kept both, and the quit that followed named the new one and
  took only that away. A rename says the old name is gone now.

  **The same shape had the same fault in a query**, walked on 2026-08-01: one
  private conversation drew as two rows, the older holding the history behind a
  composer addressed to a nick nobody held. A conversation now moves with the
  person, whole, while what is already written down keeps the name it was said
  under.

  Worth knowing before reproducing either: **a rename is only ever heard from a
  server if you share a channel with the person.** The first attempt at this
  walk had them open a query and nothing else, and ircx never saw the `NICK` at
  all — the second name simply arrived as a second conversation, which is not
  something the client can do anything about.

- **Reactions on the wire are verified, and they do not work on Libera.** Run
  by the owner against `cadmium.libera.chat` on 2026-07-30, with `message-tags`
  and `echo-message` both negotiated — confirmed by `CAP LIST` rather than
  assumed. See #108.

  ircx sends the line the specification describes:

  ```text
  >> @+reply=<msgid>;+draft/react=😄 TAGMSG #omgwtf
  ```

  Libera relays `TAGMSG` and relays client-only tags: a `+typing=done` TAGMSG
  came back echoed, carrying a server `msgid`. So neither the message type nor
  the client-tag mechanism is the problem. The reaction lines simply never came
  back, with no error and no `FAIL`.

  Bisected with `/raw` on the same connection, minutes apart:

  | sent | echoed |
  |---|---|
  | `@+typing=done TAGMSG #omgwtf` | yes |
  | `@+draft/react=x TAGMSG #omgwtf` | no |
  | `@+reply=<real msgid> TAGMSG #omgwtf` | no |
  | `@+zzz=1 TAGMSG #omgwtf` | no |

  Libera relays only the client tags it knows. That was an inference from the
  table above until a tag no server has heard of settled it: `@+zzz=1 TAGMSG`
  did not come back either, so nothing about ircx's tag names or values is at
  fault. A reaction sent from ircx therefore reaches nobody, including the
  sender — the chip that appears is
  the local copy `SessionState::react` emits without waiting, which is why this
  looked like it worked for as long as it did.

  What that leaves:

  - `+reply` **does not survive on a `PRIVMSG` either**, checked the same way on
    the same connection: the echo came back without the tag while a `+typing`
    TAGMSG echoed seconds earlier. So the mechanism is an allowlist rather than
    a filter on the `draft/` namespace — `reply` is not a draft tag and is
    dropped in both message types.

    That costs a second feature. `reply_to` is read from `+reply` on the way in
    and `ReplyQuote` draws from it, so on Libera that component cannot render.
    It also surfaced #112: ircx never *sends* `+reply` on a message at all, so
    the reply path has never worked end to end anywhere.
  - **Another network settled it, and the client's side is correct.** Run
    against a local `ergo` on 2026-07-30 — the first time the path has worked
    end to end anywhere:

    ```text
    >> @label=ircx-1 PRIVMSG #test test
    << @msgid=viupz9sxm6dubaqnxd3sf66fva;label=ircx-1 … PRIVMSG #test :test
    >> @+reply=viupz9sxm6dubaqnxd3sf66fva;+draft/react=👍 TAGMSG #test
    << @msgid=…;+reply=viupz9sxm6dubaqnxd3sf66fva;+draft/react=👍 … TAGMSG #test
    ```

    That answers both questions this entry was written to ask. A server does
    relay a `TAGMSG` carrying the tag, and the `msgid` a `+reply` names survives
    the relay byte for byte. `+draft/unreact` round-trips too, so taking one
    back works, and the `label` echo confirms `labeled-response` on the same
    line.

    Ergo relays `+draft/react`, `+reply`, `+typing` and even an invented `+zzz`;
    Libera relays only `+typing`. That is the difference and the whole of it.

    Rebuilding it needs a server that relays client tags. `ergo` runs from a
    single release binary on loopback once the `:6697` listener is removed from
    its `default.yaml`, and a short socket script can probe the four tags with
    ircx not involved at all — worth doing rather than assuming, if this is ever
    in question again.
  - **A second client rendering one**, which needs both a server that relays and
    a client that draws it. IRCCloud does not implement the tag; the entry here
    used to say it did, and that was wrong.

## Composing a reply

#112 built the send half: a `+reply` naming the parent's `msgid` goes on the
`PRIVMSG`, and `crates/ircx-core/tests/session.rs` asserts the line, every piece
of a split, the local copy's quote and the plain fallback without
`message-tags`.

**The wire is verified.** The probe above proved `ergo` relays `+reply` on a
`TAGMSG`, which is what a reaction rides on; a reply rides on a `PRIVMSG`
instead, and a server allowlisting client tags could treat the two differently.
Two raw sockets on a local `ergo` on 2026-07-31, ircx not involved:

```text
answerer >> @+reply=vcgd7gp6dgd7hp4347ajqaqk6a PRIVMSG #replyprivmsg :it is, thanks
author   << @time=…;msgid=m3i6rz7yv…;+reply=vcgd7gp6dgd7hp4347ajqaqk6a
            :answerer!~u@… PRIVMSG #replyprivmsg :it is, thanks
```

The tag reaches the other client naming the same msgid byte for byte, and the
sender's own echo carries it back as well.

**ircx drives it correctly.** Run against local `ergo` on 2026-07-31: reply
clicked in the timeline, line sent, read off a second client's socket.

```text
@msgid=73wr46ugs6kvnbpb3qep8xq5he;time=…;+reply=p9fsy6knntni4dt3yndbmv69b6
  :syk!~u@… PRIVMSG #replytest :ffff
```

The `+reply` names the parent the control was clicked on, and the second client
resolved it back to the right message. Three replies to two different parents
all landed correctly.

**A split reply carries the tag on every piece.** A 600-character reply arrived
as two messages naming the same parent:

```text
@msgid=skyxwtig…;+reply=9w5f72rc8dhgggvphsf9mqkdz6 … :This single sentence … from the very first word to
@msgid=e6but6s3…;+reply=9w5f72rc8dhgggvphsf9mqkdz6 … :the final period at the end of this long …
```

**Its quote is drawn once, and only where it should be.** #138: each piece
carries `+reply`, so the timeline drew the quote under every one of them and
split a paragraph in two. Verified on ergo on 2026-07-31, all three cases
visible in one screen:

  - a split reply quotes its parent above the first piece and not the second
  - a different person answering the same parent, in the same minute, keeps
    their own quote — a block is a minute rather than a run of one person's
    lines, which is why the rule checks the sender as well
  - a reply to a different parent quotes again

Producing one takes more text than it looks. The budget is not a fixed number
to aim at: `wire_budget` derives it from the nick, ident, host and target,
because those are what the server prepends to the copy everyone else receives.
On ergo as `syk!~u@4dy55fkndsc9u.irc` in `#replytest` it came to 464 bytes, and
a 400-character attempt went as one message. Read the figure off the mask in the
raw log rather than guessing at it.

**The whole path is walked in the window** (2026-08-20,
`docs/end-to-end-run-35.md`), against `ergo` 2.19 with two clients on the
socket. A reply armed from the timeline's own control went out as
`@label=ircx-9;+reply=<msgid> PRIVMSG` and drew its quote; a reply coming the
other way drew the parent it named; and one naming a message this client has
never held drew *in reply to an earlier message* rather than an empty quote.
Both spellings arrive — `+reply` and `+draft/reply` — because `reply_to` reads
either.

The walk found one defect, and it is in the composer rather than the wire:
arming a reply left the caret on the button that armed it, so a sentence typed
straight afterwards went to a button and was lost. #575. Nothing in
`Composer.tsx` called `focus()` at all.

**On Libera it will not work**, and the client cannot tell in advance. Client
tags there are an allowlist holding only `+typing`, and `message-tags` is
negotiated all the same — so ircx attaches `+reply`, draws the quote on the
sender's own copy, and Libera strips the tag before anyone else sees it. That is
exactly the position reactions are in, and for the same reason.

## Reactions, in the application

The wire is verified above and on Libera; what had never been watched is the
chip. **Walked 2026-08-20** (`docs/end-to-end-run-35.md`) against `ergo` 2.19,
release build, with a second and third client on the socket.

Reactions arriving from two people make one chip carrying the count and both
names, your own is outlined and written as `you`, and taking the last one back
removes the chip. A reaction inside a query lands in the query, because
`handle_tagmsg` takes the target from the sender when the parameter is not a
channel. `/react` and `/unreact` do the same by hand, a value with a space in it
is escaped as `hear\shear` and arrives whole, and `/react` in the server tab is
refused with a sentence rather than sent.

Four lines that should draw nothing drew nothing, each measured as two
byte-identical frames: a reaction with no `+reply`, one carrying `+draft/react`
and `+draft/unreact` together, one naming a `msgid` this client has never held,
and one from somebody `/ignore`d — that last against a control who sent the same
emoji a second later and appeared.

**The chips survive a restart out of the archive rather than off the server.**
Every chip and every reply quote came back on a kept profile, and no `TAGMSG`
arrived on the wire after the reconnect. `reactions` holds one row per person
per emoji, including rows for `msgid`s this client never had: that is the stated
design — a page of history fetched later brings its chips with it — at the cost
of a row for an id nobody will ever hold.

**A reaction moves no counter.** Sent into an unfocused query it left the window
byte-identical: no badge, no unread, no seam.

**A chip under the sticky author band is hidden and still live** (2026-08-20,
`docs/end-to-end-run-37.md`). The band is opaque, the width of the timeline and
19.5px tall against a chip's 22, so a chip passing under it is drawn over down
to a two-pixel sliver — and it is `pointer-events-none`, so a click on the part
that is not drawn reaches it. In the window that click put `+draft/react` on the
wire, counted the reader into a chip whose top was behind the band, and took it
back again on a second click. What to do about a control that is invisible and
live is a design question and nothing has been decided.

**Not walked:**
- **Another client drawing what ircx sends.** The peers parse; none of them
  renders.
- **A network that folds `rfc1459`, against a real server.** The defect this
  run named is fixed — #578. `applyReaction` still matches by string equality,
  because casemapping does not cross the IPC boundary and the frontend has no
  way to fold; what changed is that it is now fed one casing per person.
  `session.rs` resolves a reactor through the channel it happened in before the
  event leaves, the way `canonical` resolves a target, so the chip's nick list,
  the archive's unique index and the `you` in the label all agree. Persistence
  runs off the same event, so the row and the chip cannot disagree either.
  Scripted against `rfc1459` folding — where `[` and `{` are one nick, which
  lowercasing would not catch — and against the `echo-message` copy of your own
  reaction. Still unwalked against a server that actually re-cases: `ergo`
  advertises `CASEMAPPING=ascii` and nothing has provoked one. Rows written
  before the fix keep whatever casing they were written under.
- **The pointer route to reacting to a message with no chips yet.** That control
  is hover-only, and the harness cannot see it — see below.

## The preview fetch over TLS

`crates/ircx-net/tests/http_loopback.rs` drives the whole fetch — framing,
redirects, caps, timeouts — over plaintext loopback, because TLS there would
need a certificate fixture.

**The transport is verified** by `crates/ircx-net/tests/https_probe.rs`, which
is ignored by default and opens real connections the way `sasl_probe.rs` does:

```text
cargo test -p ircx-net --test https_probe -- --ignored --nocapture
```

On 2026-07-30 it completed a handshake with `example.com` and read 559 bytes of
`text/html`, refused a body past a 64-byte cap with `TooLarge` specifically
rather than by accident, and did not let a request land on a site that was not
asked for.

It also turned up #106, since fixed: `www.host` redirecting to `host` counted as
crossing hosts, which refused most of the web. The probe now follows
`https://www.rust-lang.org/` to its apex, which is the URL that found it.

**The path through the application is verified** by the owner on 2026-07-30: a
posted image, fetch clicked, and the preview drawn. The probe only ever proved
`ircx-net` could fetch — not that the click reaches the fetch or that what comes
back is rendered.

**A refusal has now been watched land in a conversation** (2026-08-02). Somebody
in the channel posted `http://127.0.0.1:8899/cat.png`, the `fetch` beside it was
clicked, and the row answered:

```text
127.0.0.1 is on your own machine or local network, and ircx will not fetch
there on a link's say-so — open it in your browser if you meant to
```

It arrives inline beside the control, in the danger colour, and it names the
host and what to do instead. The row is not made taller by it; what gives is the
filename, which truncates to `cat.p…` to make room.

**The other two refusals cannot be walked here, and the reason is the guard
above.** `preview.rs` takes `FetchPolicy::default()`, which has
`allow_local_addresses: false`, so any server a walk can stand up is refused for
being local before it can redirect across hosts or overrun the 4 MB cap. Only
`http_loopback.rs` — which sets that flag — reaches those paths, and it has no
window. Watching them from inside the app needs a public host that redirects
across sites or serves something big, which is a third party in a walk and has
not been done. Worth knowing before somebody spends an hour standing up a local
server for it, as this run did.

### A fetched preview is drawn under the line

**It was made a hover peek and taken out again**, and what the attempt found is
worth more than the design was. For one day the line stayed one row and the
image was shown by hovering or focusing the filename. It reads worse: an image
you have already asked for and paid for should be on the screen, and a preview
you have to keep a pointer on to read is not one. The image is back under the
line, capped at 220px, exactly as before.

Two defects came out of walking it, and both are about this timeline rather than
about that peek. Neither could fail a `vitest` run — jsdom lays out nothing, so
an overlay that leaves its scroller and an overlay that is painted over look
identical to a correct one.

**The window is not the box that clips.** The peek chose its side against
`window.innerHeight`, and the timeline scroller ends where the composer starts:
`[84, 597]` of a 713px window. A line halfway down the pane had 191px of real
room below it against the 307px that arithmetic claimed, and the overlay ran out
through the bottom of the scroller — 105px past it at 1200x560. Anything drawn
over the timeline has to measure the scroller, and to cap itself to the room on
the side it picks, because a pane short enough holds it on neither side.

**Every timeline row is its own stacking context.** `Timeline.tsx` places each
virtualised row with `transform: translateY(...)`, and a transform makes one — so
an overlay opened inside a row is painted over by every row below it however
high its own `z-index` goes. `Reactions.tsx` opens its picker the same way and
has the same exposure; nobody has walked it. Worth knowing what the fault looks
like, because it does not look like z-index: it looks like a translucent panel
with other people's messages showing through, on a theme whose
`--surface-overlay` is an opaque `#171c24`. The fix that worked was
`hover:z-10 focus-within:z-10` on the row, which went out with the peek and is
recorded here rather than kept.

**The fetch itself is walked in the assembled app**, on 2026-08-08 against a
local `ergo` on `127.0.0.1:6667` — which is worth keeping whatever is drawn
afterwards, because the entry above only had it verified by the owner in 2026-07.
A `upload.wikimedia.org` URL was typed into the composer and sent, the line drew
its `fetch`, and clicking it pulled a real 224 KB PNG over TLS and drew it. So
the path from a link in a conversation to an image on the screen works in
WebKitGTK, not only in Chrome.

`seed.mjs` carries an attachment and a `load_preview` handler now, without which
none of this was walkable, and `xsend` grew a `move` verb — a motion event and
no button. `move` was built for the peek's hover and is the only way this
harness can photograph a bare CSS `:hover` rule, so it stays.

**A Tailwind `hover:` rule is a different matter, and no walk can see one.**
Tailwind v4 wraps every `hover:` and `group-hover:` utility in
`@media (hover: hover)`, and WebKitGTK on `Xvfb` answers that query `hover:
none` — there is no pointer device on that display, whatever `move` does with
XTEST. Run 35 measured it both ways with a four-line probe
(`docs/end-to-end-35/hover-probe.html`): `hover: none`, `any-hover: none`,
`pointer: none` under `Xvfb`, and `hover=true anyhover=true fine=true` from the
same engine on a real session. So the timeline's row controls — pin, reply, add
a reaction — are invisible for the whole of a walk and read as controls the app
does not have, and anything else drawn only on hover is unwalkable here. The way
in is `group-focus-within:`, which is not inside the media query: click anything
focusable in the row and the pair appears beside it.

**Not walked:** whether a very tall image under the line pushes the rest of the
conversation about as it decodes. The cap is a `max-h`, so the row's height is
known before the bytes are, and nothing has provoked a reflow at that seam.

## Assembled-application testing

Driven end to end on 2026-07-30 and written up in `docs/end-to-end-run.md`:
launch against an empty profile, onboard to Libera, connect, join `##test`,
send, split a pane, use the palette and search, quit and relaunch. It found ten
defects, filed as #49 to #58; the report says which parts of the walk worked and
which are still unevidenced.

The fixes for those ten were re-walked the same day and written up in
`docs/end-to-end-run-2.md`. All ten hold up against a live connection. That run
settled the console filling up on its own, the absence of a targetless `TAGMSG`
now that the raw log can be read from inside the app, and the restart seam. It
found two new defects, #67 and #68.

A third run on 2026-08-01 went to a local `ergo` instead, because what it was
there to see was `draft/chathistory` and Libera has none to give.
`docs/end-to-end-run-3.md`; six defects, #221 to #226.

A fourth on 2026-08-02 went after one thread rather than the whole app: a paste
draining, and a cut through the middle of it. `docs/end-to-end-run-4.md`. It is
the first run to have a conversation on screen — #344 opens one without being
asked — and the first to type into the window, which turns out to be possible
here after all. One defect, #345.

**A dev server on the port belonging to another checkout is refused now** (#233,
2026-08-01). It used to be served: the window came up, connected, joined a
channel and drew a conversation built from somebody else's working tree, with
nothing reporting anything. The port is stated once, in
`src-tauri/tauri.conf.json`, and the dev server names its own root on every
response so the binary can tell whose it is. A server that says nothing about
itself still starts the app, with a line saying so — a check that cannot run is
not a reason to refuse.

**Run it on `Xvfb`, not on a nested `Xwayland`.** The first two used a rootful
`Xwayland :99`, which is an ordinary window on the operator's desktop: it takes
focus and keystrokes like any other, so the operator's typing and the harness's
XTEST events land in the same application and neither can tell them apart. A
first attempt at the third run was abandoned for exactly that, after the mixed
input was read as the application acting on its own. `Xvfb :98` has no window and
cannot be typed into by accident.

What is still open:

- **The topic path is walked, and one half of it was never what this said.** A
  `/topic` typed by the user is driven against a real server by
  `a_topic_typed_here_comes_back_changed` in `crates/ircx-core/tests/ergo.rs`,
  and the join path is written up under *The topic of a channel you have
  joined*. This entry used to call that second one "the header drawing a topic
  it is given", and it is not: what the 2026-07-31 walk watched was the
  **timeline** drawing `The topic of X is: …` and `Set by …`, which is what that
  section records.

  The header draws no topic, and the fourth run looked straight at it —
  `#walk   2 members` with the topic set and named two rows below in the same
  pane. Nothing in the app draws one for a channel you have joined. #345,
  `docs/end-to-end-run-4.md`.
- **Independent scrolling between split panes** is **verified** by the third run
  on 2026-08-01, which is the first one to split anything. Two panes on one
  channel, one sitting at the top of the history while the other was at the
  bottom, each with its own roster and composer: `docs/end-to-end-3/07-split-panes.png`.
  It reads as two views of one conversation rather than as two things sharing a
  box, which is the question `PaneTree.test.tsx` could not answer.
- **The lock icon in the sidebar is checkable now** (#243, 2026-08-01). A
  channel says what it is on the way in, the way the topic does:

  ```text
  #vault is behind a key, moderated, closed to messages from outside and
  topic-locked to ops.
  ```

  Walked against a local ergo with a channel held at `+mnt` and a key, by an
  operator who stayed — an empty channel ceases to exist, and rejoining one
  makes a fresh channel with the server's default modes, which is what the first
  two attempts at this measured instead. The sidebar drew its lock and the line
  says why.
**A conversation closed before quitting stays closed**, verified by the owner on
2026-07-30. That entry sat open from the second end-to-end run and nobody could
have done it: until #121 there was no way to close a conversation at all, so it
was an unreachable behaviour rather than an untested one. The sidebar row's menu
closes one now, and it does not come back on the next launch — which is the join
between the set core forgets and the archive it is written to, and the part no
test reaches.
- **The raw log under load.** Watched during a `/raw LIST` against Libera on
  2026-07-30, and it froze the window hard enough to need the process killed —
  twice. Libera answers with roughly 22,000 lines and the log drew every line it
  held on every arrival. It is virtualised now (#119), so what is drawn is what
  fits.

  It still lagged after both, and the cause turned out to be neither: every
  `LIST` reply also fell through to `server_words` and became a console message,
  so twenty-two thousand of them poured into a timeline that caps at ten
  thousand. #125 collects them instead.

  **`/list` is verified** by the owner against Libera on 2026-07-30: no lag, and
  the channel list comes up. Three changes were needed and the first two, while
  both real improvements, missed the cause — the measurement after each is what
  said keep going.

  **The netsplit half is measured** on 2026-08-02, and the answer is that the
  timeline is not where the cost is. It differs from a `LIST` in a way that
  matters: a `LIST` is one numeric that now bypasses the timeline, where a split
  is thousands of QUITs and JOINs that each legitimately belong there. Five
  thousand of them fold into one digest line and cost 3 ms to lay out. What
  costs is the store: a 2,500-member split took 134 ms when it was first
  measured, of which the roster was 75 ms. Both halves are linear now — the
  roster in #321, the messages in #325 — and a re-measurement of the same batch
  reads 9 ms. `docs/measurements.md` has the tables, the method, and why the two
  passes are not directly comparable.

  **The burst below the frontend is measured too**, on 2026-08-02, and it moves
  where the cost is again. `crates/ircx-core/tests/burst.rs` empties a channel
  of 2,500 against a local `ergo` and times what the socket, the parse, the
  session and the archive do with it: 790 ms, against the 12 ms the two frontend
  stages spend on the same burst. Over half of that was the archive writing each
  quit in its own transaction, which #328 batches — the same burst is 380 ms
  now. The frontend rounds were worth doing and they were worth about three
  percent of it.

  Read the method before quoting any of that: the first pass put the archive on
  a tmpfs, which made it look like a third of a 490 ms burst rather than half of
  a 790 ms one.

  It is a hitch rather than the freeze `LIST` was, because it arrives as one
  batch and costs one long frame.

  **The burst is walked in a window now**, by the owner on 2026-08-02, which is
  what the two rows above could not answer between them: one measures jsdom and
  the other stops at the events. A running client sat in `#test2` on a local
  `ergo` while three bursts were driven into it from throwaway clients — 400,
  then 1,500, then a thousand-person split and its heal. **7,800 arrivals and
  departures, and the archive holds 7,800**: the joins and the quits reconcile
  exactly, and the set of names that joined without a matching quit is empty.
  That is #328's held write checked against a live client rather than against
  its own unit tests, and it is the durability question the hold raises.

  To do it again: connect the crowd, register them, join them all, let the
  window draw them, then close every socket in one pass — a burst is made by the
  closing being together, not by the leaving being fast. `ergo` exempts
  `localhost` from `ip-limits` in its shipped config, so a few thousand clients
  from one address are not throttled; `fakelag` applies to what a client sends
  and does not matter here. The counts come out of the archive with SQLite,
  which is the part worth checking rather than trusting: what a digest says it
  folded is a summary, and what the archive holds is the claim.

  **The fold holds in WebKit.** Roughly 3,800 of them drew as two digest lines —
  *Over 2 minutes: 1901 joined, 1900 quit* and *Over 3 minutes: 1001 quit, 1000
  joined* — with an ordinary message between them untouched. `rows.test.ts`
  asserts that at 2,500 in jsdom, where nothing is laid out; this is the first
  time anything has drawn one.

  **Expanding one does not hang the window.** *show all* on one of the two —
  they held about 3,800 and about 2,000, and which was clicked was not
  recorded — rendered every message in it and stayed responsive.
  `SystemMessage.tsx` maps every folded message with no cap and no
  virtualisation, so this was the plausible way to reach the unscrollable
  channel that the fold exists to prevent. Worth knowing what bounds it: a
  timeline holds `TIMELINE_CAP` messages, so 10,000 is the worst a digest can
  be, and this walked between a fifth and a third of that. Observed rather than
  timed, on a debug build — which is the slow direction, so a release build is
  no worse.

  **The pane kept its place through all of it.** The reading position sat where
  it had been left, several thousand arrivals earlier, with the *Live from here*
  marker below — #309 doing its job at a scale nothing had tried. Worth saying
  because it reads at first glance like a client that missed the traffic.

  Still unwalked: a real netsplit. What was driven is a few thousand ordinary
  sockets closing at once, which is the arrival rate without the server link,
  the `*.net *.split` reason or the `NETSPLIT` batch.

**The header's invite control is verified** by the owner against Libera on
2026-07-30. The invite arrived at the other client, and a channel without `+o`
answered `That needs channel operator status in #omgwtf` — a numeric turned into
a sentence, which is what the convention asks for. That closes the gap #83 left:
`ChannelHeader`'s test mocks the IPC boundary, so nothing in the suite could see
core refuse the command, which is how the missing dispatch arm survived at all.

## The member list in a split

Every pane on a channel draws its own roster (#95). `PaneTree.test.tsx` asserts
which panes hold one, but jsdom draws nothing, so what the tests cannot answer
is whether it looks like one conversation or like two things sharing a box.

**Two rosters at once is verified** by the owner against Libera on 2026-07-30:
`#omgwtf` and `#test1233` open side by side, each listing its own members, and
`Ctrl+Shift+M` hid one while the other stayed. What that run did not settle:

- **The seam between the pane header and the roster is measured**, on
  2026-08-02, and the two rules are the same rule. Read off the pixels of a
  1200x800 window rather than judged by eye — the point of the entry was that
  nothing measured it:

  ```text
  x        400   700   950  |  1010  1100  1180
  rule y    83    83    83  |    83    83    83
  ```

  400 to 950 is the conversation, 1010 onward is the roster, and the line under
  the header holds `y=83` across both with no step. Along that row the only
  interruption is one pixel at `x=992`, where the vertical divider between pane
  and roster crosses it.

  What does differ is the surface: the roster's background is three levels
  lighter than the conversation's (13 against 10 of 255). So the roster is told
  apart by its ground and its divider, and not by a broken rule — which is the
  way round this entry was written to want.

- **A narrow pane was watched, and it was worse than this entry guessed.** A
  `Ctrl+\` split on a 1194px window gave the roster about 45% of each pane and
  wrapped `/help` mid-phrase — #114. The roster no longer takes a fixed column:
  it asks for the longest name it holds, between an 8rem floor and the 13rem it
  used to always take. **The ceiling was watched on 2026-08-02**, five members
  in `#wide` on a local ergo with two nicks long enough to reach it. The column
  measured 207px against the 208 that 13rem is, so it clamps where it says it
  does, and the two long nicks truncate:

  ```text
  wallabywombatthe…       quartermasterandac…
  ```

  That is the design working. What the look also found is that **nothing gives
  the whole nick back**: the inspector's heading truncates in the same column
  and yields one more character, and `MemberRow` carries a `title` only for
  somebody who is away, so hovering a present member says nothing. In the list
  of who is here, a long enough name is unreadable and two of them sharing a
  prefix are indistinguishable. #352.

  **What the column asked for and what it drew came apart**, found on
  2026-08-01 and fixed in #301. It reserved `<widest>ch + 2.25rem` and neither
  term held: the gutter covered the padding but not the presence dot or the
  gaps either side of the sigil, and `ch` was the width of a zero in the prose
  face, because only the sigil was ever drawn in mono. So the longest nick in
  every channel was the one that truncated. Measured in the running frontend,
  `wallabywombat` was given 83.7px of the 96px it needed, inside a column the
  formula had sized at 132.65px. At the floor the same shortfall wrapped
  `Operators — 1` onto two lines, in a row whose height is fixed at 34px.

  Worth knowing before touching that arithmetic: `ch` is measured against the
  element the width is on rather than the rows inside it, which is why the
  column carries the mono family itself.

- **A large channel.** The second Libera run read `#libera`'s member list across
  31 replies, so it is the size of channel worth trying. `MemberList` renders
  the list it is given, and one roster per pane means two of those rendering at
  once, each re-rendering as members come and go. Both end-to-end runs split
  panes on quiet channels, so nothing has drawn two busy rosters together.

### Narrowing the roster

**Walked 2026-08-10 in the browser harness**, `driver.mjs --seeded` against
`#ircx`, whose six members include `walker` and `wallabywombat` — so `wa`
narrows to two rather than to one, and a filter that had quietly stopped
filtering would still read as working on one match.

- **The band is empty until the filter is used.** At rest the roster is the one
  `docs/mockup.png` draws: no input in the DOM at all, and the rule under the
  channel header carrying across it unbroken.
- **The palette entry opens it with the caret in it.** `Filter members`, Return,
  and `document.activeElement` is the field.
- **Typing narrows it.** `wa` left `walker` and `wallabywombat`, under a heading
  reading `Members — 2` — the matches rather than the channel.
- **Escape clears it and hands focus back to the column**, and a second Escape
  then closes the roster. Those two keystrokes are what the handback is for.
- **A key with the list up opens the filter carrying that character.** `m` from
  the column drew `marrow` and `wallabywombat`.

**Found by walking it**, and not this page's own doing: the palette restored
focus to whatever opened it even when something else had already taken it, so
the entry above opened a filter and then put the caret back on the sidebar row
the palette was opened from. `useDialogFocus` now declines the restore unless
focus is still on `body`. Nothing had reached it before, because closing a
dialog had never been what put a control on screen.

**Still unseen:**

- **The ceiling on a filtered column.** `rosterWidth` measures every member
  rather than the ones drawn, so a filter does not narrow the column — that is
  deliberate, a column resizing on every keystroke being worse, but nothing has
  photographed a filter over a roster sitting at its 13rem ceiling.
- **WebKitGTK.** This is Chrome against Vite. The focus handback is the part
  worth repeating in the window, being the half jsdom cannot see either.

## Where a pane is reading, across a split

A pane is rebuilt whenever the layout changes shape (#308), so the position only
survives in the store. Two rounds found two different ways it did not, and both
are worth knowing before touching `Timeline`'s restore.

**A pane at the live edge** recorded the offset it happened to sit at, so it came
back that many pixels down a narrower pane, which was near the top — #305, found
2026-08-01. It records `null` for following now.

**A pane reading history** recorded an offset that meant nothing at the new
width, and the restore then overwrote the stored position with the top of the
channel — #307, found 2026-08-02. Walked on a 300-message channel parked 45% of
the way down:

```text
parked:       scrollTop 6407, top of the screen reading "line 129 of the backlog"
after split:  scrollTop 0 of 13609, reading "line 0", the stored position now 0
```

It records the row at the top of the screen now, and comes back to it: the same
walk reads `line 129 of the backlog` at `scrollTop 6376 of 13993`.

**What no test covers, and why.** The restore is re-asserted every render until
the reader takes the pane over with a wheel, a pointer or a key. That is not
belt and braces: the virtualiser goes on adjusting the scroller as it measures
rows for real, and it walked a restored pane back to the top *after* it had
landed. Traced by hooking `Element.prototype.scrollTo` — the restore put the pane
at 5980, and a later `scrollWithAdjustments` inside the virtualiser called
`scrollTo({top: 0})` on the same element. jsdom measures nothing, so that
settling never happens there and no test can reproduce the race. What the tests
hold is that the row is recorded and comes back; that it *stays* has only been
watched.

## The scroll event the anchor sends itself

`usePrependAnchor` moves a pane by assigning `scrollTop` and then raises the
`scroll` event for it, rather than waiting for the browser's own a frame later.
The virtualiser refreshes its copy of the position only in that listener and
computes every correction from the copy, so a correction landing in the window
between the assignment and the event is added to where the pane was before and
discards what the anchor wrote. #508, and the head's 24px is what it discarded.

**No test covers the race, and two sweeps say why.** `layoutHarness.ts` settles
the layout between actions, so a first measurement of a row above the fold never
straddles a head arrival there. 134 parked positions on an arrival and 51 more
on the shape a second landing has, with every write to the parked scroller
recorded, produced **exactly one write in all 185** — the anchor's — where the
release app makes two. The same shape as the restore above: jsdom measures
nothing, so the settling that causes this never happens in a test.

What the tests hold is that the pane being put back does not read as the reader
taking it over — the events are held in a `WeakSet` and `Timeline`'s own handler
stands down for them, which `follows the tail when new lines merge into the row
that is already open` is what catches. What the tests cannot hold is the race
itself.

**What was watched instead**, in `docs/end-to-end-run-24.md`: 100 landings
either side of the fix on the same walk, machine and server. 6 moved before and
0 after, and the write that did the damage went from 6 of 151 head arrivals to
0 of 149.

**On the build that ships**, in `docs/end-to-end-run-25.md`. Run 24's arms both
carried `VITE_PROBE=1`, so its own report declined to call that binary the one
anybody runs. Run 25 built both arms without it — checked, not assumed: the
whole of the probe surviving in the bundle is one unreferenced member of the
object `ipc.ts` exports — and alternated them rather than running one after the
other. The control moved **4 in 100**, against 6 in 100 with the instrument
compiled in, so the instrument was not the experiment. The fixed arm moved 0 in
100, at p = 0.121: consistent with run 24 and not an independent confirmation of
it. What carries the fix is still run 24's discriminator rather than either
rate.

> Run 25 also found `paneshift.py` naming −202px for a pane whose message
> column was byte-for-byte identical — the failure `still.py`'s docstring
> records from #510's control, and the second sighting of it. A move is read off
> the message column now: a pane that translated draws different text at every
> row. Runs 23 and 24 are unaffected, checked rather than assumed — every
> landing either counted is −24px exactly, and run 24's six are the same six its
> probe records independently flag.

**The line at the head of a pane that did not ask (#516) is walked**, in
`docs/end-to-end-run-26.md` (2026-08-14, release builds against a local ergo).
Run 25 could not: the line draws at the top of the timeline, a pane scrolled far
enough up to show it is a pane that has asked for a page itself, and that is the
case the fix says *should* draw it.

What resolves it is the state a pane is in when it is **owed a page it has
already asked for and not been given**. `holdpage.py` keeps the batch answering
a `CHATHISTORY BEFORE` and passes everything else at wire speed, so the ask runs
out `ROUND_TRIP_TIMEOUT` and the pane settles at the top of its content with
"The server has not sent this page yet" over it — nothing prepended to move it,
and no scroll left in it to ask again with. The pane beside it is then walked to
the top, where it asks.

- **The control draws the line in the pane that asked for nothing**, 3 runs of
  3, and the fixed arm in none of 3. The rows under the head are still in all 18
  comparisons either arm, so the whole of what the fix changes is that sentence.
- **Both arms draw it in the pane that did ask**, and take it off when the round
  trip gives up, so the fixed arm is not a build that stopped saying anything.
- **The half of the fix that keeps the line is walked too.** A second pane that
  reaches the top mid-flight is refused its own request and says it is waiting
  all the same: two heads, one `CHATHISTORY BEFORE` on the wire, in both arms.

**What the head does as the page it named arrives is walked**, in
`docs/end-to-end-run-30.md` (2026-08-14). Run 26 could not: every answer in it
is held, which is what makes the state stable enough to photograph. Run 30 makes
the drop a delay — held past `ROUND_TRIP_TIMEOUT` and then sent, so the page
lands against a pane that has already given up on it.

The head's sentence goes and the rows land above the reader, and the anchor's
write on that commit is exact: `drawn 9381 - delta 136 = 9245`, and the pane
went to 9245. That is `scrollAnchor.ts`'s claim that the head's departure "needs
no term of its own" — watched rather than argued, on the one commit it is about,
where `headPx` is 0 against a `margin` of 24 that is a commit behind it.

**The reader is moved all the same**, by the fourteen commits of settling after
the write rather than by the write. #532, fixed by holding the anchor until the
rows stop measuring instead of for one commit; the same walk reads +0px on all
three runs after it. The pane is motionless either side — twelve readings at
zero on frames two seconds apart — so the distance belongs to the landing.

The frames read 22 to 46px and **the displacement is 11px of that**. A strip is
a row below the anchored one, and this channel is seeded so a landing page gives
some blocks a name they did not have; the rest of the distance is those rows
redrawing. Read the anchored row's own painted position if the number matters —
a screenshot cannot separate the two.

Worth knowing before repeating it: **a pane asks the moment it reaches the top
of its content, not when the wheel burst ends**, so the ask can precede the
first frame of a walk by ten seconds. Run 30's first set counted its waits from
that frame and photographed the same state twice, six walks out of six, reading
as a reader who never moved. The release carries an epoch now and the frames are
chosen against it afterwards.

**The pane beside the one that waited is walked**, in
`docs/end-to-end-run-31.md` (2026-08-15), which is run 30's late page under run
23's split. Ten landings on the build that ships, five of them past the timeout,
and the parked pane's message column is pixel for pixel what it was across every
one — while the same frames show the page arriving in it, the scrollbar's thumb
shortening and the spine changing beside every row. A probe build has that pane
taking the anchor's `moved` branch and writing ten thousand pixels of correction
of its own, exact, with no settling after it: **the stillness is work rather than
distance from the event.** Its `lag` is 0 where the asking pane's is −24, never
having had a head to lose (#516, from the inside).

Two things that run leaves open, and both are narrower than what it closed:

- **#535**, the one reading in ten that was not zero, in the pane that *did*
  ask: where the page merges the reader's top row into the group above it, the
  anchor puts the row back rather than the message, and the reader drops by what
  the row took in. Photographed at 84px.

  **Fixed and walked, 2026-08-15.** Run 31's own walk on a channel seeded to
  speak in runs of eight, so that the page boundary usually falls inside one
  rather than in a walk out of ten: `seed.py`'s speaker function with `n // 8`,
  and `parked.sh` at the in-time hold, which is where a reader sits against the
  top of their own content. Read from the records rather than the frames,
  because a strip is a row below the anchored one and a landing page changes
  what those rows draw — the same confound run 30 names, and it produced a
  −24px reading on a walk whose reader had not moved.

  The reader's own line is `delta + within` in a record, their row's place plus
  how far into it the line is drawn. Three walks a build, both panes read:

  ```text
                    control          fixed
  run1 left     89 → 105  +16px    89 → 89  +0px    the row took messages in
  run1 right   −47 → −31  +16px   −37 → −37 +0px    the row took messages in
  run2 left     12 →  28  +16px    12 → 12  +0px
  run3 left     89 → 105  +16px    89 → 89  +0px    the row took messages in
  ```

  The control is the same instrumented binary with the correction backed out and
  the measurement left in, so both arms compute the line the same way. **It also
  answers something run 31 could not:** the parked pane is displaced by this too
  — run 1's right pane is 16px on the control — and read 0px throughout run 31
  only because that seed's runs were too short for a merge to reach it.
- **A neighbour among the rows the arriving page re-groups.** The band a pane can
  be parked in and still be a neighbour starts 400px (`LOAD_OLDER_PX`) below the
  top of its content, and a wheel burst cannot be aimed into it: seven walks of
  ten put the pane at the top, where it asks for the page itself and the walk has
  no parked pane in it. Where a pane stops is not a function of how far it was
  wheeled — 700 notches left it on line 0253 of that seed, 750 on 0206, 850 on
  0217. Read `parked.png` and the ask's own timestamp before believing an
  arrangement, which is what run 31's `pick.py` does.

  **The band is wider than run 31 took it for, and the jsdom model reaches it.**
  A pane is only ever a message tall from the top of its content where a row is
  a message tall. A block of twenty lines is 400px of one row, so a reader
  sitting inside such a block is past `LOAD_OLDER_PX` and inside the row the
  page merges into at the same time — which is the whole of the band, and a
  channel talking in runs has it. `Timeline.layout.test.tsx` parks a second pane
  there and the reader was dropped 744px, by the block's own estimate-to-measured
  difference: the virtualiser compensates `scrollTop` in full for a row's first
  measurement wherever that row *starts* above the fold, the part of it drawn
  below the reader's line included, and a block that has just merged a page into
  itself is remounted under a new key and therefore measured for the first time.
  Fixed by holding the anchor until the reader's own row is a height the
  virtualiser knows, rather than until the container's height stands still.

  **What no walk has watched is still the release app.** The model is where the
  744px was read, and the model had to be corrected to read it — its
  `ResizeObserver` never delivered the entry a browser delivers on observing, so
  every row remounted under a new key kept its estimate. A walk of this wants a
  seed that speaks in runs of twenty or more, so that a pane can be parked inside
  one block and be a neighbour without being the asker.

## Resizing a split

`PaneTree.test.tsx` drives the divider with a mocked rectangle, because jsdom
lays nothing out. So every figure in those tests is one this file supplied.

**Dragged on 2026-08-03**, in Chrome through `driver.mjs` with real pointer
events — `docs/end-to-end-run-7.md`. Chrome rather than the window: this is a
question about layout and pointer geometry, and WebKitGTK has no selectors, so
every figure there would be eyeballed off a screenshot. The driver could not
drag at all before this; `click` calls `el.click()` and moves no pointer.

- **The divider could be hit, but not where it was drawn** (#368). `w-1` is a
  4px box and the rule was drawn at `left-0`, on its leading edge, so the entire
  target lay to one side of the line. At x=720: `718` and `719` did nothing,
  `720` dragged. Aiming at the rule and landing a pixel short pressed a pane,
  and half of every near miss falls short. The rule is centred in the target
  now — measured again after, it is drawn at 721.5 in a 720–724 box, so a press
  1.5px short of the line drags. Whether 4px is *enough* is still open; it is a
  measured ±2px rather than an unmeasured 4px.

- **A nested split holds.** Split side by side, split the right pane top and
  bottom, drag the outer divider 260px left: the outer went 50 → 23 and the
  inner kept its own 50, applying it to a span grown from 476 to 735. That is
  the tree doing what it was supposed to, watched rather than assumed.

- **The 15% floor did not do what a floor is for** (#367). At 760×640, dragged
  all the way in, the pane was about 114px and the roster inside it 157px on a
  `shrink-0` `<aside>` — so the roster was wider than the pane and won. The
  timeline was gone and what was left of the composer was its hint wrapped one
  word wide.

  **The roster gives way now.** `ChatPane` is a `@container` and the roster is
  `@max-[440px]:hidden`, so it answers to its own pane rather than to the
  window. 440 is measured: at 1200px a 323px pane wraps message text to one
  character a line, 403 wraps at word boundaries, 483 is comfortable — and the
  roster's ceiling is 208, so a pane wants 208 + 232 before it can hold both.
  Across the boundary: a 480px pane keeps its roster, a 410px pane drops it, and
  the pane opposite is untouched.

  **A pixel floor on the divider was built first and taken out again.** 440 on
  each side of the 960px a 1200px window has after the sidebar leaves 80px of
  travel; the divider moves ±40px and freezes below about 900px of window. The
  existing tests caught it — a drag to 70% came back 56%.

  **The floor that finishes it is `MIN_PANE_PX = 280`**, added once the roster
  drop had made it affordable. A share cannot say "wide enough to be a pane" on
  a window whose width it does not know, so `Divider` clamps against the span it
  already measures; the store's `MIN_SHARE` stays underneath as the backstop.

  Walked at 1200px: the divider stops with the pane at **283px, `aria-valuenow`
  29**, its roster dropped, message text wrapping at word boundaries and the
  composer's hint on one line. The far side stops at 677px and 71. So 29%–71%
  of travel, against the 44%–56% a 440px floor would have left — 440 being what
  a pane needs when it has to hold a roster too, which is exactly the case the
  roster drop removes. The two constants work together and neither would do on
  its own.

  A split too narrow for two floors gets an even one rather than a divider that
  will not move: that starts below a 560px split, narrower than the app opens
  at. The floor is a width, so a stacked split is not its business — a pane
  above another is short rather than narrow, and nobody has taken that
  measurement.

  **The floor clamps a drag and not a split**, which `docs/end-to-end-run-10.md`
  met in the assembled app: a third side-by-side split on a 1200px window gives
  240px panes, narrower than any drag would allow. Deliberate. Those panes read
  — the roster has dropped, the text wraps at word boundaries and the composer
  works — and refusing to split would leave somebody on a small window with one
  pane instead of two. The floor exists to stop a drag destroying a pane by
  degrees; a split makes an even, deliberate one.

  **Both rules were seen together in WebKitGTK** on the same run: at 480px a
  pane keeps its roster, at 240px it drops it and keeps its conversation. The
  browser walk set the threshold and measured the boundary; that run is the same
  rule in the engine that ships.

- **Not reached: touch.** Every event was `pointerType: "mouse"`. A coarse
  pointer wants a target several times this size and nothing has been asked
  about one.

- **Where a resize goes when the app closes.** Into `viewState.ts`, alongside
  the sidebar width, since #287. The tree is written down as the conversations
  its panes hold and read back after the opening snapshot, which is what knows
  whether a conversation is still there to come back to.

  **Walked on 2026-08-01**, against local `ergo`, reading the record out of
  WebKit's `localStorage` on either side of the quit rather than trusting the
  screen for both halves. `ircx.shell.view` is UTF-16 in
  `~/.local/share/chat.ircx.app/localstorage/`.

  **An uneven share comes back.** Dragged to the stop, which is the useful place
  to drag it: `MIN_SHARE` is `0.15`, so the stored `0.85` is a figure the run
  can predict rather than eyeball. It came back at `0.85` and read as the same
  window.

  **A console pane comes back on the protocol log.** `raw` is a flag beside the
  target rather than part of it, so it is the thing a restore would most easily
  drop. The pane returned reading `Nothing on the wire yet`, which is `RawLog`'s
  own empty state and not the server-message console.

  **Focus lands on the first pane in reading order**, as designed, and the
  person walking it did not remark on it. That is the whole of the evidence
  this note asked for.

  **A pane whose server is unreachable comes back too**, which was walked
  because the alternative would have been silent and permanent. With `ergo`
  stopped and `:6667` refusing, the split still opened on `#test2` — `0 members`,
  the roster saying `No members`, the status bar counting down to a reconnect.
  So `restoreLayout` keys on the conversations the client holds open rather than
  on live connection state. Had it pruned instead, the reduced layout would have
  been written back over the stored one and a split would be lost for good by
  nothing worse than starting up before the network did.

  Worth knowing before repeating any of this: **one window only.** Two instances
  share one `localStorage`, so whichever exits last writes its layout over the
  other's. A first attempt at this walk lost its own setup that way and read as
  a restore failure.

  An unread caveat rather than a finding: at the `0.15` end the console
  composer's `/join #channel` placeholder clips to `/join #char`. That is a
  narrow input behaving like one — it reads in full at an even split — and is
  not the fixed-width fault #114 was.

## Dragging the member list, and dragging the window

Two edges that could not be taken hold of. They ship together and only one of
them was walked.

**The member list, dragged on 2026-08-08** in Chrome through `driver.mjs`, the
same instrument and for the same reason as the split divider above: real pointer
events against a browser that lays the page out. Seeded, on `#ircx`, at the
1200×720 the driver opens at. The column measured **157.39px** before the drag —
the automatic width, which is `#ircx`'s longest nick plus the gutter — and
**267px** after a 110px drag leftwards, `aria-valuenow` reading `267` with it.
Exactly the 110 the pointer moved, less the rounding the store does on the way
in, so the width follows the pointer rather than trailing it; the timeline
reflowed into what was left. Dragged, reloaded and read back: the column came up
at 267 again, so it is the stored width the second run draws rather than the
names.

Not walked, and each is a real gap:

- **Whether the 4px handle can be hit.** #368 is the precedent — the pane
  divider could be hit but not where it was drawn, because a `w-1` box had its
  rule on the leading edge. This handle draws no rule at all, so there is no
  line to aim a pixel short of, but nobody has run `dragxy` across it to say
  what it catches. The drag above went through a selector, which lands dead
  centre and therefore cannot answer the question.
- **What it does to a pane already too narrow for both.** The roster hides below
  440px of pane and the handle hides with it, so the case should not arise. That
  is a reading of the classes, not a measurement.

**The window's own edges are unverified, and the harness cannot verify them.**
The window is `decorations: false`, so until now its only sizes were the one it
opened at and maximised; `WindowFrame` draws eight grips that call
`startResizeDragging`. On GTK that asks the window manager to take over the
resize — and `window.mjs` runs against `Xvfb` with no window manager on it, the
same absence this file already records for focus events. A run there would
photograph a window that does not move and prove nothing about the grips.

What wants doing on a real desktop, once: drag each of the four edges and each
of the four corners, confirm the top edge resizes rather than dragging the
window by the title bar underneath it, and confirm the bottom edge does not take
the status bar's controls with it. The permission it needs —
`core:window:allow-start-resize-dragging`, now in `capabilities/default.json` —
is checked at the call rather than at build time, so a grip that does nothing at
all is the shape that particular failure takes.

## Plugins

The failure modes are covered by `crates/ircx-plugin/tests/failure_modes.rs`,
which asserts that the host survives each one. What no test reaches:

- **The unresponsive backstop.** If a plugin's thread never comes back, the host
  stops waiting after the call deadline plus its grace, abandons the thread and
  carries on. Nothing in the current host surface can produce that: the only
  function that waits is `ircx.fetch`, and it is bounded by what is left of the
  same deadline. The path exists for the next host function that waits, and it
  is reachable only by making one misbehave.
- **A plugin's request crossing a real socket is covered** by
  `crates/ircx-core/tests/plugin_fetch.rs`, added 2026-08-03. The permission
  tests give the sandbox a fetcher that answers without a network and
  `ircx-net` has its own loopback tests; the seam between them is
  `network_for_plugins`, which turns a plugin's request into a `FetchPolicy`.

  What the seam carries that neither side can be asked about alone is the
  policy's default. A plugin gets `FetchPolicy::default()` with only the budget
  written over it, and that default refuses loopback, private and link-local
  addresses — so **a plugin granted `network-requests` for `127.0.0.1` still
  cannot reach the machine it is running on**, and the same for `192.168.0.1`.
  That was a security property resting on a struct literal. It is now asserted
  against a port something is really listening on, so a refusal cannot pass for
  the wrong reason.

  The success half dials `example.com` and is `#[ignore]`d like the other real-
  network probes: `cargo test -p ircx-core --test plugin_fetch -- --ignored`.
  The body comes back through the sandbox into the plugin's return value.

  **The budget against a slow socket is still unreachable**, and for the same
  reason the preview fetch is: the guard refuses every address a test can stand
  a server on, so a server that accepts and never answers is refused before it
  can fail to answer. A first draft asserted it anyway and passed in ten
  milliseconds — the shape of a test that proves the opposite of its name. The
  budget stays covered by `ircx-plugin`'s own tests, against a fetcher they can
  make slow.
- **Cancelling the folder picker is walked** on 2026-08-03, in the assembled app
  on `Xvfb`. Escape out of the native chooser and the sheet is exactly as it
  was: `Nothing installed`, no error drawn, `Plugins 0` in the status bar, and
  nothing under a blank name. `install()` returns on the `null` the picker gives
  for a dismissal, which is the branch #167 made the point of keeping separate
  from a rejection.

  **The sheet takes the keyboard back afterwards**, which is the part worth
  having watched: a native dialogue takes focus from the webview and there is no
  code anywhere that hands it back. Escape closed the sheet on the first press
  after the chooser had been and gone.
**The grant dialogue was read cold** by the owner on 2026-07-30, against a
plugin asking for all seven. The verdict was that the set adds up to a decision
somebody could make — with one line that did not carry its weight.

*Send messages as you* was too mild: it did not convey that other people cannot
tell the difference. It now reads *"Send messages under your nick, which nobody
else can tell from your own"*. The two that were checked hardest and held:
*"Show text in your conversations"* reads as what lets a plugin put its own
output on screen, and *"Work in the channels you choose, and no others"* reads
as the qualifier on reading and sending rather than as a capability of its own.

This is the only thing in the plugin system no test can answer, so it is worth
re-reading whenever a summary changes rather than treating it as settled for
good. `Permission::summary` is the one place the wording lives.
- **Picking a folder that is not a plugin is walked** the same day. A folder
  holding a `README.md` and nothing else, chosen through the native picker:

  ```text
  /home/syk/ircx/.claude/worktrees/export-walk/zznotaplugin holds no plugin.json,
  so there is no plugin in it to install
  ```

  Which is what #89 asked for — it names the file it went looking for rather
  than repeating the operating system — and the library is untouched behind it.

**The grant dialogue lost a typed scope** until #164. Naming one conversation
and pressing Save stored the manifest's `*` instead: the text reached the draft
only on Enter or Add, and Save read a draft that had never seen it. Found by
walking it on 2026-07-31, and by reading the grant back off disk rather than
trusting the screen — the dialogue said nothing either way. Worth remembering
that a scope is only checkable where it is stored.

**A grant reaching a live session is verified** on the same day. `/greet` and
`/roster` both answered in an open channel the moment their grants were saved,
with no reconnect, and revoking `add-commands` took the command back out of the
client — the route table is rebuilt on a runtime the session already holds, so
neither direction is a message anything could miss.

`/roster` also reported `no fetch (ircx: network-requests was not granted)`,
which is #93 seen from the other side: the refusal is an `Error` and a plugin
that degrades can say why it did.

## The coloured spine

**Walked by the owner on 2026-07-31 against local `ergo`**, over four rounds,
and every round changed the design. Nothing here was found by a test; the tests
passed at every step, including the steps that were wrong.

The last run, measured off the screenshot rather than read off it:

```text
203px  #be72d6   a group   walker's line, "walker: yup", walker's reply
 49px  neutral   "yes"
 95px  accent    "hey syk" — a mention in no group
 79px  neutral   "yo" / "hello syk_"
134px  #8389db   a group   "walker: hello", walker's reply
```

Two exchanges in two colours with neutral between them, which is the whole of
what the feature is for. `hello syk_` is correctly in no group: naming somebody
in passing is not addressing them, and it is the case where widening the rule
would have felt generous and been wrong.

### What the rounds found

**The rule broke once per author, and once per join.** Two separate causes. The
block gap is padding on the grid, so a spine started below it; and `buildRows`
reset the open group on a system run, so a channel with ordinary comings and
goings drew one group as four, each labelled again. The second is the model and
the rows disagreeing about how many groups exist, with nothing checking that
they agree.

**Guessed grouping went out.** Twenty messages between three people came back as
one group spanning the lot — a rule down the whole screen, distinguishing
nothing. Grouping separates conversations happening at once, and a channel where
everybody is in one conversation has nothing to separate. `groups.ts` says why
no threshold fixes it.

**An address was bounded by a clock, and missed by nine seconds.** Somebody
addressed a person sitting in the channel and it grouped nothing, because they
had last spoken fifteen minutes and nine seconds earlier. The bound is reach
now, not time.

**A mention outranked the group, and should not have.** A reply to you names
you, so the accent took the second block of every exchange the reader was in.
Measured on a screenshot: one exchange, two colours. The group keeps the spine
now, and the run above confirms a mention in no group is still unmistakable.

**Groups chained, and the chain is closed.** Answering somebody already in a
group put the answerer in it, so each fresh pair inherited the last pair's rule
and a run of people answering each other never closed. One round drew five
messages and two separate question-and-answers as one group. The note here
asked for it to be measured on a channel busier than three people first, and it
was: fifteen messages, nine people, four exchanges interleaved with two lines of
chatter, measured off the spine colours rather than read off the screen.

```text
before                                  after
#4598c9  nyx     is the mirror down     #4598c9  nyx     is the mirror down
#4598c9  jolt    nyx: back up           #4598c9  jolt    nyx: back up
#4598c9  nyx     jolt: thanks           #4598c9  nyx     jolt: thanks
#4598c9  marrow  morning all            neutral  marrow  morning all
#4598c9  kade    jolt: news on build    #a97cd9  kade    jolt: news on build
#4598c9  jolt    kade: green            #a97cd9  jolt    kade: green
```

Six blocks in nyx's colour, saying two exchanges and an unrelated greeting were
one conversation. After, they are two exchanges in two colours with the
greeting neutral between them — the shape the last round called the whole of
what the feature is for. The other three exchanges were already separate and
stayed so; the count went from four groups to five, and the group of four
people became two groups of two.

An addressed group is now between the two people whose exchange opened it and
nobody else, which is what shuts the chain: whoever is turned away is not left
out for long, because the answer to them opens a group of their own. A message
the rule merely reached over is in the span without being in the pair, so it is
not a way in either. Declared groups are untouched and still take anybody who
joins the topic — that grade is a fact its author typed, not a guess off one
colon.

**The split is walked, and it does not stutter — but looking for it found
something else.** Somebody saying two things about two conversations in one
breath was never seen in the live rounds. It is easy to construct, and closing
the chain made it commoner, so it was walked on 2026-08-01: jolt answers kade
and then nyx, in two consecutive messages.

The stutter itself is mild. The run is broken in two and jolt's name and time
are drawn again, which costs one header line and reads as what it is — two
answers to two people. `rows.ts` already argues for that trade against hiding a
grouped message inside an ungrouped block, and the walk agrees with it. Nothing
was changed for it.

What the same fixture showed was worse, and had nothing to do with the split.
Ordering the two answers oldest-first drew

```text
#4598c9  nyx     mirror is down again
#a97cd9  kade    the build is broken too
#a97cd9  jolt    kade: fixed it, bad cache
#4598c9  jolt    nyx: mirror is back as well
```

— nyx's colour above and below kade's. One group as two stripes with somebody
else's between them, which reads as two things that share a hue rather than as
the one conversation it was claiming. `groups.ts` argues a group must be one
unbroken line, "and a line with a neutral block in the middle of it is two
rules"; a whole other group in the middle is the same fault, larger.

This was not the chain fix's doing. The answer reaches back to a message in no
group, so the pair rule never fires and the span-fill path is the one that was
always there. It is as old as the addressed grade and no round had provoked it.

Fixed by refusing to draw a group whose line another group already crosses. The
line is one line or it is nothing, so nyx and jolt's exchange goes unmarked and
kade's keeps its own:

```text
neutral  nyx     mirror is down again
#a97cd9  kade    the build is broken too
#a97cd9  jolt    kade: fixed it, bad cache
neutral  jolt    nyx: mirror is back as well
```

A declared message in the way is refused the same way now, where the line used
to be drawn broken around it on the grounds that the topic keeps its own group.
It still keeps it. What changed is that the weaker claim around it does not
form, which is about whether a line can be drawn rather than which grade
outranks.

**Declared grouping is walked in the application** on 2026-08-01, against local
`ergo` with a second client — the first time it has run anywhere but a fixture
and the preview harness. Both halves of the bracket, and both ends of the
window:

- **The bracket is stripped, on arrival and on your own line.** A topic that
  came from the server and one typed into the composer are different paths and
  both drop it. What is drawn is the group's name above the block, once.
- **The topic takes in what follows.** The next line, which typed no bracket,
  joined it — which is the whole point of naming one.
- **So does a reply from somebody else.** A second person answering into the
  topic joined it, in the opener's colour, with no second label. Declared
  outranks, and the hue stays with whoever named the thing.
- **It lets go.** After seven minutes' silence an unrelated line came back
  neutral rather than joining. This is the guard the ten-minute first draft got
  wrong, and nothing had walked the five-minute one.
- **The same name said again is drawn again.** A topic revived after the group
  let go is labelled and coloured as before.

What that last one does *not* show is whether it rejoined the original group or
opened a second with the same name: both were opened by the same person, so the
colour is the same either way. Telling them apart needs the revival to come
from somebody else, since a rejoin keeps the first opener's hue. `byName` is
unit tested for the same-run case; the across-a-gap case is inferred from the
code rather than seen.

### What crossing costs

**2026-08-03**, `src/components/timeline/groups.crossfire.test.ts`. Numbers in
`docs/measurements.md`; what they mean is here.

**Staged rather than captured, and the reason matters.** A live channel cannot
answer this: the thing being counted is how often two exchanges cross, and on a
staged channel that is whatever the generator was told to do. So the generator
is not asked how often — it is asked *what happens at a given density*, sweeping
the number of simultaneous conversations and reporting what survives. Where a
real channel sits on that curve is the part still missing, and the section above
says why it could not be collected.

Everything below is the shipped `assignGroups` over generated transcripts:
disjoint pairs talking only to each other, interleaved uniformly, each answer
addressed with `nick:`. Uniform interleaving spaces two conversations as evenly
as they can be spaced, so these are worst cases at each density rather than
expected values.

**Three findings, and the first two contradict what this document said.**

**1. A long exchange is not left unmarked. It is chopped.** At one conversation
alone, every exchange is one rule. Add a *single* second conversation and that
falls to 20%, at 1.94 rules per exchange — the average six-message exchange is
already drawn as two. Nothing goes completely unmarked at any density tested.

**2. The shortest exchanges do lose their rule**, which is what the open
question was really about. One message and one answer: 14% get no rule at two
simultaneous conversations, 25% at eight. At two conversations the reach rule is
provably not involved — asserted in the test, since nothing can be more than
three messages away when only one other conversation is interleaving — so
crossing took all of it.

**3. A quarter of messages are drawn inside somebody else's exchange**, and this
was not a known cost. A group's span runs from the answered message to the
answer and takes in everything between, which `groups.ts` argues for deliberately
— a rule with a gap in it is two rules. The price is that unrelated messages
caught in the span are drawn as part of an exchange they were not in: 12% of all
messages at two simultaneous conversations, 25% by six. That is a wrong rule
rather than a missing one, and it is the number worth arguing about.

**Which rule refuses changes with density**, which is why they are separated.
At two conversations, crossing refuses 18% of answers and reach 4%. By eight it
has inverted — reach 48%, crossing 12% — because at that density most answers
are already out of reach before crossing is ever consulted. Reading the crowded
end as a verdict on crossing would credit it with the reach rule's work.

### Still open

- **Whether anybody but us ever types one.** No other client reads a `[topic]`
  prefix, so the grade is only worth its weight if ircx users type brackets at
  each other. The mechanism is walked; the habit is not, and cannot be until
  there are two people using it.
- **What an unmarked exchange costs.** Measured 2026-08-03, and the framing
  above was wrong twice — see *What crossing costs* below. A long exchange is
  not left unmarked, it is chopped into about two rules by the very first
  conversation that crosses it; a two-message exchange does lose its rule
  outright, 13% of the time at two simultaneous conversations. And a quarter of
  messages end up drawn inside an exchange they were not in, which nothing had
  named as a cost at all.

  Still open: **how many conversations a real channel runs at once.** That is
  the one input the study cannot supply, and the attempt to capture it found
  Libera too quiet to carry the question — 3 messages in 3 minutes across eight
  channels holding 8,400 people, on a Monday evening. Two exchanges cannot cross
  at that rate.

## The annotator

**The session half is verified.** `crates/ircx-core/tests/ergo.rs` drives the
real stack against a local `ergo` and reads a note back:

```text
PASS  annotator: units: 22 °C
```

That covers install, grant, arrival, batch, the call and the event — everything
but the drawing. It also established that an annotator never sees your own
messages, which `docs/plugins.md` now records.

What is left is what a person has to look at, below.

**It runs in the assembled application**, walked by the owner on 2026-07-31
against local `ergo`. `examples/plugins/units` was installed through the folder
picker, granted, and a note appeared under a message somebody else had sent,
after the message rather than with it.

The walk found one defect, and it was in the dialogue rather than the
annotator: a conversation typed into the grant form and not added was dropped
on save, so a plugin narrowed to one channel was granted every one. #163, fixed
in #164 — nothing is granted now that was not confirmed.

Still not walked, and worth doing when there is reason to:

**A note survives a restart**, walked on 2026-07-31: the client was closed and
the conversation reopened, and the note came back with the message without the
annotator running again.

**A broken annotator is dropped and says so**, walked by the owner on
2026-07-31 against local `ergo`. An annotator that throws on every message was
installed through the folder picker and granted `#test`, and a second client
said five things. The first two produced nothing, the third produced this in
the network console, and the fourth and fifth produced nothing:

```text
The broken plugin failed 3 times in a row, so ircx stopped asking it to
annotate messages. Restart ircx to let it try again.
```

The archive holds exactly one copy of it, which is the property the strikes
exist for: a hook that fails on every message must not report as often as the
channel talks.

The sentence quoted above is what the client said on the day, and the last
clause of it is no longer what it says. Restarting was the only cure at the
time; installing the plugin again now clears the strikes, and the sentence says
that instead. The rest of the walk stands.

Asked whether the server console is where they would go if their notes had
quietly stopped a day later, the owner said it is the first place they would
look. That is the question the walk existed to answer, and it is the reason the
plugin sheet still says nothing about a dropped hook — the sheet would be a
second place to look for something already found in the first.

The walk found no defect in the client and one in the walk. The first attempt
had the owner say three things themselves and nothing happened, because an
annotator never sees your own messages: a line you send is handed back to the
caller rather than appended, so it never becomes an arrival. It is written down
twice — `docs/plugins.md` under what an annotator is not handed, and in
`ergo.rs` where the second client is introduced — and the instructions were
written without reading either. Anything walking an on-arrival hook needs a
second client.

**A broken rule is dropped and says the other sentence**, walked the same way
on 2026-07-31. A rule that throws was granted `#test` and given three messages
from a second client:

```text
The brokenrule plugin failed 3 times in a row, so ircx stopped asking it what
is worth interrupting you for. Restart ircx to let it try again.
```

**One plugin's broken hook does not cost it the other**, walked on 2026-07-31
and the first run to have it. A single plugin holding both hooks, its annotator
correct and its rule throwing, was granted `#test`, and a second client said
five things:

```text
walker  it is 72F outside     annotated 22 °C
walker  rule one
walker  rule two
client  The both plugin failed 3 times in a row, so ircx stopped asking it
        what is worth interrupting you for.
walker  and now it is 61F     annotated 16 °C
```

The rule died on the third batch it was handed and the annotator answered
after it, which is what `one_hooks_failures_are_not_the_others` asserts and
what no run had shown. Worth reading the order: the first message was handed to
both hooks, so the drop lands one message earlier than counting only the ones
that look like rule traffic would suggest.

## One conversation, one name

**Verified in the application** on 2026-07-31, on the archive that produced the
bug. The NickServ query came back with its backlog — the 118 notices that had
been filed under `NickServ` while the open query was `nickserv` — without a
migration, because the archive is read without case. `#test` and `#wtf` read
normally afterwards, which is what the folded timeline key had to not break.

This one was worth walking because two of the three layers only matter for data
already written: a fix tested on a fresh archive would have passed while the
reporter's own history stayed invisible.

## Uploading to a provider

**Walked** on 2026-07-31 against a local file host that stores on `PUT` and
serves back on `GET`, configured as `http://127.0.0.1:8080/{name}` with no
credential. A screenshot dropped on the window was confirmed, uploaded, and its
link posted to the channel; clicking `fetch` on the attachment line drew the
image.

Confirmed from the host's log rather than from the client's own report:

```text
PUT  /f774cf144201d5e3-Screenshot_20260731_103915.png  167850 bytes  type=image/png
GET  /f774cf144201d5e3-Screenshot_20260731_103915.png  167850 bytes
```

That covers the drop event in the real window, the confirmation, the object
name, the content type, the request, the link, the message, and the preview
reading back what had just been written — the whole loop. Two uploads produced
two names, and the byte counts match the stored files, so nothing was truncated
or re-encoded on the way.

Worth noting what the walk depended on: a plain-HTTP local address, which an
upload allows and a preview fetch refuses. The asymmetry is deliberate and this
is the case it exists for.

**The credential is walked too**, on 2026-07-31, against the same host with
`EXPECT_TOKEN` set. Both directions, from the host's log:

```text
PUT  /0142f8f2c577dbf9-Screenshot…png  168368 bytes  type=image/png  auth=Bearer walkme
PUT  /bde6fc7208bb041c-Screenshot…png  REFUSED 401   auth='Bearer walkme,'
```

The token is read from the keyring at the moment of the upload and arrives
byte-exact — the second line is a token edited to be wrong, and the edit
survived the trip, which is the same evidence in the other direction.

The walk found one defect, in the words rather than the mechanism: a refused
upload reported `returned HTTP 401 — open it in your browser to see what it
says`. `HttpError` is shared with the preview fetch, and that advice is good
about a link somebody posted and useless about an upload, because a browser
sends a `GET`. Fixed to name the credential and where to change it.

**Not walked:**
- **A file too large, or a provider that refuses.** Both produce sentences no
  one has read in situ.
**S3-compatible storage is walked**, against MinIO in a container on
2026-07-31. `src-tauri/src/upload.rs` holds the run as an ignored test, with
the command to stand the server up:

```text
PASS  bucket: HTTP 200
PASS  object: HTTP 200 at http://127.0.0.1:9000/ircx-walk/a1b2c3d4e5f60718-walk.png
NOTE  the link is private: … returned HTTP 403
```

Creating the bucket is itself a signed `PUT`, so the first line is the
signature working against a real server rather than against Amazon's worked
example. The bytes were read back out of MinIO's own storage on disk — `the
bytes ircx put there`, byte for byte — rather than over HTTP, because HTTP is
where the walk found something.

**The walk found that a successful upload hands back a dead link.** A bucket is
private until somebody makes it otherwise, so the object stored, the client
sent the address to the conversation, and it opened for nobody. Silent, and the
sender would have learned it from whoever they sent it to.

An upload now asks the address what it answers — a `HEAD`, because the file may
be 25 MB and the question is only what the server says — and a refusal stops
the link being sent. The reader is told what happened, shown the address in
full, and offered the send anyway: a provider can serve a link it refuses a
`HEAD` for, and being wrong about that should not silently swallow their file.

Three ways to make it public were weighed. `x-amz-acl: public-read` was refused:
it works on MinIO and older AWS and fails outright with a 400 on current AWS,
where ACLs are off by default — trading a dead link for a failed upload on the
provider most people have.

**A public bucket is walked too**, and it is the path the feature exists for:

```text
PASS  policy: HTTP 204
PASS  the client would send this link
PASS  read back 25 bytes anonymously
```

Making the bucket readable is a signed `PUT` carrying `?policy=`, which no
other request here sends — so it is also the only cover the canonical query
string has. Then the client asks its own question about the address, gets no
warning, and the object reads back byte for byte with no credential at all.

**Still not walked:**
- **AWS itself.** MinIO accepts any region and signs with what it is told.
  Whether the region a real provider expects is the one its console displays is
  the next thing likely to be wrong.
- **A provider that refuses `HEAD`.** It would read as a dead link and offer
  the send anyway, which is the right shape, but nothing has produced one.

### The secret the sheet said was saved

**Walked** on 2026-08-08, in the window, on a profile holding an S3 provider and
a keyring holding nothing for it — which is the state a user reported, and the
one no test had because every fixture saved a secret along with the provider.

The sheet drew `Saved in your system keyring` under an empty field, because it
was answering "is a provider stored" and being read as "is a secret stored".
Saving from there succeeded and the first upload failed with *The provider signs
with an S3 secret key and none is saved*, which was true and arrived a day late.

Four screens, in order: the field now reads `Stored in your operating system's
keyring, never in the database` on a provider that has none; `Save` is refused
with *A secret access key is needed: it is what signs the request, and none is
saved*, from the command rather than the form; typing one and saving closes the
sheet, and reopening it says `Saved in your system keyring. Leave empty to keep
it` — the same sentence, now with something behind it. Switching the kind to a
header afterwards refuses again, naming what is saved: *The saved credential is
an S3 secret access key, which is not a bearer token.* The two kinds share one
keyring slot and nothing else, so an empty field on a changed kind used to hand
a bearer token to the signer.

**The keyring itself is the other half.** With `linux-native` alone, the store
was the kernel's keyutils, which a reboot wipes — every SASL password and the
upload secret, with both sheets still saying they were saved. Now, after saving
through the sheet:

```text
$ secret-tool lookup service ircx username upload-provider
walksecret
```

That is the Secret Service, which is where a desktop session keeps credentials
and what survives the reboot. keyutils stays in front of it as the cache.

**Not walked:**
- **The reboot.** Read back within the session it was written in, so what is
  proven is where it landed rather than what a cold boot finds there.
- **A machine with no Secret Service.** Saving a password now fails there where
  it used to succeed and lose it later. The sentence it fails with — *the system
  keyring would not answer* — has been read by nobody.
- **The secrets already in keyutils.** They are read from the cache and never
  promoted, so the passwords saved before this change are typed once more after
  the next reboot and persistent from then on.

### A host that asks for no account

**Walked** on 2026-08-08, against four public hosts, because the question was
not which one to configure but whether this client could describe any of them.
It could not, and the reason is the finding: ircx sends the file as the whole
request body, which is what storage and self-hosted boxes take and what no
public host takes. They want `multipart/form-data`.

What each one did with the request ircx actually sends:

| host | shape it takes | what happened |
|---|---|---|
| filebin.net | the body | uploads, `201`, and the link opens in a browser |
| temp.sh | a form | landing page, download behind a button |
| 0x0.st, transfer.sh, oshi.at, bashupload.com | a form, mostly | unreachable from here — no TCP, both stacks |
| litter.catbox.moe | a form | `200`, and the reply is the link |

**filebin was configured and walked in the window before it was dropped**, and
it is worth writing down because the upload was never the problem. The file
arrived, the client's `HEAD` came back `200`, the link went to the channel, and
clicking `fetch` on the attachment line said:

```text
https://filebin.net/…/a7f3c1d90e5b2648-upload-test.png is text/html,
not an image — open it in your browser
```

Which is true. filebin serves its own landing page to `User-Agent: ircx/…` and
gives curl a `302` to the bytes. It is not content negotiation — the preview's
own `Accept: image/png, image/jpeg, image/gif, image/webp` changes nothing — so
there is no configuration that fixes it. A host that will not hand a
non-browser the file cannot be previewed by a client, and the sentence the
attachment line prints is the right one to print.

**litterbox is the one that works**, and the loop is covered by an ignored test
against the real service rather than by a mock:

```text
$ cargo test -p ircx --lib litterbox -- --ignored --nocapture
PASS  HTTP 200
PASS  link https://litter.catbox.moe/lqzxyq.png
PASS  the preview would draw it
```

The last line asks the link the question the attachment line asks, with the
preview's own `Accept`, and gets `image/png` back byte for byte. That is the
difference between the two hosts, stated as a test that will notice if it
changes.

**The walk found a defect that no local server would have.** litterbox frames
its reply, and `upload` read the body without asking whether it was chunked —
unlike `fetch` beside it in the same file. So the link came back as

```text
24\r\nhttps://litter.catbox.moe/4hlzia.png\r\n0
```

which is not a URL, so `link_from` fell back to the request URL and the client
would have posted **the API endpoint** into the conversation. Chunked replies
are ordinary; every loopback test in `http_upload.rs` had sent a
`Content-Length` and none had caught it. Fixed in `ircx-net`, with a loopback
test that scripts the framing.

**Not walked:**
- **The drop itself.** `onFileDrop` needs a real drag onto the window and the
  harness cannot synthesize one — `window.mjs` clicks coordinates and types, and
  neither is a drag-and-drop from a file manager. Everything downstream of the
  drop is covered; the drop event reaching the confirmation is not.
- **catbox proper and the 0x0.st family.** The same shape as litterbox, and the
  field names are in the sheet's hint, but only litterbox has been sent a file.
- **A form host that wants a credential.** The two are orthogonal in the code
  and nothing has exercised the combination.

## SCRAM

**SCRAM-SHA-256 can be walked locally; SCRAM-SHA-512 needs Libera.** `ergo`
advertises

```text
sasl=PLAIN,EXTERNAL,SCRAM-SHA-256
```

and Libera advertises `SCRAM-SHA-512` (the capability list in
`tests/session.rs` is a real capture from #43). So the local walk is SHA-256
against `ergo` with a registered account, and SHA-512 has no server here to
answer it.

SHA-512 shipped first and for a long time there was nowhere to run it. Its own
tests are strong — the SHA-256 half is checked against RFC 7677's published
vectors, and the exchange, the nonce check and the signature check are shared —
but until 2026-08-01 no server had answered a SHA-512 exchange this client sent.

**SCRAM-SHA-512 is walked**, that day, against `irc.libera.chat` over TLS 1.3
with a registered account, and the whole exchange is captured. Libera still
advertises it, which this file previously claimed on a capture from #43:

```text
CAP * LS :... sasl=ECDSA-NIST256P-CHALLENGE,EXTERNAL,PLAIN,SCRAM-SHA-512 ...
```

Note what is *not* in that list. **Libera does not advertise SCRAM-SHA-256**, so
the SHA-256 walk is ergo's alone and cannot be repeated here. A client
configured for SHA-256 against Libera gets the quiet path this section warns
about: a connection that succeeds and a login that does not happen.

The four-message exchange, with the outgoing payloads redacted by the raw log
as designed and the server's own halves intact:

```text
>> AUTHENTICATE <credentials>
<< AUTHENTICATE +
>> AUTHENTICATE <credentials>
<< AUTHENTICATE r=d0By4OZJiyzO5d1W5sWEI49Nb5AJ444ixOBqnpjFUe9aBHiKTmaJuz9hkfISvlJeB7CTzV930qGWSBJJ8WheFe8d,s=JrlFTroexJQRJ1aFnAz52Vzv5we/NC49YOqPGeUs6eU=,i=10000
>> AUTHENTICATE <credentials>
<< AUTHENTICATE v=0SIGHcA2N/SXCXgUDcnnK6Yg1/R2B1bvbNglKF3Ii59l6lQBSMJ9oSKrEGtOs9QmnmKX5bKkSpsUiDW8EOVmBA==
>> AUTHENTICATE +
<< :molybdenum.libera.chat 900 syk syk!syk@user/brandn brandn :You are now logged in as brandn
<< :molybdenum.libera.chat 903 syk :SASL authentication successful
```

A real salt and iteration count, and `v=` — the server proving it knew the
password — verified by the client before it accepted the login. Then `900` and
`903` from Libera, which is the server saying it, not ircx. `/whois` on the
session answered `330` as well.

**A mechanism the server does not offer is walked**, the same day, against
Libera. This section has warned about it from the start — *picking a mechanism
the server does not offer connects successfully and does not log you in* — and
a unit test pinned it, but no real network had done it. Configured for
SCRAM-SHA-256, which Libera does not advertise, the client:

- did not send `AUTHENTICATE` at all, having checked the advertised list first
- said `Libera.Chat does not accept SASL SCRAM-SHA-256` in the server console
- connected anyway, because a missing mechanism is not an authentication failure
- left `/whois` with no `330`

Which is the behaviour wanted, and still the trap the section says it is: a
connection that looks entirely successful, and a login that did not happen. The
only thing saying so is one console line and a status indicator reading `not
signed in`.

**And on 2026-08-03 the trap closed on the person who built it** (#390). The
same configuration — Libera, `SCRAM-SHA-256`, which it still does not advertise;
a `CAP LS` probe that hour returned
`sasl=ECDSA-NIST256P-CHALLENGE,EXTERNAL,PLAIN,SCRAM-SHA-512`. The console holds
both halves:

```text
21:22:15  Libera.Chat does not accept SASL SCRAM-SHA-256
21:22:56  syk is logged in as brandn
```

Between them he identified to NickServ by hand, Libera answered `900
RPL_LOGGEDIN`, and `session.rs` sets `SaslStatus::Authenticated` from that
numeric whether or not SASL was ever attempted. The indicator went green, the
console line scrolled away, and he reported being "connected via SCRAM-SHA-256".
He was not, and nothing on screen still said so.

So the two sentences above — *the only thing saying so is one console line and a
status indicator* — are both perishable. The console line scrolls. The indicator
is overwritten by any later login. What the trap needs is something that
outlives both, and #390 is where that decision lives.

**The same session then showed what the real thing looks like**, which is the
useful half of the comparison. The network was set to `SCRAM-SHA-512` — which
Libera does advertise — and reconnected at 21:25:14. Three differences, all
readable without trusting the indicator:

```text
console      no "does not accept SASL" line for this connection
conversation SaslServ, which speaks only during a SASL exchange:
             "Last login from: ~syk@… on Aug 03 21:24:53 2026 +0000."
status bar   "Authenticated as brandn"
```

No NickServ traffic after the connect at all. So `SaslServ` appearing is the
positive evidence a reader can use: the account line and the green indicator are
produced by either route, and only the SASL one brings a service that talks to
you about it.

That is also SCRAM-SHA-512 confirmed against Libera on today's build, through
the assembled app rather than the scripted walk that first established it.

**It also settles what the earlier connection was not.** That session reported
SHA-256 and `/whois` showed `330`. It cannot have been configured for
SCRAM-SHA-256, because that configuration produces exactly the run above and
leaves nobody logged in. What it actually used is unidentified — `PLAIN` is the
only advertised mechanism that fits — and it is recorded as unidentified rather
than guessed.

**SCRAM-SHA-256 is walked**, on 2026-07-31, against local `ergo` with a
registered account. The whole exchange ran against a real server: a real salt
and iteration count, and the server's signature verifying. Confirmed from
`ergo`'s side rather than from the client's own report —

```text
:ergo.test 330 whoisprobe syk syk :is logged in as
```

— because the client saying it authenticated is the thing under test.

**The failure paths are walked**, on 2026-08-01 against local `ergo` with a
registered account, in two halves.

*A wrong password* does not fail at the signature after all. The client sends
its client-final with a proof the server cannot match, and `ergo` answers `904
challenge proof invalid` — the same numeric PLAIN gets, through the same code.
The window said `127.0.0.1 rejected the account scramtest — challenge proof
invalid. Check the account name and password in this network's settings.`,
registration was abandoned, and the status bar read `not signed in`. That is
the behaviour wanted, and it means the interesting path is the other one.

*A server that cannot prove itself* was walked with a proxy on 6669 that
replaces the `v=` in the server's final message with 32 zero bytes — what a
server that does not know the password would have to send. It found the defect
this section was written to look for. The client aborted correctly, and then
said:

```text
127.0.0.1 rejected the account scramtest — the server could not prove it knew
the password, so the account was not signed in and something is answering for
it. Check the account name and password in this network's settings.
```

Wrong twice in one sentence. The server rejected nothing — ircx is the side
that walked away — and no password fixes a server answering for somebody else,
so the one failure worth reading carefully ends by sending the reader to the
password field. `ScramError`'s own `Display` says three of its five variants
are the server's fault "because a user checking their password over a nonce
mismatch is looking in the wrong place", and then `sasl_refused` appended that
instruction to all of them. Fixed in #255: the four server-side variants get a
sentence of their own —

```text
ircx stopped signing in to 127.0.0.1 as scramtest: the server could not prove
it knew the password, so the account was not signed in and something is
answering for it. The password is not what is wrong here — check the address
and port this network points at.
```

**Three of these walks are scripted**, on 2026-08-03, in
`crates/ircx-core/tests/scram_ergo.rs`: the SHA-256 exchange, the wrong
password, and the mechanism ergo does not offer. They assert what the walks
above found rather than finding anything — the point is that a change to
`scram.rs` can be put back in front of a real server in two seconds instead of
being walked by hand again.

```text
ergo run --conf ircd.yaml &
# once, as nick `scramwalk`: /msg NickServ REGISTER correct-horse-battery
cargo test -p ircx-core --test scram_ergo -- --ignored --nocapture
```

The third is the one worth having as an assertion rather than prose. A mechanism
the server does not offer connects unauthenticated, a `904` abandons
registration, and the difference between them is a decision rather than an
accident — the kind that is quietly reversed by somebody tidying an error path.

**Not walked**:

**The redrawn connection-failure screen is walked against a live refusal** on
2026-08-01, against local `ergo` with the `scramtest` account and a deliberately
wrong password. The wrong-password walk that opened all this drew the same
sentence three times and headed it `Could not connect`, which was not what
happened. What it draws now:

```text
● green   Connected to localhost:6667
● red     Authentication failed
● grey    Joined 0 of 1 channels

localhost rejected the account scramtest — challenge proof invalid. Check the
account name and password in this network's settings.

[Edit settings]  [Try again]
```

The step that worked says so, the failure says what failed without repeating
itself, and the sentence appears once. Read by the owner rather than asserted:
the three lines land as one explanation — what worked, what did not, why, and
what to do about it.

**The walk found one thing no test could see.** The join step was amber, the
colour of something in progress, sitting under two lines saying the connection
was over. `Joined 0 of 1 channels` reads identically whether the join is still
coming or never will, so the colour was the only thing distinguishing them and
it was saying the wrong one. Fixed in the same change: a failed connection
greys that step. Confirmed on the same screen afterwards.

Worth keeping for whoever repeats this: **the password field cannot be typed
into.** It shows `Saved in your system keyring` with a `Replace password`
control beside it, and the person doing this walk read the screen as offering
no way to enter a wrong password at all. The hint under the field explains why
ircx cannot read one back. The control is there; it did not read as one.

Also worth knowing, and the reason this section exists: **picking a mechanism the
server does not offer connects successfully and does not log you in.** The
client says `<network> does not accept SASL <mechanism>` in the server tab and
carries on, because a missing capability is not an authentication failure. It is
easy to read the successful connection as a successful login;
`a_mechanism_the_server_does_not_offer_says_so_and_connects_anyway` pins the
behaviour, but nothing makes it loud.

## The notification rule

**The session half is verified.** `crates/ircx-core/tests/ergo.rs` drives the
real stack against a local `ergo` with `examples/plugins/deploys` installed and
granted, under a third client whose nick is `buildbot`:

```text
PASS  rule: deploys raised phxy5sykgp5tx43gk98nb44wrw
PASS  rule: the channel went loud: 1
PASS  rule: the build starting was left alone
```

That covers install, grant, arrival, the batch, the call, the archive, the
event and the count — every layer but the drawing, which is not built.

Not walked in the application, and the list is short because there is little to
look at yet:

**It runs in the assembled application**, walked by the owner on 2026-07-31
against local `ergo`. `examples/plugins/deploys` was installed through the
folder picker and granted, a second client spoke as `buildbot`, and of its two
lines the one saying a deploy failed was marked and the one saying a build
started was not. The badge went loud and the run took the accent.

The walk found one defect, and it was the mark rather than the mechanism:
`raised by deploys` was faint text under the message and read as trailing
debris — "not visible enough". A mention was never carried by one thing: it
tints the row, marks the word with an `--accent-muted` chip *and* says why above
the run. A raise had one of the three, in grey. It now tints the raised row and
leads it with the same chip, and only the raised row — the line beside it from
the same sender stays plain.

Worth keeping in mind for the next mark: this is the second time a quiet mark
had to be made louder after a person looked at it, the first being the link
arrow in #172. A mark that is obvious to whoever built it is not evidence.

**A broken rule being dropped** is walked, under the annotator's section above,
along with one plugin holding both hooks and only one of them broken.

**A dropped hook coming back is walked twice**, by different means, and the
first run is the one that carries the claim.

**By the owner on 2026-07-31**, on one connection that was never restarted:

```text
21:05:10  dropped               a plugin that throws, three messages
21:06     installed and granted through the sheet
21:07:53  dropped a second time still the broken code, three more messages
21:08     installed and granted  the code now fixed
21:09:37  it is 72F outside      revive: 22 °C
```

The second drop is what carries it. A working plugin answering could be
explained by almost anything — a fresh runtime, a reconnect, a coincidence of
timing. A hook reporting *twice* cannot: a struck-out hook is filtered out
before it is called, so it can never fail again and never report again. Seeing
the same plugin drop a second time on the same connection means the count was
cleared between the two, which is the only thing the change claims.

**As a step in `crates/ircx-core/tests/ergo.rs` on 2026-08-01**, so it runs
again without anybody watching. A plugin written to throw is installed and
granted, a second client says three things, and the hook is dropped into the
server console:

```text
The flaky plugin failed 3 times in a row, so ircx stopped asking it to annotate
messages. Install it again from Plugins once it is fixed.
```

Repaired, installed over — the same call the sheet makes — and told the network
it changed, it answers on the next message without a restart. **Checked against
a build with the clearing taken out**, which is the only reason a passing step
is worth anything: it failed there, with `the repaired plugin was never asked
again — the strikes outlived the install`.

**And in the assembled application again on 2026-08-01**, because the ergo step
sends `PluginChanged` itself and the sheet is what sends it in the client.
Installed through the folder picker, granted, three messages three seconds
apart, dropped; then a repaired build installed over it, granted again, and the
next message came back annotated. So the whole path is joined: the click, the
grant, the strikes, the drop, the repair and the return.

Three things worth knowing before running this again.

**Give the walker a path a file picker can reach.** The instructions named a
folder under the session scratchpad; the owner copied it somewhere pickable and
installed from there, so the repair went to a folder nobody was using and the
broken code was installed a second time. That is where the second drop came
from, and it is the only reason that walk had the evidence it did — a mistake
worth more than the run it interrupted.

**Reinstalling is two steps and the walk needs both.** Installing over a plugin
resets its grants, so the plugin comes back ungranted and does nothing until it
is granted again. A walk that stops after the install sees no note and reads it
as a failure to revive — and nothing on the screen tells that apart from strikes
that outlived the install, except whether the sheet shows the channel granted.

**Space the messages.** A strike is counted per batch of arrivals, so three
lines said at once count once and the hook never drops.

## The topic of a channel you have joined

**Verified in the application** on 2026-07-31. A second client set the topic on
a channel it owned; joining it drew both lines, in order:

```text
The topic of #topictest is: read the FAQ before asking, and mind the bots
Set by phrack on 2026-07-31 at 13:54 UTC
```

The nick rather than a mask is deliberate: `crates/ircx-core/tests/ergo.rs`
caught this printing `phrack!~u@f6u3beryjfghu.irc` earlier the same day, because
ergo sends the whole mask in `333` where Libera sends a bare nick.

**Changing it is verified too**, on 2026-08-02, and by a test rather than a
watch: `a_topic_typed_here_comes_back_changed` in the same file types `/topic`
and reads back what the server says.

```text
PASS  topic changed here: ircx-drive set the topic of #ircx-topic to mind the bots
PASS  topic held on the channel: mind the bots (set by ircx-drive)
PASS  topic refused: That needs channel operator status in #ircx-drive
```

Two things it settled that were guesses beforehand.

**Joining and changing are different code paths, and only one had been seen.**
A `332` on join lands in `on_topic` and reads *The topic of X is: …*; a change
reads the server's own `TOPIC` back and lands in `handle_topic`, which names who
did it. Asserting on the topic text alone would have passed on either, so the
assertion is on the wording as well.

**Every channel ergo makes is `+t`.** The first attempt at this typed `/topic`
in the channel the run already used, where the client is not an operator, and
the server answered `482` — so nothing came back and the step read as the change
never arriving. It is the same shape that made the first two attempts at the
lock icon measure the wrong thing. The test now opens its own channel for the
case where the server says yes, and keeps the `482` as a claim of its own:
`numeric.rs` turns it into *That needs channel operator status in #ircx-drive*,
so a topic somebody may not set says why instead of doing nothing.

## Opening a link

Every URL a message carries now leaves through the system opener rather than
through an anchor: the inline link and the attachment line both call
`openExternal`, and neither renders an `href`. The tests assert that no `href`
exists to navigate and that the opener was asked, which is as far as jsdom
reaches.

**A link opens**, walked on 2026-07-31. It did not before that day, and the
reason is worth keeping: `opener:allow-open-url` permits calling the command
while `opener:allow-default-urls` is the scope that permits `http://` and
`https://`. The window had the first and not the second, so every call was
allowed and every URL refused, and the refusal was swallowed by a `.catch` that
discarded it. #167.

**Not verified:** anything about how it reads. The mark that a link leaves the
client took three attempts — 10px text, 11px text, then a drawn icon — because
whether a reader notices it is not something a test can answer. The pointer
affordance came out of the same walk: a link inherited `cursor: default` from
the chrome-less window and so looked like text.

## A tooltip against the window it is in

`edgeShift` is unit tested, but what it is worth depends on a browser: jsdom
returns zeros from `getBoundingClientRect`, so nothing in vitest can see a box
wrap, take a width, or land where it was put.

**Walked in a real browser** on 2026-08-01, in a 1200px window, against the
nineteen capabilities Libera actually negotiates. Before #258 the box ran

```text
{"width":1404,"left":318,"right":1723,"offRight":523}
```

— cut mid-word at `multi-p…`, with seven capabilities unreadable. After it:

```text
{"width":320,"height":89,"left":861,"right":1181,"offLeft":0,"offRight":0}
```

Four wrapped lines ending in `userhost-in-names`, inside the window on both
sides. Opened, closed and reopened to check the offset is measured from centre
each time rather than accumulating: identical geometry on the second open.

**That run proved less than it read like, and the reason is the point of this
section.** The capability list fits at 320px wherever it is centred, so the
width cap alone accounted for every number above and the clamp never ran. It
could not have run: Tailwind's translate utility sets the `translate` property
and #258 wrote `transform`, so the two composed instead of replacing, and a box
that needed moving moved twice. A left-anchored tooltip came out at

```text
{"left":-152,"right":168,"width":320,"offLeft":152}
```

— further off the edge than centring alone would have put it. Found in #260 by
walking the edge the earlier run had recorded as not walked, which is the only
reason it was found at all. A green measurement of the case that does not
exercise the mechanism is not evidence about the mechanism.

**Both edges are walked** on 2026-08-01, after #260 moved centring into the
same write as the offset. The status bar's failure summary is anchored 28px
from the left, and its sentence is long enough to need the clamp:

```text
{"left":8,"right":328,"width":320,"height":89,"offLeft":0,"offRight":0}
```

Five wrapped lines, whole, held at the 8px margin. The capability list on the
right is unchanged at `{"left":861,"right":1181}`, and reopening still gives
identical geometry.

**The vertical edge is walked** on 2026-08-01, and the answer is that there is
no clamp on it and nothing this application can say reaches it.

There is no clamp: a 1328-character label in a 393px viewport came out 402px
tall at `{"top":-37}`, its first two lines above the window, unreadable.

Nothing reaches it. The tallest label the app can produce is around 300
characters, which wraps to 89px:

```text
capability list, 19 caps    288 chars   h 89   top 277
the SCRAM refusal sentence  252 chars   h 89   top 277
```

Both measured against the bottom of a **393px** viewport — shorter than the
app permits itself, because `tauri.conf.json` sets `minHeight` to 480. The box
would have to be four times taller to reach the top, which is roughly 1200
characters, and each caller is bounded well under that:

- The status bar and the title bar carry sentences core writes, and the longest
  found is the SCRAM refusal above.
- A capability list is bounded by what a server advertises. Libera advertises
  19; there are not enough ratified and draft capabilities in IRCv3 to reach
  four times that.
- Reaction names are capped in `reactorNames` at `NAMES_SHOWN` and a count —
  twelve names and `and 48 more` for sixty reactors, which measured 39px. This
  was the case expected to fail, on a reaction near the top of the timeline,
  and the cap is why it does not.

So the missing clamp is not a defect to fix; it is a case no label can provoke.
That holds only while those bounds do. A caller that puts an unbounded string
in a tooltip — a filesystem error with a path in it, a server's own text
passed through — reintroduces it, and this is the note that says so.

**Not walked:**

- **A window narrow enough for the `100vw` cap to bind.** The width falls back
  from 20rem below a 336px window. The narrowest run was 720px, and
  `minWidth` is 720, so the app cannot be made to reach it either.

## Density

Chosen in the palette and remembered in `localStorage`, verified that far on
2026-07-31: `ircx.density` read back as `read` after a restart, alongside
`ircx.theme`. What is left is a matter of looking rather than of mechanism.

- **Compact against a long backlog.** Two rounds of looking so far: 1.45
  leading with an 8px gap read as too tight, and 1.55 with 10px read as barely
  different from comfortable. The gap moved to 6px on the second reading, which
  keeps the line spacing and buys the density from between the blocks.

  Worth knowing before judging it again: leading only shows where messages
  wrap, so a channel of short one-liners is the worst place to tell the
  densities apart. On a 600px pane the shipped values put 27% more one-line
  messages on screen than comfortable.

  **`read` has now been looked at against a long backlog**, on 2026-08-01, along
  with the other two: a channel of 240 messages from four people, driven against
  a local ergo. What was being judged was the spacing #232 changed — the spine's
  28px gap and the 20px a rule carries — and all three hold. Compact is the
  tightest and the spine is still clearly off the prose; read is the most open
  and the gap stays proportionate rather than becoming a margin.

  One thing to look at next time: in `read` the rule gap and the block gap are
  both 20px, so a rule has less to distinguish it from the blocks around it than
  it does in compact, where the block gap is 6px. No rule happened to be on
  screen during this run, so it is an observation about the numbers rather than
  about anything seen.
- **Changing theme while on a density that is not comfortable** is **half seen**
  now, on 2026-08-02. The implementation is built around this case — theme and
  density write the same three properties to the same inline declaration — and
  `apply.test.ts` covered it without anybody watching it happen.

  What the running window showed: the owner changed density and then theme, and
  the light theme came up and the client kept working. What it did not show is
  the part worth checking, because the run was confounded by something else on
  screen at the time (below) and nobody read the density off it.

  So the assertion was driven in the browser harness instead, which is a weaker
  place to see it than a real window: the sheet reads `Compact · in use`
  alongside the light theme, the page background comes back white, and the
  conversation is the same conversation either side of both changes. The
  densities differ by spacing, and spacing is exactly what a browser lays out
  and jsdom does not, so this is worth one more look in the real window rather
  than being written off as done.

  **A conversation vanishing on a theme change is not this**, and the run above
  is where that was learned. What had actually happened was a reload of the
  webview, which empties the frontend store; the channel then read one page back
  out of the archive and drew that. Three things tell the two apart, and none of
  them needs a rebuild:

  - the archive still holds every row, so `select count(*)` is unchanged;
  - the timeline holds exactly `PAGE_SIZE`, which is the tell — 200 messages,
    not a number that means anything else;
  - the connection never dropped and neither process restarted, so the status
    bar is still connected and `WebKitWebProcess` still has its original pid.

  Scrolling up pages the rest back in. On a channel of eight thousand it reads
  at first glance as a client that lost the backlog, which is worth knowing
  before somebody files it: `loadOlder` fills the viewport and stops, which is
  what it is supposed to do.

## The spine, the clock and the nickname, turned off and changed

Three settings on the settings window's Appearance page beside the density, held in
`localStorage` under `ircx.presentation`. What each one draws is asserted in
`MessageBlock.test.tsx` against the DOM, and the round trip through storage in
`session.test.ts`. **None of it has been looked at in a running window.** What
follows is what a test in jsdom cannot answer, because jsdom lays nothing out.

- **The ladder with no spine.** The two columns close to zero, so the prose
  moves 30px left — the spine's 2px and the 28px gap after it. Speech and
  presence share the ladder, so both should move together and a digest should
  still begin at the same edge as the run above it. Nobody has seen that they
  do.
- **A group with no spine to carry it.** The hue is the only thing that says
  which conversation a block belongs to, so turning the spine off costs it. A
  declared group keeps its name above the run; an addressed group keeps nothing
  but the two nick colours. Whether an addressed group is still legible is the
  open question, and it is a matter of looking at a busy channel rather than of
  mechanism.
- **The gap between two blocks of one group.** With the spine off the gap comes
  back, on the argument that nothing spans it any more. The test asserts the
  padding moved; what it cannot say is whether a group then reads as several
  separate runs, which is what closing the gap was for.
- **`Off` in a block header.** `Clock` returns nothing, so the header is a
  nickname and a `gap-2` with nothing on the other side of it. Flexbox drops the
  gap along with the child, so there should be no trailing space — an argument
  about flexbox rather than a screenshot.
- **Angle brackets at the head of a run.** `docs/mockup.png` does not draw them,
  and a bracketed name is wider than a bare one in the same 13px mono. Nothing
  measures the header, so nothing should reflow, but the header sits above the
  prose rather than beside it and how `<phrack>` reads there is a matter of
  looking.
- **Surviving a restart.** `ircx.density` was read back by hand after a restart
  on 2026-07-31; `ircx.presentation` has not been. It is written by the same
  shape of code, which is a reason to expect it and not a reason to record it as
  seen.

## The faces, the window scale, and a theme installed from a folder

- **Both faces and the scale are unwatched in a real window.** `fontTokens` and
  its painting order are asserted, and the Appearance page's controls are
  driven in jsdom, but which glyphs arrive is a question about the fonts on the
  machine. Worth looking at: whether **Courier** is present at all on this
  system — the stack falls through to `monospace`, so a reader who picks it and
  sees no change has not found a bug — and whether prose set in the mono face
  still reads as prose at the timeline's 13px.
- **The window scale has never been seen to scale anything.** It goes to
  `getCurrentWebview().setZoom`, which no test can call: jsdom has no webview,
  and `setWindowZoom` swallows that deliberately so a browser is not a failure.
  What wants watching is the thing the CSS `zoom` route was rejected for —
  whether every measured placement still lands after a scale change. The
  tooltips and the pointer menu both read `getBoundingClientRect` against
  `window.innerWidth`, and the claim is that the webview's own zoom moves the
  two together. **Check a tooltip in a bottom corner at 125%**, which is where a
  disagreement would show first, and anything else placed by measurement that
  has landed by then.
- **Installing a theme is covered on both sides and joined in neither.** The
  copy is tested in `src-tauri/src/themes.rs` against real temporary
  directories, and the page's buttons in `AppearancePage.test.tsx` against a
  mocked backend. Nothing has run the actual chain: pick a folder, watch the
  2-second poll in `themes.rs` notice it, and see the theme appear in the list
  and paint. The install selects what it copied, so a theme that lands and does
  not paint means the id it answered with is not the id the catalogue built.
- **Opening the themes folder** goes through `opener:allow-open-path`, a
  capability added for it. A capability that is not granted fails at the call,
  which is exactly what `openUrl` did before somebody clicked an `https://` link
  — see the note on that in src/lib/ipc.ts.

## Classic IRC, as a preset and as a palette

The palette is held to every constraint in `src/styles/tokens.test.ts` — ten
nick hues in the cool band, each clearing 5:1 against the lightest surface it
can land on, all of them clear of the connection colours. That is the whole of
what a test can say about it.

- **Seen once, in headless Chrome, on 2026-08-09.** The preset was applied from
  the sheet against the seeded `#ircx`: black ground, `<sable>` at the head of
  each run, `08:00:00` on the clock, no spine, and the prose in the mono face.
  The prose moved 32px left with the spine's two columns, which is the 2px
  stroke and the 28px gap. A declared group kept its `topic` label above the run
  that opened it, which is the one thing that carries grouping once the hue is
  gone.

  What that run could **not** answer: WebKitGTK renders none of it — this was
  Chrome against Vite. And `document.fonts.check` answered true for Courier New
  on a machine that resolves it through fontconfig aliasing, so what was drawn
  may be Liberation Mono wearing the name. On the operator's own machine the
  face may differ.
- **`--shadow-overlay` is a border rather than a shadow**, `0 0 0 1px`. Every
  overlay in the app takes it — the palette, the sheets, the emoji picker — and
  none has been seen wearing it. A flat overlay on a black ground may not
  separate from what is behind it at all.
- **The preset writes five settings and then stops existing.** Nothing marks it
  as in use, by design. What has not been watched is the reverse: applying
  Classic IRC and then changing one control back should leave the other four
  alone, which `AppearancePage.test.tsx` asserts through the store and nobody
  has seen on screen.

## The settings dialog

**Walked 2026-08-09 in the browser harness**, `driver.mjs --seeded` at
1200x800, over `#ircx`:

- **It opens over the conversation and nothing is dimmed.** There is no scrim
  element; the panel is `--surface-overlay` against the client's base, and the
  sidebar, the header, the status bar and both edges of the timeline stay
  legible around a 1024x672 dialog at (88, 64).
- **The Appearance rail sits beside its preview**, `414px 290px`, and stacks to
  a single `624px` column when the window is taken to 1000 — the container
  query answering the panel rather than the viewport, which is the defect #468
  found.
- **Escape closes it**, from focus where `useDialogFocus` leaves it.
- **A theme chosen in it repaints the client behind it**, watched by switching
  to ircx Light with the channel on screen. One store, so this is one write
  rather than the cross-window message it used to be — but it is what the
  missing scrim is for, and worth having seen.

**Found by walking it:** focus lands on the dialog container so Escape is in
reach, and opening from the palette is a keystroke — which is all Chrome needs
to call that container `:focus-visible` and draw the global accent ring round
the whole 1024px box. `[role="dialog"]:focus-visible` in `global.css` takes it
off.

**Still unseen:**

- **The dialog in WebKitGTK.** Everything above is Chrome, and a shadow, a
  rounded corner over a transparent window and that focus heuristic could each
  differ there.
- **Escape and a click outside during a request.** Both are declined while
  `SettingsBusy` is set — the guard each of these pages had as a sheet — and
  neither has been driven against a slow backend.

### The Networks page

**Walked 2026-08-10 in the browser harness**, same run conditions:

- **The list is the page**, drawn off the store rather than off
  `list_network_configs`: the seeded network's row named its address, its
  nickname and `Connected`, and `list_network_configs` was never called.
- **The sidebar's `+` lands here.** Settings opened with Networks selected and
  the blank server form up, which is the route the standalone dialog used to
  own.
- **Escape from the form goes back to the list, and a second Escape closes
  settings.** Both halves were defects the walk found and the code now answers.
  The form opens with its address field focused, so the dialog's `isTextEntry`
  guard declined the key outright — the screen a dialog of its own used to
  close had no Escape at all. And returning to the list left focus on `body`,
  outside the React tree the dialog's handler listens in, so the *next* Escape
  reached nothing either.
- **A refused command is reported on the row's own page.** Disconnect against
  the seed, which has no handler for it, put "the seed has no handler for
  disconnect_network" under the heading rather than into the console.

**Still unseen**, and the seed is why for most of it — `list_network_configs`
answers `[]` there, so every route that opens the form on an *existing* network
lands on "That network is no longer configured":

- **Editing a saved network anywhere but jsdom.** The row's Settings button, a
  network row's menu, the channel header's `⋮` and the palette's
  "<Network> settings" all call `openSetup(id)` and all want a real backend.
- **Saving, and the connect step under it.** The whole reason this section
  could exist here is that `Connecting` can watch a connection from inside the
  dialog. Nothing has watched it do so.
- **Connect, Disconnect and Remove succeeding.** Only their refusals have been
  driven; the seed answers none of the three.

**All three were then walked**, below.

#### The same page against a real server

**Walked 2026-08-10 in the assembled app**, `window.mjs` on `Xvfb` at 1200x800
against `ergo` 2.19 on `127.0.0.1:6667`, with a second client sitting in
`#walk` reading the wire and the server's own log beside it. Every command here
reached the Rust side and a socket, which is what the seeded run could not do.

- **The row is the connection.** The seeded network drew `walk Connected` and
  `127.0.0.1:6667 · no TLS · walker`, off the store the sidebar reads.
- **Settings on a saved row opens the form filled in.** `Network settings` came
  up on the advanced step carrying the name, address, port, TLS box and
  nickname that `list_network_configs` holds — the screen that answered "That
  network is no longer configured" under the seed.
- **Escape from that form returns to the list, and a second Escape closes
  settings.** Driven from focus inside a text field, which is where both
  defects the browser walk found bit.
- **Disconnect is a QUIT; Connect dials again.** The watcher saw
  `walker QUIT :Quit: ircx` at 07:08:11 and `walker JOIN #walk` at 07:08:15 —
  the button's own quit message rather than a dropped socket. In between the
  row, the sidebar dot and the status bar all said so.
- **Add a network saves it and connects it.** Show every setting, TLS off, port
  6667, nickname `walker2`, Return from the port field: 900 ms later the list
  carried a second row reading `Connected`, the sidebar carried it too, and
  ergo logged `Client connected [walker2]`. Both networks were still there
  after a restart.
- **Remove disconnects the one removed and nothing else.** `walk` left the
  list, the sidebar and the server at 11:12:47 while `walker2` stayed
  registered until the app itself was stopped two seconds later. The pane
  behind, which was on `#walk`, went blank rather than closing — the store's
  answer for a view pointing at a network that is gone.
- **An edit is saved.** The port changed to 6699 and Return: reopening the form
  read 6699 back, and the next launch dialled it.

**Found by walking it**, neither a defect of this page and both worth knowing:

- **A live connection is not restarted by an edit, and nothing says so.** After
  saving 6699 the row went on reading `127.0.0.1:6667 · Connected`, because the
  list describes the connection while the form describes the configuration.
  They disagree until the network reconnects, and the page offers no reading of
  that except the two numbers differing.
- **The list's order is whichever server answers first.** `networkOrder` is
  built as `networkUpdated` arrives, so two networks dialling at once race:
  ergo registered them 1 ms apart and the order came out reversed between one
  launch and the next. The sidebar has always ordered them this way; a settings
  list that rearranges itself between launches is a louder place for it.
  Answered by #480: the order is the names now, and the id settles two of them
  sharing one. Not walked again — the reordering is the store's, and
  `index.test.ts` reproduces the race by applying the events out of order.

**Still unseen:**

- **The failure line on a row.** A port nothing listens on is `Reconnecting`
  with a countdown, not `Failed` — the reconnect loop owns it. The red reason
  under a row wants what core treats as fatal: a rejected SASL, a certificate
  it will not accept, a nick it cannot resolve.
- **`Connecting` itself, drawn.** The save above connected before the first
  screenshot 900 ms later, so what is verified is the connection and not the
  screen that was supposed to be watching it. Loopback is the wrong network to
  photograph it on.
- **The other three routes to the form.** Only the row's own Settings button
  was walked; the network row's menu, the channel header's `⋮` and the palette
  entry call the same `openSetup(id)` and none of them has been driven here.

### The second window this replaced

Kept because the walks below are what the shape was chosen against, not because
any of it is still on screen: `open_settings`, `SETTINGS_URL` and the
localStorage hand-off went with the window in #468, and the pane that replaced
it is gone too.

A second Tauri window, opened by `open_settings`. Walked in the browser
harness at `/?settings` — the layout, the preview, the preset, the accent
swatches and the scale stepper all answered there — and then twice in the
assembled release app on `Xvfb`.

**Seen on 2026-08-09, in the real app:**

- **The window opens.** `Ctrl+,` built it, and it came up undecorated and
  transparent like the client with its own title bar, its sidebar, the preview
  and the rail all drawn. This is the part no frontend test reaches:
  `WebviewWindowBuilder` is Rust, and the settings window needed its own entry
  in `capabilities/default.json` before its `invoke` calls would be allowed.
- **A theme crossing between the two windows.** Chose ircx Light in the
  settings window, pressed Escape, and the client behind it had repainted
  light. **This failed the first time and found the bug**: `startAppearanceSync`
  was mounted in `SettingsWindow` and nowhere else, so the settings window
  listened to the client and the client listened to nothing. Every unit test
  passed throughout — they exercise `adoptAppearance` directly, and no test in
  one webview can notice that the other never subscribed.

**Still unseen**, and none of it is reachable from jsdom either:

- **Opening it twice.** The second call should find the window by its label and
  focus it rather than build another. Minimise first, then `Ctrl+,` again.
- **Every other setting crossing.** Only the theme has been watched. The
  density, the accent, both faces and each of the five timeline settings go by
  the same path and the same one message, which is a reason to expect them and
  not a reason to record them as seen.
- **The reverse direction.** `Ctrl+Shift+N` in the client should move the
  checkbox in the settings window. Nothing has driven the client while the
  settings window was on screen.
- **A preset across two windows.** It writes three settings and says so once.
  What that is for is the flicker: told three times, the client would paint the
  new theme against the old faces on the way past. Whether one message makes
  the client's repaint look atomic is a matter of watching it.
- **The window scale with two windows open.** Each window scales itself, on the
  same setting, by adopting it — there is no cross-webview zoom call. Both
  should reach 125% together.
- **Escape from a token field.** Asserted in jsdom against the editor behind
  Custom…; the rule is that Escape abandons a value being typed rather than
  taking the window with it, and a real webview has never been asked.
- **The resize grips.** `WindowFrame` is the client's, mounted in a window it
  was not written for.

### The three sections that moved into it

The upload provider, the archive and the plugin screens were sheets over the
client, reached only from the palette. They are pages now, and each was walked
at `/?settings=<section>` in the browser harness: the sidebar lists four, the
deep link lands on the right one, and switching between them works. Their own
tests moved with them and still assert what they always did.

**Seen on 2026-08-09, in the release app on `Xvfb`:** opening `Ctrl+,` from a
joined `#harness` and switching to Privacy, the page named that conversation
throughout — the per-channel retention row, `Export #harness`, `Delete
#harness` — and read the archive summary off the backend. That is the scope
hand-off working with a channel name carrying a `#`, which is the case the URL
route was rejected for, and it is the settings window's capability grant
covering a command beyond the theme ones.

What the walks cannot reach:

- **The status bar after a plugin changes.** The plugin screens are in the
  settings window and the count is in the client's status bar, so installing,
  removing or re-granting has to cross between them — `announcePlugins`. This
  is the one place where the thing that would go wrong is silent: the plugin
  really is installed, and only the number is stale.
- **The Privacy page with no conversation open at all.** The scoped half is
  seen; the empty case is not. It should say to open one rather than show
  controls scoped to nothing, and the whole-archive controls beside it should
  still work.
- **The palette's three entries.** Plugins, Uploads and Privacy each open the
  window on their own section, and each has to work both when the window is
  shut — the section is in the URL it is built at — and when it is already
  open, which goes by an event instead. Those are two different code paths for
  one act.
- **Escape during a request.** A page with a request in flight refuses to
  close, which was each sheet's own guard and is now the window's. Save a
  plugin's permissions against a slow backend and press Escape.
- **The uploads page after a save.** As a sheet it closed, which was how it
  said the save happened; a page that stays open says "Saved." instead.
  Nothing has watched that the notice appears and then goes when the form is
  edited again.

## Unread counts

`mark_read` is the only thing that resets a conversation's unread count, and
until #133 nothing called it — a badge in the sidebar only ever grew. It is told
now when the pane showing a conversation takes focus.

Which moment counts as *read* is a judgement, so a test can only assert whichever
rule was chosen. What a running window has to answer is whether the rule is the
right one:

- A channel in the other half of a split keeps its count until that pane is
  focused, which is deliberate — being on screen is not being read — and may
  still feel wrong when both panes are plainly visible.
- A conversation left focused while messages arrive is marked read once, on
  arrival at it. Whether a badge should reappear underneath a pane the user is
  looking at but not reading is not settled.

**A reconnect used to hand back the last message you had read, with a 1 on it**
(#380), found by probing this on 2026-08-03 rather than from an entry — there
was none. A gap is asked for from the newest thing a conversation holds, and
`history::at` truncates that to the milliseconds the resume format carries. The
truncation is deliberate and its own comment gives the cost: "at worst asks
again for a message already held — the archive refuses the duplicate". The
archive does. The badge did not:

```text
live message, msgid=abc          unread 1
mark_read                        unread 0
gap fill returns abc and def     unread 2   ← 1 was right
```

It bit on every reconnect where a conversation's newest message was stamped by
this machine rather than by the server — `archived` keeps nanoseconds and the
resume carries milliseconds — and on any server that includes the boundary
message in its own answer.

A replayed message is measured against the watermark the conversation held
*before* the batch began now, rather than the one the loop moves forward as it
goes. Strictly newer, so a genuinely missed message sharing the exact server
timestamp of the last one read is drawn and not counted — a millisecond
collision against a badge that was wrong on every reconnect.

**Still no evidence for the count against a real socket**, which this section
already said and this does not change: the exchange is scripted in
`crates/ircx-core/tests/session.rs`, and nobody has watched a badge across a
real drop.

## What a removed network leaves behind

Probed on 2026-08-03. There was no entry for this, and no entry for drafts at
all.

`remove_network` deleted `networks` and `open_targets` and left `drafts` and
`retention` where they were. A network id is a fresh uuid, so nothing will ever
name that one again — not even re-adding the same server — which makes those
rows stranded rather than kept: no screen can reach them and nothing cleans
them.

**Drafts are the half that matters**, because a draft is text somebody typed and
did not send. The removal screen promises "Removing it disconnects it and
forgets its settings. The conversations already archived stay on this computer",
and a draft is neither. `delete_target` and `delete_everything` both take drafts
with them; this was the third door and the only one that did not. #382.

**Retention is the same promise more directly** — a window is a setting, set
from the archive sheet, and it decided nothing once its network was gone.

Both go with the network now. The archived messages stay, which is what the
screen says and what the walk left alone.

## Schema migrations

`migrations.rs` is covered by two tests — that migrating is idempotent on
reopen, and that a database from a later version is refused — and both run
against a database created moments earlier. Nothing in the suite migrates a
database that has anything in it.

**The fifth migration is verified** against the owner's own profile on
2026-07-30. It went from version 4 to 5 with 840 messages of history already
archived: the row count only went up as the session reconnected, the history
rendered as it had before, and search worked over the migrated archive. Search
is the one that mattered — appending `via` to `message::COLUMNS` moved the index
`search` read its snippet from, and the tests that caught it were the reason the
index is now derived. A restart kept a plugin's attribution, which is the whole
claim behind archiving `via` rather than deriving it.

The profile was copied first. That is worth keeping as the habit: a migration
raises `schema_version`, and `migrate` refuses a database whose version is
higher than the build supports, so it is a one-way step per install.

What that leaves:

- **Going back is walked, and it was a panic.** On 2026-08-01, against a
  throwaway profile created by this build and then marked one schema ahead —
  which is what any earlier build sees after a migration. It did not open a
  window and it did not say anything a person would find:

  ```text
  thread 'main' panicked at tauri-2.11.5/src/app.rs:1425:11:
  Failed to setup app: error encountered during setup hook: this archive was
  written by a newer version of ircx (schema 10, this build knows 9)
  note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
  ```

  Exit 101. An error out of the setup hook panics inside Tauri's own `build`,
  before a window exists, so the client starts and vanishes. The sentence was
  already written for a person and had nowhere to be read.

  Now: no panic, a dialog naming the version and saying the history is intact,
  and the same four lines on stderr for whoever is reading a log rather than a
  screen. `OK` ends the client. The supported path is unchanged — the same
  profile with the version put back starts normally.

- **A dialog at startup is walked** on 2026-08-01, and it took three attempts.
  The two that failed are worth more than the one that worked, because both
  look correct and neither draws anything:

  - `app.dialog()…blocking_show()` in the setup hook. The process stays alive
    and nothing appears. Setup runs before the event loop, and a dialog with no
    loop to pump it never reaches the screen — a silent hang, which is worse
    than the panic it was replacing.
  - `.show(callback)`, handed to the loop, with the config-built window closed
    first so a client that cannot reach its backend is not left sitting behind
    the dialog. Also nothing. Closing is the reason: it is the only window, so
    closing it asks the loop to exit before the dialog is up. It panicked on
    the way out too — `state()` before `manage()` — because the exit handler
    reaches for an `App` that a failed start never managed.
  - `.show(callback)` with the window **hidden** rather than closed. The loop
    stays alive to draw the dialog, and there is nothing visible behind it.

  Confirmed by the owner looking at it: the dialog draws, reads as intended,
  and `OK` closes the client with nothing left behind and no panic. The exit
  handler is guarded now, so a start that never managed an `App` does not reach
  for one on the way out.

  What no test covers: all of it. There is no way to assert a native dialog
  drew, so the only evidence this works is somebody looking at it, and the only
  evidence it keeps working will be somebody looking again.
- **The first four migrations.** Only the fifth has been recorded as run against
  real data. The others presumably were, at some point, by whoever was running
  the client at the time; nothing says so.
- **A migration that is not free.** `ALTER TABLE ADD COLUMN` writes no rows, so
  this one costs the same on 840 messages as on 840,000, and 840 proves nothing
  about the next one. Retention is a window in days per target rather than a cap
  on rows, so an archive is however much a busy channel says inside it; a
  migration that rewrites or backfills would be the first to care, and nothing
  has timed one.

## Themes installed on disk

The two built-in themes are exercised by every test run and by every render, so
the loader, the validator and the picker are covered. What is not:

**Walked on 2026-08-03** in the assembled app on `Xvfb`, against a real app data
directory — `docs/end-to-end-run-6.md`. The window harness draws in WebKitGTK,
which is what this list was waiting for.

- **The themes directory is walked.** `src/styles/themes/ircx-light` copied to
  `<profile>/themes/harbour` under a name of its own **while the app was
  running**, and it was in the palette four seconds later without a relaunch,
  reading `light · the themes walk · 1.0.0`. It draws.
- **Hot reload is walked.** `--surface-sidebar` edited in the installed
  `theme.css`: the sidebar, title bar and status bar followed within the poll,
  nothing restarted. Deleting the theme while it was in force dropped the window
  to the built-in dark one, whole rather than half-styled.
- **An edit survives a restart.** `--surface-base` set through the appearance
  editor, the app relaunched on the same profile, and the edit still there. This
  needed `window.mjs --profile`, which the run added: every run before it seeded
  a fresh profile, so nothing that only matters across a restart could be asked
  at all.
- **The opening paint was the one that failed** (#364). The entry below asked
  whether the window flashes the theme's own value before its edits; it does
  not, and what it flashes instead is the **built-in dark theme**, for about
  130ms on every launch. Measured off a 30fps capture of the display, with a
  built-in theme as the control on the same profile:

  ```text
  installed theme   1.27s white → 1.50s rgb(10,13,18) → 1.63s the theme
  built-in light    1.27s white → stays
  ```

  `applyOpeningTheme` resolved the catalogue from the built-ins alone, so an
  installed theme was `applyTheme(null)` until the backend answered, and `null`
  uncovers the dark theme `global.css` imports statically. The theme's two files
  are now kept in `localStorage` beside the edits that were already kept there
  for this exact reason, and the `rgb(10,13,18)` frame is gone. A screenshot
  cannot see any of this — four frames — so what answered it was recording the
  display rather than photographing it.

- **`color-scheme` on a real window is walked** on 2026-08-03, and the entry it
  replaces was asking the wrong question — `docs/end-to-end-run-9.md`.

  **The scrollbar was never `color-scheme`'s.** It does flip with the theme —
  thumb `rgb(49,58,70)` dark against `rgb(206,212,218)` light — but
  `global.css` styles it, `::-webkit-scrollbar-thumb { background:
  var(--border-strong) }`, and that token is `#313a46` and `#b6bfc9` in the two
  themes. It is not a native control and would flip with no `color-scheme`
  anywhere. The form controls the entry also named are token-styled in
  `fields.tsx` for the same reason.

  **What is left is the one surface the page cannot style**, and it ignores the
  attribute. A `<select>` popup under ircx Light is black with white text and a
  blue selection bar; under ircx Dark it is the same, and cropped to the popup
  `compare -metric AE` between the two is **0**. WebKitGTK draws it with the GTK
  theme. `apply.ts` sets `root.style.colorScheme` from the manifest correctly
  and nothing observable depends on it.

  So on this platform the attribute does nothing anybody can see, which is not a
  reason to stop setting it — a platform that honours it costs nothing here. It
  is a reason to stop recording it as unverified.

  **The defect it uncovered is #375**: a light theme is light until somebody
  opens a dropdown, and then it is the desktop's black panel. Fixing that means
  drawing the list instead of asking the platform for one.
- **What a browser does with a value it cannot parse.** The appearance editor
  refuses a value holding a stray `;` or `!` because `setProperty` is specified
  to ignore a custom property whose value is not a `<declaration-value>` —
  silently, leaving the token unset and uncovering the dark theme `global.css`
  imports statically. jsdom's `cssstyle` stores such a value verbatim instead,
  so the tests pin the gate's behaviour and nothing pins the behaviour it is
  premised on. **Both halves walked on 2026-08-01.** With the gate in place,
  `#0969da;` pasted into `--surface-base` on `ircx-light` was refused in a
  sentence and the field snapped back. With `tokenProblem`'s stray-character
  branch disabled and the same paste made, the window went from `#ffffff` to
  `rgb(10, 13, 18)` behind the conversation — the dark theme's surface — while
  the sidebar stayed `#f6f8fa`, because `--surface-sidebar` was still set. Half
  a light theme, no error, and the editor reading "1 of the author's 62 tokens
  changed". The premise holds: WebKit drops the declaration without a word, and
  the gate is what stands between a pasted stylesheet line and a window in two
  themes at once.

  Two things the walk turned up that the tests do not reach. Relaunching with
  the gate restored and the refused value still in `localStorage` dropped it at
  load — `sanitiseOverrides` runs the same check on the way in — and the surface
  came back white without anyone clearing anything. And the refusal names a
  character the field no longer shows: the sentence says `--surface-base has a ;
  in its value` while the field reads `#0969da`, because a refused value is
  never committed and the field snaps back to what it held. That is
  `TokenEditor.tsx`'s stated design rather than a defect, and the alternative it
  argues against — a second place a value can live — is worse.
- **The sheet against a theme installed on disk.** Every component test uses the
  two built-ins. An edit is keyed by theme id and kept in `localStorage`, so a
  theme that arrives after first paint takes its edits a frame later than the
  built-ins do. Install a theme, edit a colour in it, relaunch, and the edit
  should be there; the window should not flash the theme's own value first.

## Searching the archive

Probed on 2026-08-03 against a seeded archive, and this section exists because
nothing was written down about search at all — the entry was found rather than
answered.

**Nothing a person can type is a syntax error**, which was the thing worth
checking first: FTS5's query language is a language and the search box is a text
field. `fts_phrases` quotes every whitespace-separated run and doubles a typed
quote, so `AND`, `NEAR(a b)`, `"unclosed`, `*`, `^`, `-stuck`, `col:value` and
`:)` are all read literally. Asserted as a battery in
`crates/ircx-store/tests/store.rs` rather than an example, because the failure
mode is a database error thrown at somebody who typed a smiley.

**Search matched whole tokens and nothing else**, which is ordinary and fine
for a language with spaces in it and useless for one without. `messages_fts`
uses FTS5's default `unicode61`, so a run with no spaces was a single token, and
a Japanese, Chinese or Thai conversation was searchable only by typing the whole
message back. An emoji produced no token at all. #378.

**Fixed by keeping both indexes**, decided by the owner on 2026-08-03. A second
FTS5 table over the same column, tokenised `trigram`, is asked when the
whole-word one answers nothing. Three things follow, and the third is the one to
know about:

- `落ちた` and `サーバー` now find `サーバーが落ちた`, which is the whole point.
- `ok` and `hi` still work, which they would not have under `trigram` alone —
  it matches nothing under three characters. That is what carrying both buys,
  and it costs a third of the archive on disk (`docs/measurements.md`).
- **A query's results can shrink as the archive grows.** `eploy` finds "the
  deploy is stuck" today because no whole word matched it; archive a message
  containing the word `eploy` and the substring pass stops running, and the
  first message drops out of the results. The alternative was to union both
  indexes on every search, which puts substring noise under every Latin query
  that works today. Asserted either way in
  `a_substring_is_found_only_where_a_whole_word_was_not`.

**A lone emoji is neither index's problem.** `🔥` is one character, so there is
no trigram to look up and `unicode61` never made a token of it. What answers it
is a `LIKE` scan of the messages table, reached only by a query under three
characters that the whole-word index already failed — 15 ms against 100,000
rows, where either index answers in 0.4. The issue claimed `trigram` fixed the
emoji half; it does not, and that was found by probing SQLite rather than by
reading the docs.

`"failed badly"` still matches across a `🔥` between those two words, because
`unicode61` drops it and the whole-word index answers first. That is the
tokeniser being consistent rather than a defect.

### Walked in the assembled application

**2026-08-03**, `window.mjs --profile` on a kept profile with five messages
written into its archive by hand, so each path is reached by a query only that
path can answer. All three found what they should and nothing else:

| query | path | | |
|---|---|---|---|
| `deployment` | `messages_fts` | `the `**`deployment`**` is stuck behind a lock` | `docs/search-indexes/whole-word.png` |
| `eploy` | `messages_substr` | `the d`**`eploy`**`ment…` | `docs/search-indexes/substring.png` |
| `_` | scan | `rate`**`_`**`limit is the flag you wa…` | `docs/search-indexes/scan.png` |

The `_` run is the one worth keeping: a LIKE pattern would have matched every
message with a character in it, and one message came back.

**It found the frontend refusing the query the issue is named for.** The
overlay would not search below two of `String.length`, and `String.length`
counts UTF-16 code units — so `🔥` was a surrogate pair and passed, while `落`
was one unit and was refused. A whole word in Japanese and a whole message in
emoji sat on opposite sides of a line drawn for neither. The floor is one
character now, counted as characters, which is what the archive can answer.
Nothing in the store change would have shown this; it took the running app.

**Not walked: the CJK and emoji queries themselves.** `window.mjs` types
through XTest, which maps each character to a keycode on the X layout, so
nothing outside it can be typed at all — the first attempt at this walk sent
`落ちた` and the palette stayed empty. The queries above are the ASCII ones that
reach the same three paths. What is asserted directly is
`crates/ircx-store/tests/store.rs` and `SearchOverlay.test.tsx`; a walk that
types `🔥` into the real window needs a harness that can, and that is a gap in
`window.mjs` rather than in the client.

## Asking the server for what was missed

**Verified against a local `ergo` on 2026-08-01**, in
`crates/ircx-core/tests/ergo.rs`. The client parts, a second client says
something, the client rejoins and asks:

```text
> CHATHISTORY AFTER #ircx-drive timestamp=2026-08-01T00:57:21.652Z 200
```

What comes back arrives inside a `chathistory` batch and is labelled
`ServerHistory`, which is the whole of what the receive half was already built
for and had never had a request to answer. #219.

Two things the run settled that were guesses beforehand:

- **Ergo batches every answer**, including a single message and an empty one.
  The design rests on that: outside a batch there is nothing to tell a replayed
  message from a live one. Probed directly, labelled and unlabelled.
- **The step raced itself first.** Waiting for the outgoing line before
  rejoining says only that this client wrote it — the server had not read it
  yet, so the message came back live and correctly so. Waiting for the echo is
  the barrier.

**Seen in the assembled application** on 2026-08-01, in all three shapes:
`LATEST` on a first join, `AFTER` on a rejoin, and `AFTER` across a restart with
the app closed while the channel moved on. The messages land in the right place
and group correctly. `docs/end-to-end-run-3.md`.

That run found four defects in how a backfill is drawn rather than in whether it
arrives — #221 to #224 — of which the root is that nothing on screen separates
a replayed message from a live one.

**#221 and #222 are fixed and re-walked** on 2026-08-01 against the same ergo. A
replayed run is bounded by *From the server's history* and *Live from here*, and
a service narrating the reader's own join no longer claims to have addressed
them. The case worth watching is the one that survived: `phrack: sable: can you
look at the fixture race?`, said in the gap by somebody still in the channel, is
still marked and still tinted. The gate is on who is in the conversation, not on
where the message came from.

**#223 is fixed and re-walked** the same day. Both halves were watched, because
the whole change is that they differ: joining `#gap` for the first time drew its
backlog and left the sidebar row unmarked, and quitting, letting the channel say
three things, and relaunching brought the row back reading **3**. The count is
what was said and not what the replay contained — ergo narrates the reader's own
quit and rejoin in the same batch, and an earlier build of this counted those
too and said five.

What is left:
- **A gap wider than one page is fetched whole** (#239), walked on 2026-08-01
  with 520 messages said to a channel while the app was closed. Three requests
  went out, each starting where the last page ended, and 529 messages were
  archived. The same walk before the change archived 216.

  It took a logging proxy in front of the server to see why. The continuation
  was resuming from the conversation's watermark, which moves with **every**
  message including live ones — so anything said while a page was in flight
  pushed it to now, and the second request went out stamped later than the whole
  backlog it was chasing. It resumes from the newest message in the page that
  arrived. No test caught this and none could have: nothing interleaves live
  traffic with a batch except a real server.

- **The ten-page cap**, walked on 2026-08-01 with 2500 messages said to `#flood`
  while the app was closed. Ten `CHATHISTORY AFTER #flood … 200` went out and an
  eleventh did not; the conversation ends at `line 2000 of the flood` and says
  `This conversation moved faster than ircx caught up with: 2000 messages of it
  were fetched and there is more that was not.` The cap holds and the sentence is
  true.

  Two things worth knowing, neither of which the cap itself gets wrong:

  **A page boundary inside one millisecond loses a message.** 1999 of the 2000
  were archived. The missing one is `line 0200`, and the reason is that the
  resume point is a timestamp: page one ended at `line 0199` stamped
  `14:20:51.623Z`, `line 0200` carries the same millisecond, and `AFTER
  timestamp=…51.623Z` is exclusive of it. Asked of the server by hand, that
  selector answers with `line 0201` onwards — the message is not late, it is
  unreachable through a timestamp. A millisecond is not a unique key and a busy
  channel puts several messages in one, so this loses everything that shares the
  last millisecond of a page. It is invisible below the cap only because a gap
  that fits in one page has no boundary to fall down. This is the third defect
  in this area that only a real server run could produce, after #223's window
  and #239's poisoned resume point.

  **Fixed and re-walked on 2026-08-01** (#253). A continuation now resumes on
  the msgid of the last message in the page that arrived, which names one
  message where a millisecond names several; a page whose server sent no msgid
  still resumes on the timestamp. The same 2500-message flood into a fresh
  channel produced one `AFTER … timestamp=` — the first request, which has only
  the archive's watermark — followed by nine `AFTER … msgid=`, and archived
  `line 0001` through `line 1999` with nothing missing between them. The cap
  still stops the eleventh request and still says so.

  **What survived the cap was the oldest of what was missed, not the newest.**
  `AFTER` pages forward, so the reader got lines 1 to 2000 and lost 2001 to
  2500 — the five hundred closest to now. The discontinuity therefore sat
  immediately above the live seam, which is where a reader is least likely to
  expect one, and the sentence explaining it was drawn below the seam rather
  than at the join. `continue_gap` stated the reasoning for saying something at
  all; what it did not decide is which end of the gap to keep, and this walk is
  the first time anyone saw which end that turned out to be.

  **Fixed and walked on 2026-08-14** (#520), in `tests/gap_walk.rs`, which is
  the first driver here to run against a server of its own: the walk is only
  interesting past the cap, and at the 1000 ergo advertises by default that is
  two thousand messages before anything under test happens. With
  `chathistory-maxmessages: 5` the whole budget is fifty and seventy lines is a
  wide gap, so the same shape runs in a minute.

  Half the budget goes forward from the watermark; pages still coming back full
  at `GAP_FORWARD` turn the walk round to the newest page and work back until
  the two halves meet. Against ergo 2.19 on 6687, seventy lines said while the
  reader was away: five `AFTER` (the first on the watermark's timestamp, the
  rest on msgids), one `LATEST`, four unlabelled `BEFORE`. The reader came back
  holding `line 001` to `line 024` and `line 047` to `line 070` — one hole,
  and the near end that the conversation runs on from is on the right side of
  it. The sentence is stamped a millisecond above `line 047`, so it is drawn
  at the hole rather than under the seam.

  **The control is the same walk on `main`**, which is worth stating because a
  driver that passes on both builds has measured neither: ten `AFTER` requests,
  `line 001` to `line 049` held, and everything from there to what was being
  said as the reader arrived gone.

  Two things the run settled that no test could:

  - **An outgoing `RawLine` is emitted as the line is queued**, not as it is
    written, and this client paces its own writes at half a second a line once
    the burst allowance is out. Waiting for one as a barrier let the reader
    reconnect into the middle of the flood, where the rest of it arrives live
    and there is no gap to fetch at all — a walk that would have passed while
    testing nothing. The barrier is the `echo-message` copy coming back.
  - **Ergo answers an unlabelled `BEFORE`.** The backward half is a request
    nobody is waiting on, and it has to stay unlabelled: a label is how a page
    a reader scrolled for is matched to them, and a gap fill wearing one would
    be taken for an answer to somebody.
- **Libera offers no history to ask for.** The capability was not in what
  `cadmium.libera.chat` advertised on 2026-07-30, so nothing is sent there and
  the archive stays the whole history. That is the degrade working, and it also
  means no Libera run can exercise any of this.

### Reading back past the archive

**Verified against a local `ergo` on 2026-08-10**, in the same driver. #472.

```text
> @label=ircx-2 CHATHISTORY BEFORE #ircx-drive msgid=_eths9je6j3jj8g3zpswvwe4hva 200
```

The label is the whole reason the run exists. A gap fill and a reader scrolling
back are both `chathistory` batches naming the same conversation, and both can
be in flight at once, so ircx matches the answer to the request on the label it
went out with — and whether a server echoes one on the `BATCH` line is the
server's decision, which no fake server can settle. **Ergo echoes it**, the
request was answered, and a message older than the one asked from came back as
`ServerHistory`. Had it not, the reply would never have resolved and every pane
would say it had reached the beginning of history — the same bug as before,
silently and for a different reason.

`page_back` therefore requires `labeled-response` as well as
`draft/chathistory`, and asks nothing without both. It is the one place in this
client where a missing capability costs a feature rather than changing how one
works.

**What this leaves:**

- **Libera again**, for the reason above: no history capability, so nothing is
  ever asked and nothing can be walked there.
**A pane a person actually scrolls was walked on 2026-08-10**, over a
900-message channel on a local `ergo`, from the live edge to line 0001.
`docs/end-to-end-run-12.md` is the run.

The paging is right: five labelled `CHATHISTORY BEFORE` requests, in order, none
repeated, and **Beginning of history** drawn after the fifth came back short and
not before. That is #472 holding in a pane rather than on a socket.

**The reader is not.** A page landing moves the timeline under them — 24 px in
one walk, 29 px in another, measured between two frames with nothing sent
between them. The head that says "Loading older messages" grows the scroller
above the list on a commit where nothing was prepended, so `usePrependAnchor`
ignores its height. #475, with the arithmetic and a Chrome measurement that puts
the displacement and the head at the same 24.5 px.

What that leaves:

- **The whole cycle.** The head's arrival and its departure are each measured on
  their own; whether they cancel is not. #475 says what to measure.
- **A release build.** Both walks are debug against Vite, so `StrictMode`. The
  shipped path is the unwalked one.
- **Two panes on one conversation**, one at the live edge and one scrolled back.
  The anchor shares a component with #307's restore and no walk has opened both.

### A message arriving while the reader is scrolled back

**Walked on 2026-08-10 (#484), and it is the first of these against a release
build.** `npm run tauri build -- --no-bundle`, three minutes, driven by
`window.mjs --release` — so WebKitGTK rather than Chrome, and no `StrictMode`.
The server is ergo 2.19 on `127.0.0.1:6667`; a second client floods 250 lines
into `#anchor`, ircx joins and pulls them, and the walk parks the reader in the
middle of them at `backfill line 0108`, about 108 messages down and 118 to go.

Sixteen frames two seconds apart, with one `PRIVMSG` from the second client
between the eighth and the ninth. The arrival is fired off the eighth frame
appearing rather than off a guess at how long startup takes.

Every consecutive pair, counted by region:

| region | pairs 1-7, 9-15 | the pair the message lands in |
|---|---|---|
| the conversation | 0 px | 0 px |
| the sidebar | 0 px | 248 px |
| the scrollbar | 0 px | 42 px |

The reader does not move by a pixel. What the 248 is, is the unread badge
arriving on the channel row; what the 42 is, is the thumb shortening because the
document got taller. Both are the client saying a message came, which is the
point.

Two controls, because a still pane is also what a walk that tested nothing
returns. `MARK-SIX` is at the live edge under **Live from here** in the last
shot, so it arrived; and the roster still holds `phrack`, so it arrived from
somebody who was there. **Two earlier runs failed exactly this way.** The second
client answered no `PING` and ergo dropped it, and the run photographed sixteen
identical frames of a channel nothing had been said in. Ergo also destroys an
unregistered channel and its history when the last client leaves, so a run that
kills the flooder between attempts comes back to an empty `#anchor` and a pane
with nothing to scroll in.

What that leaves:

- **A message sorting in above the reader.** This is the case #484 fixed and it
  is not the one walked: ergo stamps `server-time` itself, so a client cannot
  backdate a line, and the merge that puts a message in front of the reader is
  staged in `Timeline.test.tsx` rather than on a socket. The route to it live is
  a `CHATHISTORY` batch landing behind a message that arrived while it was in
  flight, which is a race a walk would have to win rather than ask for.
- **The window at its cap.** The other half of #484 needs 10,000 messages held
  and the reader scrolled back inside them. 250 is what this run flooded.
- **A notch is about 69 px here**, not the third of a message the skill's note
  suggests, so 78 of them put the reader at the top of the history rather than
  inside it. Two runs measured the least sensitive position before that was
  noticed. Check the parked frame before believing the frames after it.

**#494 and #496 are fixed in a test and unverified in the app.** Run 16 built
the instrument that ought to settle them — `pageBack` sends the oldest message
the window holds, so a tap on the socket reads the frontend's own head without
anybody judging a screenshot — and then could not make either defect happen
often enough to conclude from. Twenty walks, ten against the fix and ten
against the build before it, came out identical: the fresh-profile walk does
not reproduce #494 even in the build that has it, because the pane's priming
read finds the archive still empty and an empty archive puts nothing in front
of anything.

#496's duplicate page-back *was* seen once, on the old build, in the shape the
issue predicted — the same msgid asked twice 37 ms apart — and not on the new
one. One in four runs against none in four is a reason to walk it again, not a
verdict. `docs/end-to-end-16/dupes.sh` is the counter; it wants dozens of runs
rather than the three it was given.

What a run needs to reach either: an archive that is not empty when the pane
mounts, which is the second launch on one profile, and which takes
`CHATHISTORY AFTER` rather than `LATEST` — a path no run before 16 had walked.

**Run 17 walked it under load and both are still unverified.** Forty
fresh-profile walks and fifteen two-launch runs against each build, with
thirty-two spin loops on sixteen cores — the contention that stretches
`load_history`, which is where the race #494 describes is won or lost, the
profile being on a tmpfs and ergo a local socket. Zero sightings of either
defect on the build that has both in it. The load level was enough to change
what the app does and not enough to reproduce either; above it the walks stop
completing, and where that ceiling is has not been measured.

The #496 count is worth less than its fourteen runs suggest. A duplicate needs
two asks to be one, and the old build makes exactly two per run where run 16's
duplicate-bearing run made five — so fourteen runs bought about the same 25 asks
that run 16's four bought. `#scrollback` has drifted: a hundred-odd sessions of
join and quit noise have pushed run 15's seeded lines back, the walk reaches the
end of what it can see sooner, and asks less on the way. **A count of #496 needs
the channel re-seeded first**, so that a run makes a dozen asks rather than two.

**Run 19 re-seeded it and ran the count.** `#scrollback` is 2400 fresh lines,
ergo's buffer (`channel-length: 2048`) is seeded history again, and ten pages sit
behind the landing page — so a two-launch run makes ten asks where run 17's made
two. Twelve runs a build: **120 asks each, zero duplicates on both**, with the
page-backs stepping a uniform full page on either build. Run 16's one-in-twenty
would predict about six in 120 and gives odds of roughly two in a thousand on
seeing none, so the duplicate run 16 photographed was not a one-in-twenty event
and exposure is no longer the explanation for a zero. `docs/end-to-end-run-19.md`.

Two instrument notes from it. **`ahead` is not a meaningful column for a
two-launch arm** — `ahead.py` assumes a fresh profile so that "oldest delivered"
can stand in for "oldest held", and on a second launch most of the window came
off disk and never crossed the tap; `repeated` is wire-only and stays valid.
And **`seed_history.py` printing "seeded" means the socket took the lines**, not
the server: `fakelag` allows five commands then two a second per client, so 2400
lines take ten minutes to land and a walk started on the success line walks a
channel mid-write.

What that leaves: #496 is unreproduced in the app after four runs, and the next
attempt should **manufacture its precondition** — messages injected between the
two launches, so the second launch's archive is genuinely behind a server that
has moved on — rather than walk for it again.

**Run 20 manufactured it, and the app cannot enter the state at channel open.**
The fix reads the head after the archive read rather than from the snapshot
before it, so the two differ only when the timeline changed during the await.
Where `older` is empty *and* the snapshot is empty, the old build computes
`undefined`, `pageBack` reads that as nothing behind the conversation and
returns `"end"` without sending anything, and the pane draws "Beginning of
history" over a server holding thousands — a worse symptom than the wasted round
trip, now covered by a test that fails on `b75edf2` with `pageBack` never called
at all.

`docs/end-to-end-20/holdlatest.py` holds the batch answering the join's
`CHATHISTORY LATEST` and passes every other byte. Held at 0, 100, 800 and
8000 ms on the build with the defect: two page-backs sent at every point. The
frame taken inside the hold says why — the pane already holds its join digest
and the channel's system rows, so the snapshot is never empty, and the shape
needs a pane with no messages whatsoever. A joined channel never has one.
`docs/end-to-end-run-20.md`.

What that leaves is one narrow path nobody has walked: a pane **restored from
the layout before its join completes** has no digest yet, so its snapshot can be
empty while its archive is. It is a startup window, it needs three conditions at
once, and the symptom is already covered by a test — so it is recorded here
rather than recommended.

Three readings of that run said a defect was there before the fourth said it was
not, and the third is the one to know about, because it is a property of tapping
a socket rather than a mistake in one script. **A tap sees bytes before the
client has filed them.** An ask that goes out while a page is arriving looks
exactly like an ask from the wrong end of a list — and eighty walks produced
sixteen of those, eight on each build, which reads as a fix that does nothing.
Every one had a gap between 1 and 13 ms. `docs/end-to-end-17/ahead.py` discounts
an ask that crossed a page in flight and reports how many it discounted; a run
where that number is large and the count is zero has shown nothing about the
order of anybody's list.

So run 16's argument holds with a clause attached: a client that asks the server
questions will tell you what it thinks it holds, **about the rows it has had time
to file**. Anything else read off a tap is a statement about the socket.

**The one difference the two builds showed in the app is worth a walk of its
own.** The fixed build asks the server for a page far more often on identical
walks — 121 against 69 over forty fresh-profile walks, and 89 over fifteen
two-launch runs against 25 over fourteen. Six asks a run against two, and the
old build's two is consistent enough to look like a wall rather than a race.

The candidate is the `#487` guard, `current.messages[0]?.id === current.askedBehind`:
a window whose head is not its oldest row can match `askedBehind` where a
correctly ordered one would not, and skip the ask. If that is what does it, the
symptom on the old build is a reader who **stops short of their own history**
rather than one who sees it out of order — which is not what either issue claims
and is worse than what #494 describes.

**Run 18 walked it, and the guard does wedge.** `askedBehind` is armed before
the ask and disarmed by nothing but the page landing or a reconnect, so a page
that never lands — dropped, answered empty, or answered with only what the pane
already holds — leaves every later scroll refused for the rest of the run, on a
conversation still saying it has more. `docs/end-to-end-18/holdpage.py` swallows
the batch answering a `CHATHISTORY BEFORE` and passes everything else, so the
session stays up and only the page is missing; three walks a build separate 1
ask from 2, 3/3, the retry naming the same msgid ninety-three seconds later.
Fixed by disarming on the `waiting` outcome, which is the round trip already
spent. `docs/end-to-end-run-18.md`.

**The duplicate-batch route was the one that mattered, and run 27 walked it**
(#522). The sentence above understates it: that route needs no page to go
missing at all. The batch arrives, on time, carrying only rows the pane already
holds — which is what `CHATHISTORY LATEST` is, and what `PageBack::Deferred`
answers `true` for — and the window's oldest message does not move, so the guard
watching it stays armed. **The `waiting` disarm does not reach this**, the round
trip having completed, so "the fix covers them" was wrong about this one.

`docs/end-to-end-27/replaypage.py` is run 18's proxy with its decision inverted:
it replaces the answering batch's contents with the page the client was sent on
joining, rather than dropping them. Against the release app on `#scrollback`,
three walks a build: the build before the fix asks once and never again, 3/3,
with no line of any kind above the first message.

**The first fix was wrong and the walk is what said so.** Taking the guard off
the batch that answered it separated from the control — 26 asks against 1 — and
put #487 back: the same msgid 65 ms apart, seven of them from one over-scroll,
where #487's own bursts were 37 to 40 ms apart. The unit test written for it
asserted a second ask and passed, because jsdom's mock answers a page-back with
no event channel behind it. **A fix whose cost is a rate cannot be confirmed by
the instrument that found the state.**

What ships tells the two cases apart instead, `PageBackOutcome::Deferred` being
the fourth answer added for it: nothing went out and the first page is coming,
against the server answered and had nothing behind that message. The guard is
armed only for the second, and a page landing against it with nothing in it ends
the paging rather than restarting the asking. The shipping build asks once per
walk, exactly as the wedged control does — **the wire does not separate them and
the frame does**, one drawing "Beginning of history" where the other draws
nothing. `docs/end-to-end-run-27.md`.

What that leaves besides: how often a live network takes sixty seconds over a
page is not measured, #491's origin having taken 45. Neither does any of this
explain the count run 17 opened this thread with. Six asks a run against two was
measured between the #494/#496 builds, and the wedge above is on both of them.

**The chain is walked**, in `docs/end-to-end-run-28.md` (2026-08-14, release
build against a local ergo). Every paging walk before it was made on a channel
whose history ran out in two asks — run 17 said so and asked for one with a
dozen behind it, and the answer is that `#scrollback` has held eleven pages for
some time: `depth.py` asks the way the client asks and counts them, and what
binds is ergo's `history.channel-length` rather than the drift run 17 found. Run
that probe before trusting a paging count.

Ten links is what a count of asks cannot see. Six walks, three quiet and three
under thirty-two spinners, each made **10 asks under 10 distinct msgids, none
repeated and none unanswered**, ending on a 48-row page and the pane drawing
"Beginning of history" above the oldest line the server still held. A link asked
twice is #487 and a link that stops early is a reader left short of history that
exists; the chain has ten chances to show either and showed neither.

- **The empty-batch route is walked**, and `emptypage.py` is what it took: a
  page-back answered with an open batch, no messages and a close. It cannot be
  provoked from ergo here because 2048 events do not divide by a 200-message
  page, so the last page is short rather than absent — the same branch in
  `message.rs`, a different line on the wire. Three walks, one ask each, page
  size 0, the end of history drawn with ten pages still on the server behind it,
  and no second ask from a scroll that goes down and comes back up. The control
  under `--pass` asks twice on the same walk and draws no such line.
- **The ordering is as settled as a walk can make it.** Load moved the round
  trip from 2–4 ms to 8–19 ms and moved the chain not at all. Which of the two
  orders any page took is not on the wire and cannot be; both are asserted in
  the suite from either side and end in the same state.
- **What it does not claim** is a separation between builds. A pre-#522 build
  reads the same, necessarily: the wedge needs a page carrying nothing new and a
  real chain carries 200 new rows a link. Run 27's proxy is what separates them.

> A hole in the label sequence on a wire log is usually a keepalive. `session.rs`
> mints the PING token from the counter the request labels come from — `ircx8`
> against `label=ircx-8` — so `ircx-8` missing between two asks is a ping rather
> than a request the client composed and never sent. `chain.py` subtracts them.

**Run 17's count is explained**, in `docs/end-to-end-run-29.md` (2026-08-14,
release builds of `b75edf2`, `61a98fa` and `61d8b23` against the same ergo). Six
asks a run against two was never a build paging more eagerly. **The old build
stops.** On a second visit to a channel the pane opens on an empty timeline, asks
the archive with `before` null, and `load_history` answers with the newest page
it holds while the server's own `CHATHISTORY LATEST` is still landing — and in
that race the pre-#494/#496 build asks the server from the archive page's first
row and files that page in front of the window, which leaves `messages[0]`
naming what `askedBehind` names. The `#487` guard then answers every later
scroll with `"skipped"`, for the rest of the session.

The reader is left holding four hundred rows of a conversation the server has two
thousand of, with no "Beginning of history", no error and nothing loading —
which is the symptom run 17 feared and neither #494 nor #496 describes.

```text
                    walk to the top, 32 spinners      run 16's two bursts, 32 spinners
b75edf2 (before)    1 ask 3/3, stops ~2 pages in      1 1 4 4 1 2 4 4   (21 over 8)
61a98fa (after)     10 asks 3/3, start of history     4 4 4 5 4 4 4 4   (33 over 8)
61d8b23 (ships)     10, 10, and one walk that         4 4 5 4 4 4 4 4   (33 over 8)
                    never reached the top
```

Two things that reading is worth carrying.

- **Depth is what made it visible, not load.** The wedge fires on an idle machine
  too — the control's quiet arm is 10 asks, 1, 10, so one run in three against
  three in three loaded. Contention raises the rate; it is not the condition.
  What runs 18 to 28 lacked was a channel deep enough to tell a build that
  stopped after two asks from a build that finished after two.
- **At thirty-two spinners the walk is no longer reliable.** One `61d8b23` run
  delivered all fourteen bursts and left the scroller a third of the way down a
  window it had reached the top of twice before, which on the count alone reads
  as a wedge. The frame is what separates them: a wedged pane sits at the top of
  everything it holds with the seam above its last row, and that one had rows
  running off the top of the viewport. Read the frame before believing a count
  taken under load.

## The archive's own controls

Built and walked on 2026-08-01 (#241). Everything in `ircx-store` for this
existed and nothing reached it: `set_retention`, `prune`, `export_target` and
`delete_target` were referenced from no command, no Tauri surface and no screen,
and `prune` was called only by its own tests.

Walked in the app: the sheet reports `108 messages, 204 kB on this machine`, a
window is set and read back, deleting everything empties it while the networks
stay, and seven backdated messages were taken by the window on the next launch
with the sheet saying `7 were removed when ircx started`.

Two things the walk changed:

- **A delete left the words in the file.** SQLite keeps deleted rows in free
  pages, so an archive emptied from the sheet still read `236 kB` and the bytes
  were still on the disk for anybody reading the file. `delete_everything`
  vacuums, and the same walk now reads `120 kB`.
- **The console was the wrong home for the prune notice.** Pruning happens
  before any network exists, so there is no console to write to; and an
  app-level `Notice` is discarded by the frontend, which only renders the ones a
  session routes to a target. The count is on the archive sheet instead, which
  is where somebody who set a window goes back to.

**Keeping nothing is walked** (#249, 2026-08-01). A network set to
`Nothing — do not write it down` drew five arriving messages in the timeline and
wrote none of them: the archive held 61 before and 61 after, and none of the five
was in it. That is the setting working, and the sheet says so in the same breath
so a conversation that empties on close does not read as a bug.

**The export is verified**, on 2026-08-02, and it took a harness that can answer
a file dialog — `window.mjs`, which #348 added and which this was the first
thing to use. Both buttons, both files read back with `jq`.

`Export #export` opened a GTK save dialog pre-filled `#export.jsonl` with a
`JSON Lines` filter, defaulting to the checkout it was launched from. Saved to
`/tmp/ircx-export.jsonl`:

```text
lines 5, valid JSON 5, targets #export, networks walk, oldest first
kinds: 1 join, 2 privmsg, 2 server
the line typed into the composer a minute earlier, back out of the file
```

`Export everything` wrote 46 lines — **the same 46 the sheet had just claimed**
in `46 messages, 140 KB on this machine` — all valid, oldest first, 41 of them
console output against the network and the same 5 in `#export`. So the per-target
export is a subset of the whole one and the count on the sheet is the count in
the file.

**The sheet says where it went**, which nothing had seen either: `Written to
/tmp/ircx-export.jsonl — 3.3 KB.` appears under the buttons after a save.

Two things this cost, both about driving rather than about the export:

- **The success line reflows the sheet.** Adding `Written to …` moved both
  export buttons up 17px, so a click aimed from the screenshot before the first
  export missed the second button entirely. The `docs/end-to-end-run-4.md` rule
  — screenshot, click, let nothing arrive in between — has to include the app's
  own replies to what you just did.
- **A path typed into the dialog arrived mangled**, twice out of three: GTK
  drops keystrokes at the rate `xsend` was typing at. It looks exactly like the
  export failing, because GTK then reports a folder that does not exist. #349.

**What that walk did not reach was every way it can go wrong**, and the three
sentences the sheet keeps for those were written blind. Walked on 2026-08-02 —
`docs/end-to-end-run-5.md`:

- **A destination that refuses the write.** A folder at `chmod 500`, which the
  chooser accepts and `File::create` cannot use. Two defects, both fixed: the
  sentence read `Permission denied (os error 13)`, and the `Written to …` from
  the previous export was still on screen above it, so one sheet claimed the
  same action had both worked and failed.
- **A file already sitting where the export is aimed.** GTK asks, `Replace`
  rewrites it in place at the same byte count, and the client never sees the
  question.
- **A dialog dismissed.** No file, no error, and the sentence already on screen
  is left alone — `exportTo`'s null branch, which #167 separated from a
  rejection.

- **A write that starts and cannot finish**, which was down as unreachable
  until a pipe turned out to reach it: `mkfifo`, a reader that takes 4 KB and
  leaves, and `Export everything` aimed at the pipe. The first flush finds the
  reader gone and the write fails where a full disk would. Two more defects,
  both fixed: the sentence carried an errno again — `Broken pipe (os error 32)`,
  this one from `StoreError::Io` — and it **named no file at all**, because the
  store raises `Io` from a writer it was handed and never knew the path.

**A disk that genuinely fills is walked**, on 2026-08-07. The entry that stood
here said the pipe reached the same code and the same `io::ErrorKind` handling,
so what was untested was only whether `StorageFull` arrives where it is expected
to. It does, and it no longer takes a human to find out: the sentence is chosen
by `ErrorKind`, and every test that had ever checked it built the kind by hand.

`/dev/full` answers every write with `ENOSPC`, needs no privileges and is on
every Linux, so two ordinary tests in `src-tauri/src/commands.rs` now aim an
export at it. Both of the two paths a refused export can take are covered,
because they report through different code and had to be shown to agree: an
export short enough to sit entirely in the `BufWriter` fails when the file is
closed, through `into_inner`, and one long enough to empty the buffer while it
runs fails inside `export_everything`, through `gave_up`. Both say **"the disk
is full"** and both name the file.

What `/dev/full` cannot show is what a failure leaves behind, because it refuses
every byte where a real disk takes what fits. So a real one:

```text
unshare --user --map-root-user --mount sh -c '
  mkdir -p /tmp/smallfs && mount -t tmpfs -o size=8M tmpfs /tmp/smallfs
  IRCX_SMALL_DISK=/tmp/smallfs cargo test -p ircx --lib -- \
    --ignored --nocapture a_disk_that_fills'
```

An 8 MiB tmpfs in a user namespace, which also needs no privileges, and an
export of 50,000 messages wanting 24,427,780 bytes:

```text
the export wanted 24427780 bytes
it said: /tmp/smallfs/export-everything.jsonl was left part-written: the disk is full
it left 8388608 bytes at /tmp/smallfs/export-everything.jsonl
```

**The `ErrorKind` and the named file were right, and the frame around them was
wrong.** *"Could not be written"* is what the export said over a file with a
third of the archive in it. It was the one part of the sentence no earlier walk
could have caught: a `mkfifo` leaves nothing behind and a refused folder is
never opened, so until a disk actually filled, every failure this project had
seen really had written nothing.

So there are two sentences now, chosen by whether anything reached the file:

```text
…/export-everything.jsonl could not be written: the disk is full
…/export-everything.jsonl was left part-written: the disk is full
```

**The file stays.** JSON Lines truncates cleanly, so what arrived is readable to
the last newline, and on a disk with no room it may be the only part of the
archive that got out. Deleting it would also put a second thing that can fail
inside the handling of the first.

**No byte count in the sentence, deliberately.** `formatBytes` is TypeScript and
this string is built in Rust, so a size here means a second formatter that can
drift from the one the success sentence uses. The file manager already shows
what the file weighs.

**Which frame is chosen by how far the export got, not by what is on disk.** A
folder has a size, and so does a file that already existed and was refused; in
both the bytes are somebody else's, and reporting them as a part-written export
sends the reader looking for one inside their own directory.
`a_refused_destination_that_already_had_bytes_is_not_part_written` is that
mistake held off, and it does fail when the rule is inverted.

**Two things the run leaves.** On a disk with no room the partial file is now
the reason there is none — `df` reads 100% with 0 bytes free and the client
wrote every one of them. Retrying to the same name is safe, because
`File::create` truncates before it writes; retrying to a different one has less
room than the first attempt had. And that truncation cuts the other way: an
export aimed at a **file that already exists** destroys it before it starts, so
a failure leaves neither the export nor what was there before. GTK asks before
replacing and the user answers, so the consent is real — but "I said replace, it
failed, and now I have neither" is worth knowing about and is not what the
Replace button appears to promise.

**An export large enough to stream is walked**, on 2026-08-07, which is what run
5 asked for and what every walk before it had missed: 3.3 KB and 35 KB both fit
in memory whichever way the code is written, so neither could tell a stream from
a buffer. `docs/end-to-end-run-11.md`.

100,021 messages and 56 MB on the release app, three networks connected, on the
profile `startup.mjs` seeds. `Export everything` wrote 54,127,733 bytes —
100,021 lines, all valid JSON through `jq`, none out of order, all three
networks and all six targets present. `Export #measure` wrote 33,335, every one
of them that channel on that network.

**It streams, and the measurement is what says so** rather than the comment on
`export_archive`. Sampling the destination's size and `VmRSS` every 57 ms across
three runs: 52 MB left through 824 kB, 88 kB and 72 kB of resident memory, at
about 96 MB/s, with the file growing 6.9 MB a sample in a straight line. The
same app's RSS wanders 10 MB while sitting idle, so the export is below the
noise it would have to rise above to be buffering.

Nothing was found. The count on the sheet is the count in the file at five
figures as it was at two, the success sentence still replaces its predecessor
rather than stacking, and afterwards the networks are up, the lag reads 0 ms and
the composer sends.

What that leaves: **what the lock costs a search.** `export_everything` holds
`Store`'s mutex for the whole 563 ms, and `docs/measurements.md` lists the search
the same mutex serialises as excluded from every figure it has. Typing a search
inside that window is a walk nobody has managed.

## Recalling a sent line in the composer

Up and Down step back through what was already sent in a conversation. Where the
arrow recalls and where it only moves the caret is decided by the caret's own
position, and that is the part `npm test` cannot check: jsdom lays nothing out,
so it has no soft wrapping, no visual rows, and no native caret movement. Every
test sets `selectionStart` itself, which asserts the rule but not that a real
textarea puts the caret where the rule expects.

**The arrows against a laid-out box are verified** in Chrome on 2026-08-01,
driving the real composer with real key events. The window was the frontend on
the Vite dev server with a seeded workspace, and the four Tauri commands the
composer calls were stubbed, because there is no backend outside the app. Every
figure below was read off the live `textarea`.

- **A wrapped line keeps the arrow as a caret key.** 245 characters, no newline
  anywhere in it, laid out as two visual rows (`scrollHeight` 39 against a
  19.5px line). From caret 122 — the middle, and on the second row — Up left all
  245 characters untouched and moved the caret to 0. This is the case the rule
  was changed for: counting newlines calls 122 "the first line", so the old rule
  would have replaced the box mid-edit.
- **From the start it recalls.** One further Up, with the caret now at 0,
  brought back the last line sent and put the caret at its end.
- **Real newlines behave the same way.** `first row\nsecond row` with the caret
  at 15 moved to 7 — up one row, same column — and left the text alone.
- **Stepping back costs one press.** Up from an empty box gave the newest line;
  the next Up gave the one before it without the caret being returned to the
  start first. Both landed the caret at the end of the recalled line.
- **What was being typed comes back.** Down past the newest line restored all
  245 characters of the paragraph that recall had been started from.

**The same walk inside the app is verified**, on 2026-08-02, against WebKitGTK
rather than Blink. The rule holds in both engines.

Read differently, though, and the difference is worth knowing before anybody
repeats it. Nothing outside the process can ask WebKit for `selectionStart`, so
where the Blink walk quoted caret offsets, this one has only what the composer
draws — which turns out to be enough, because every case the rule distinguishes
either replaces the text or does not.

Two lines were sent, then a 247-character sentence with no newline in it was
typed, laid out as two visual rows in the real box. The caret was put in the
middle of the second row **by clicking there**, which is how a person would do
it:

```text
Up      247 characters still there   caret moved up a row
Up      247 characters still there   caret moved to the start
Up      "bravo two"                  recalled, the box replaced
Down    247 characters back          what was being typed, restored whole
```

From an empty box the steps are the same as the Blink walk found them: `Up` gave
`bravo two`, `Up` again gave `alpha one`, `Down` came back to `bravo two`, and
`Down` again left the box empty.

It takes one press more than the Blink walk did, and that is not an engine
difference. That walk set the caret to 122, which was the start of the second
row, so one `Up` reached position 0; a click into the middle of the row lands
mid-column and takes two. What both engines agree on is the thing the rule was
changed for: a wrapped line keeps `Up` as a caret key, and recall waits until
the caret is already at the start.

Nothing here is written to disk: the list is per conversation and lasts only as
long as the app is running, so a restart is expected to empty it while the
stored draft survives. That much was not walked either — the archive is one of
the things the dev server has no backend for.

## A message typed on several lines

`crates/ircx-core/tests/session.rs` asserts the split: one PRIVMSG per line,
blank lines dropped, a CR from another window's clipboard taken off. What it
cannot say is what a server does with the burst that comes out of a paste.

**It is walked in the application** on 2026-08-01 against local `ergo`, in
three parts, and read back with `CHATHISTORY` from a probe client rather than
off the sender's own screen:

```text
1) len=4    test                             typed, Shift+Enter between them
2) len=4    test
3) len=24   first paragraph line one         pasted, CRLF, blank line between
4) len=24   first paragraph line two
5) len=30   second paragraph after a blank
6) len=16   short first line                 pasted, a 704-char middle line
7) len=466  xxx…
8) len=238  xxx… END
9) len=15   short last line
```

Each group carries one timestamp to the millisecond, so each is one input
leaving as several messages rather than several submits. The blank line is not
a message, and no `\r` reached a trailing parameter.

The long line is the part worth keeping. 466 + 238 is 704 with nothing lost or
doubled, and the 466 was predicted before it was sent: `wire_budget` derives it
from the mask the server prepends, which for `syk__!~u@4dy55fkndsc9u.irc` in
`#test2` is 28 bytes of prefix and 18 of envelope against 512. So the wire
split still runs inside each line, which is where the old single-line splitter
and the per-line split had to agree.

The screen matched the wire in order and content, which is the half no test
reaches: the first piece goes back to the composer to draw and the rest arrive
as ordinary messages, so the two paths can disagree without a server noticing.

### The burst a paste makes

**Walked against Libera** on 2026-08-01: twenty numbered lines pasted into
`#ircx-walk` in one keystroke. All twenty arrived, in order, with no
excess-flood `NOTICE` and no `Closing Link`.

**Measure it from a second client.** Neither obvious way works, and both look
like they do. The sender's timeline draws the local copies the moment Enter is
pressed, because `say` hands them straight over and never waits for the socket.
The raw log is no better: `send_line` emits its `RawLine` before `Action::Send`
reaches the transport, so an outgoing entry records the queue rather than the
wire — and the log carries no timestamps at all. Arrivals at another client are
wire events and are the only thing here that is.

Read off a probe joined to the same channel, first arrival as zero:

```text
0.000s  line 01   ┐
0.055s  line 02   │  the burst
0.055s  line 03   │
0.055s  line 04   ┘
0.527s  line 05   ┐
0.993s  line 06   │  fifteen intervals, 497.7 ms each
  …               │
7.992s  line 20   ┘
```

Which is `rate_limit.rs` doing exactly what it says: a burst spent at once, then
one line per 500 ms. The pacing was asserted from the constants before this and
is measured now.

Four in the burst rather than five because the bucket was a token short when
the paste landed — a `PONG` or the composer's `+typing` TAGMSG will have taken
one, both of which go out through the same queue. That is also why the run
finished at 7.99 s against a 7.5 s prediction, and it is worth expecting rather
than reading as drift: the burst is whatever is left of the allowance, not a
fresh five.

### A paste that outruns the allowance

**A hundred lines is walked** against local `ergo` on 2026-08-01, timed off a
probe in the channel:

```text
 0.000s  001, 002, 003     the burst
 0.500s  004
   …
48.556s  100
```

All hundred arrived, in order, none lost. Ninety-seven paced gaps averaging
501 ms against a configured 500, and a burst of three rather than five for the
same reason the Libera run had four — the burst is whatever is left of the
allowance, not a fresh five.

So one keystroke takes the client the better part of a minute to send. **This
entry used to say the window looks finished while the socket is not, and that
was wrong.** `MessageRow` draws a `Pending` message at 0.55 opacity, and nothing
else in the row changes text brightness, so a draining paste is a hard boundary
marching down the list: solid above, faded below. Confirmed on screen at the
36/37 line about eighteen seconds in, which is where the probe's timings put the
front. It is legible at a glance and needs nobody to be told to look for it.

That used to be conditional, and #332 is why it no longer is. `say` filed a
local copy as `Pending` only where `echo-message` had been negotiated and as
`Sent` otherwise, and `Sent` was assigned at enqueue rather than at write — so
the boundary above existed only because both servers here happen to offer the
capability. A line now carries a ticket the transport reports back once it is
written, and `Pending` means "not on the socket" wherever it is drawn.

### A paste on a server that does not echo

**Walked on 2026-08-02** against local `ergo` with `echo-message` taken out of
its advertisement. Neither server here can be told to withhold a capability —
ergo has no setting for it, and `DEFCON` restricts registrations rather than
caps — so a proxy deleted the token from `CAP LS` on the way past. That is
enough on its own: `request_lines` asks only for the intersection of what was
offered with `SUPPORTED`, so the client takes the genuine "not offered" path
rather than a test-only one, and nothing in shipped code knows the walk is
happening.

Forty lines were queued by the network's connect commands, which is the only way
to drive the real window here — it takes no synthetic input, and a paste has to
come from somewhere.

The archive was sampled twice a second while it drained. Forty `pending` at
0.5 s, one turning `sent` every ~500 ms, none left by 20.75 s: the rate
limiter's pace, read off the same `delivery` column the timeline draws from. On
screen the boundary sat between lines 23 and 24 at twelve seconds and between 32
and 33 at sixteen — solid above, faded below, on a server where before this
every line was solid the moment it was typed.

**Cutting the connection mid-drain** is the other half. The proxy was killed at
eight seconds: fourteen lines had been written and stayed `sent`, and the
twenty-six still queued each drew *Not sent — not connected to Walk* with a
Retry beside it. Worth doing because nothing in the client had ever produced a
`Delivery::Failed` before, so `FailureNotice` had never once rendered against a
real message.

### What that run found

**A client's own messages come back doubled from history where the server does
not echo.** Every one of the forty was in the archive twice: the local copy,
`sent`, with no `server_msgid`, and a second copy carrying one, inside a
`batch=1` — a `CHATHISTORY` replay. The dedup keys on `server_msgid`, and the
only thing that ever puts one on a local copy is the echo. The comment above
`deliver` in `session.rs` predicted exactly this; it had never been seen,
because until this proxy nothing had run against a server without the
capability.

It is not #332's doing — a local copy had no msgid before that change either.
Filed as #333 and **fixed there**; the same run against the fix holds forty rows
for forty lines, each the copy the window drew with the server's msgid adopted
onto it.

The fix nearly went in on a false premise, which the walk is also what caught.
#332 knows when a line reached the socket, so matching that against the replay's
timestamp inside a second looked exact. It is not: `written_at` is on this
machine's clock and the replay's timestamp is on the server's, and here they
agreed only because `ergo` runs on the same machine as the client. Against a
server a minute out the match would never fire, and the failure would look like
nothing happening. The match is on the text, oldest copy first, with the clocks
compared only as a staleness bound.

**Both of what this left are now walked**, in the two runs below: a hundred-line
paste drained against a real socket, and the same paste cut partway through so
that more lines stranded than the pending cap holds.

### A hundred lines, and a hundred lines cut in half

Against local `ergo` through a transparent TCP proxy — the same `nocap.py` the
run above used, given a capability name nobody advertises so it relays and
nothing else, and can be killed to cut the link. One network whose
`connect_commands` join `#queue` and say a hundred lines and one more behind
them; no typing, for the reason the run above gives.

**The drain matches the model exactly.** A hundred and one lines took 48 s, and
the count of ours still `Pending` fell from 95 to 0 at almost exactly two a
second — the token bucket is burst 5 then one per 500 ms, and this is what that
looks like from the archive:

```text
t+0s    delivered  8   pending 95
t+10s   delivered 29   pending 74
t+30s   delivered 67   pending 36
t+47s   delivered 102  pending  1
t+48s   delivered 104
```

One line sat at `sent` for a second or so at a time in the middle of it, which
is a line written to the socket whose echo had not come back yet. Nothing
doubled: 101 `privmsg` for 101 lines said.

**The cut stranded 78 and lost none of them.** Killing the proxy 12 s in left
22 delivered, 1 written and awaiting an echo that never arrived, and 78 lines
that had never reached the socket. All 78 moved to `Failed` in the same second,
with `not connected to Queue`. Nothing stayed at `Pending`.

That is the pending cap's first real test. `track_pending` holds 64 and evicts
only entries that have been *written*, so a queue of 78 unwritten lines pushes
straight past the cap rather than dropping its oldest — which is what the
comment on it says it is for, and what stops a paste longer than the cap
stranding its first lines at `Pending` forever. It had never been run.

**The line that was written stays `Sent`.** `paste line 023` reached the socket
and its echo died with the connection, so it is terminal at `Sent` rather than
`Delivered`. That is true rather than wrong — it was sent — but it is worth
knowing that a cut leaves one line in a state that never resolves.

### What it found

**A cut mid-paste draws a wall of identical failures.** Seventy-eight
`FailureNotice` rows, each repeating `Not sent — not connected to Queue` and
each carrying its own Retry, for what the archive records as exactly **one**
distinct reason. Recovering the paste means seventy-eight clicks. Filed as #341;
the deepest run before this stranded 26 lines, which is a size the component is
fine at.

**Fixed in #341**, and the fixed screen was looked at the same way — the driver
seeded with the 22 delivered and 78 failed this run produced. One notice, one
Retry, and the other 77 lines marked in the column the reply controls would have
used, which costs no height: the pane holds 22 messages where it held 13. The
mark keeps its own line at every pane width, the column being a fixed 60px that
does not shrink with the measure.

**A real cut drew it on 2026-08-02**, which until then had only ever been a
seeded copy of one: forty lines pasted into `#walk` and `ergo` killed four
seconds in left twelve delivered and twenty-eight failed, under one notice
reading `28 messages were not sent — not connected to ergo`. The `Retry` sent
all twenty-eight again in order. `docs/end-to-end-run-4.md`.

**The fade says nothing during a paste.** #339's premise turns out to be
stronger than it was argued. A queued message is drawn fainter, which is a
signal only against an unfaded row to compare it to — and in a draining paste
every row on screen is queued, so there is nothing to compare against and the
fade conveys nothing at all. The composer's count is doing the whole job.

### How much of this was the assembled app, and how much was not

Less than the runs above, and the reason is worth recording so the next walk
does not lose the time to it.

**The real window never opened the conversation.** `connect_commands` join a
channel and register it in `open_targets`, but a pane is only opened by a
person, and the pane tree lives in the webview's `localStorage` rather than in
the archive. So the window sat on "No conversation open" for both runs while the
paste drained correctly underneath it. There is no input injection here — no
`xdotool`, `ydotool` or `wtype`, and the WebKit local storage is not reachable
from outside the process — so nothing could open it.

**That sentence was wrong about the machine**, and the fourth run found it out.
No injection tool is installed, but `gcc`, `X11/extensions/XTest.h` and
`libXtst` all are, and a hundred lines of C over `XTestFakeKeyEvent` types and
clicks into the real window. What was missing was a program, not a capability.
`docs/end-to-end-run-4.md` says what it takes, including the `GDK_BACKEND=x11`
without which the window opens on the operator's desktop instead of on `Xvfb`.

Everything above about delivery states is therefore read from the archive, which
is the same fact the timeline draws from, and none of it is read off the screen.

**The two screens were checked separately, in the walk driver**, seeded with the
exact states these runs produced: 95 pending in one conversation and the 22/1/78
of the cut in another. That is a real browser and the real frontend with a faked
backend, so what it shows about layout is worth having and what it shows about
timing is not. The composer draws `95 waiting to send` in the hint row, and the
live region holds `Messages waiting to send`. The failure screen is #341.

**Nobody has yet seen the count change against a real socket**, because that
needs the window and the window could not be opened. It would take input
injection, or a way to restore a pane from the archive rather than from
`localStorage`.

**The window opens one itself now** (#343), which was neither of those. A pane
was only ever opened by a person, so the autojoin that `connect_commands` runs
filled the sidebar and left the window on "No conversation open" — the whole of
why these runs were read out of the archive. An empty window now takes the first
conversation there is, so a run that connects has the channel on screen without
anybody clicking. Seen in Chrome through the walk driver: the same seeded
workspace draws "No conversation open" and no composer before the change, and
`#ircx` with its roster and composer after it, on `goto /` and nothing else.

What that does not settle is the run itself. Chrome is not WebKitGTK and a
seeded backend is not a socket, so what is established is that the rule fires
and which conversation it picks — not that the assembled app comes up in a
channel against real `ergo`.

**That run happened the same day**: `docs/end-to-end-run-4.md`. The app came up
in `#walk` on its own in WebKitGTK, and everything this section says nobody had
watched was then watched. `31 waiting to send` in the composer's hint row three
seconds into a forty-line paste, every visible row at the pending fade; a cut
four seconds into a second one leaving twelve delivered and twenty-eight failed
with nothing lost between them; one notice reading `28 messages were not sent —
not connected to ergo` with one `Retry`, and the other twenty-seven rows marked
in the reserved column. The `Retry` was clicked and all twenty-eight went again,
`53` through `80` in order, five at once and then one every 500 ms.

The two conditions were the window opening itself and typing into it, and the
second is worth reading before the next run: **this host does have input
injection**, which the note below saying it has none was wrong about.

### The queue, heard rather than seen

#339 gave a queued message something other than the fade: a count in the
composer's hint row, a `role="status"` region that speaks when a queue forms and
again when it is gone, and `Waiting to send` inside the row itself for a reader
who arrives at one.

**What was checked**, in Chrome through the walk driver: the region resolves to
a genuinely hidden 1×1 clipped element, so it disturbs nothing; and the count in
the hint row does not wrap the row at any width the hint itself does not already
wrap at — both wrap below about 220px, which is the hint's own doing and older
than this.

**Half-answered on 2026-08-03, and the half that is answered is the app's**
(#388). Walked with Orca 49 against the assembled app, the GNOME a11y bus on and
the app started after it.

**What the app does is right, and is measured now.** Walking the AT-SPI tree with
`pyatspi`, the composer's `role="status"` region is published, advertises
`live: polite`, and its text changes at both edges of a forty-line paste:

```text
17:08:06  region -> 'Messages waiting to send'
17:08:44  region -> 'All sent'
```

Thirty-eight seconds apart. The typing region behaves the same way. So the DOM
shape the tests assert does survive into the accessibility tree, with the right
politeness and the right text at the right moments. That is more than was known
before, and it is the part to keep.

**A screen reader is not told, and there is a control for it now.** The first
runs were taken with the window unfocused, which proves nothing — Orca's log
named `plasmashell` as the application it was tracking, and it suppresses live
regions for unfocused applications. Focused, and with a control on the same
machine, the comparison is clean.

The control is a page with two live regions updating every six seconds — one
visible with `aria-live="polite"`, one carrying Tailwind's exact `sr-only` rules
with `role="status"` — in Chrome, which needs `--force-renderer-accessibility`
before it publishes anything at all. Counted out of Orca's own log:

```text
                                    speech   braille   event seen
Chrome, visible aria-live              17       72        yes
Chrome, sr-only role=status             0       38        yes
ircx, visible typing region             0        0        no
```

Two separate things fall out of that.

**Nothing from ircx reaches Orca.** Not speech, not braille, not the event. In
Chrome the same shape of region is received and brailled even when it is not
spoken, so the client is not merely losing an announcement — it is not emitting
one. That is a real difference between the two engines rather than a setting.

**And `sr-only` suppresses speech even where it works.** Chrome's clipped region
was received and brailled and never spoken. So the composer's queue
announcements — the two sentences this whole entry is about — carry `sr-only`,
and even if their events did arrive they would reach braille and not a voice.
The typing indicator does not carry it, which is why it is the fair comparison
above.

Two disproven guesses, both worth not repeating: that React creating the text
node rather than mutating it was the cause — a permanently non-empty text node
changed nothing, verified live through HMR — and that `sr-only` was what stopped
the events, which the visible typing region rules out.

Also unheard, and unhearable here: whether the two sentences work *as a pair*.
This machine has no audio hardware, so what was captured is what Orca would have
spoken rather than what it sounded like.

### Why nothing arrives, measured without a screen reader in the way

**2026-08-03.** The runs above go through Orca, which can only report what it
was handed. This one reads the AT-SPI bus directly with an `Atspi.EventListener`
and no screen reader running, so "no announcement" and "no event" stop being the
same observation.

Five regions were mounted in the running app, differing only in the thing under
test: `aria-live="polite"` present from the first paint, the same mounted eight
seconds later, `role="status"`, a plain paragraph with no ARIA at all, and one
whose child is keyed so React replaces the element instead of rewriting its text.
Each rewrote itself every four seconds.

**The tree is right.** All five are in it, at the right depth, carrying the right
attributes — read off the live bus:

```text
paragraph   'first paint 38'    live=polite  container-live=polite  container-relevant='additions text'
status bar  'status 238'        live=polite  container-live=polite  container-atomic=true
paragraph   'plain 338'         (no live attributes, as written)
```

**The events are not.** Over a 60-second window in which those regions rewrote
themselves more than forty times, ircx emitted **no `object:text-changed` for any
of them** — the last event of any kind came at 16.4 s, from typing into the
command palette. The same listener against Chrome on an equivalent page counted
`text-changed:delete` and `text-changed:insert` on every single tick.

What ircx does emit says the bridge is alive rather than broken:

| what happened | what reached the bus |
|---|---|
| typing `hello` into the palette | five `object:text-changed:insert`, one per keystroke |
| the palette opening | `object:children-changed:add` across the dialog's subtree |
| a live region rewriting its text | nothing |
| a `role="status"` rewriting its text | nothing |
| a plain paragraph rewriting its text | nothing |
| a keyed child being replaced outright | nothing |

**So it is not a live-region problem and no ARIA change fixes it.** WebKitGTK
reports text a person typed into a form control, and does not report text the
page wrote — with or without `aria-live`, with or without `role="status"`. The
last row is the one that closes the obvious escape: forcing React to unmount and
remount the child, rather than mutate its text, is also unreported, so the
structural workaround is not available either.

**Controlled three ways**, because the earlier rounds of this issue produced four
wrong conclusions between them:

- *The listener works.* Registered against Chrome first: 75 events, including the
  live region's text. An `Atspi.EventListener` that is registered and then
  dropped is garbage-collected and silently hears nothing, which produced one
  false zero here before it was caught.
- *The app is on the bus.* `ircx` appears among the desktop's applications and
  its subtree is walkable, so the silence is not an unregistered application.
- *The text really changed.* The probe text was read off the bus before and after
  the listening window — `first paint 0` → `first paint 10`, `status 200` →
  `status 210`, and so on for all four — while 267 events from other applications
  crossed the bus in the same window. The silence is about mutations that
  demonstrably happened.

Not established: the precise rule WebKitGTK follows. Both events it *does* emit
came moments after a keystroke, so "only input-driven updates are reported" fits
the data, and so does "text mutation is never reported, structural insertion
sometimes is". Telling them apart needs a probe that mutates text in direct
response to a key, and would not change what this costs — a message arriving from
the network is not input-driven either way.

### The way out, which is not in the page at all

**2026-08-04.** The finding above is right and the conclusion drawn from it was
too wide: no *ARIA* workaround exists, which was read as no workaround. The
announcement cannot leave through the page. It can leave through the window.

**Why the page is genuinely closed**, now traced to source rather than inferred
from silence. WebKit's `AXObjectCacheAtspi.cpp` handles nineteen notifications
in `postPlatformNotification` and a live region changing is not among them — it
reaches `default: break;`. The text signals it does emit come from the editing
pipeline, `postTextStateChangePlatformNotification`, which is why a keystroke
into a control is reported and nothing the page writes ever is. That accounts
for every row of the table above without appealing to an unknown rule.

Orca closes the other end independently. `live_region_presenter.py` returns
False for anything that is not `object:text-changed:insert`, with a comment
saying so deliberately — user agents fire both children-changed and
text-changed, and answering to both double-presents. So the one event Orca will
act on for a live region is the one WebKitGTK will never send. Mounting a real
accessible object to force `children-changed` was the obvious remaining trick
and it dies here even where it works.

**`object:announcement` is not subject to either.** Orca registers it in
`script.py` and speaks it unconditionally — `present_message(event.any_data)`,
no live-region check, no politeness queue, no focus rule. ATK carries an
`announcement` signal on every `AtkObject`, and this window is GTK3, so the
window's own accessible can emit one. Measured on the bus, both halves:

```text
announcement [emitter.py] 'announcement 4'      <- control, still running
announcement [ircx]       'Messages waiting to send'
announcement [emitter.py] 'announcement 5'
announcement [ircx]       'All sent'
```

The ircx lines are the composer's two queue sentences, from the assembled app
against a local `ergo`: twelve lines sent as one message, `4 waiting to send` in
the hint row at the moment of the first, the second arriving when the last had
gone. `src-tauri/src/announce.rs` is the mechanism and `commands::announce` the
command; the DOM region stays, because it is what a browser reads and what the
walk driver asserts.

**Two false zeros were produced getting here**, both looking exactly like the
real finding. The first: `at-spi-bus-launcher` came up with no registry behind
it, so the emitter logged `Could not obtain desktop path or name` and nothing
reached anything — fixed by pinning `AT_SPI_BUS_ADDRESS` from `org.a11y.Bus` and
starting `at-spi2-registryd` explicitly. The second: `ergo` resolves `languages`
against its working directory, so started from elsewhere it exits before it
listens; the app spent that run reconnecting, never drew a composer, and
reported zero announcements from a path nothing had walked. The control in the
transcript above — a GTK window announcing on a timer for the length of the run
— is there so a zero from ircx can be told from a watcher that was never
listening. Any future run of this should keep it.

**What is still unheard.** Nobody has listened to this with a screen reader
actually speaking; what is established is that Orca receives it and that its own
code path speaks what it receives. The questions #339 left — whether the two
sentences read as a pair, whether `Waiting to send` belongs before or after the
text — are unchanged and still want an hour with audio hardware.

**The rest of the client still announces into the page alone, and it divides in
two.** The typing indicator rewrites the text of a live region, which is the
shape measured silent above — no event of any kind. The `role="alert"`
paragraphs are a different case and were nearly filed as the same one. They are
mounted rather than rewritten, and an insertion *is* reported: driving a refusal
in the assembled app put `object:children-changed:add -> notification ''` on the
bus, alongside the header and buttons of the channel that had just opened.

What that does not reach is Orca. WebKit maps an ARIA alert to the AT-SPI
`notification` role, and the branch that would present it —
`scripts/web/script.py`, `is_alert(event.any_data)` — tests for `Role.ALERT`,
which is the dialog. Read from source rather than heard, so what is measured is
that the event arrives and what is inferred is that nothing acts on it.

### Routing the rest, and the two things left out of it

**2026-08-04**, #397. Every `role="alert"` in the client now calls `useAnnounce`
alongside the markup, which stays: the ARIA is correct, it is what a browser
reads, and it is what the walk driver asserts. Twenty alerts across seventeen
components, and two deliberate omissions.

**The typing indicator does not announce.** It is the one region here whose
whole purpose is peripheral — it changes constantly and says little, and
"somebody is typing" repeating through a busy channel is the noise the queue
design already refused when it kept the count out of its own live region. Drawn
only, on purpose, so that a later reader does not file it as an oversight.

**The alert inside the upload dialog does not announce either.**
`DropToUpload.tsx` draws its refusal inside a `role="dialog" aria-modal`, and a
dialog is presented on its own when it opens. Announcing the paragraph as well
would say it twice. The rule that falls out: announce an alert that appears in
place, not one that arrives as part of something already announced.

Seen on the bus from the assembled app, a refused command in `#a11y`:

```text
[ircx] object:announcement -> `/nonsensecommand` is not a command ircx knows. `/help` lists the ones it does.
```

Which is the same sentence the screenshot shows in the composer, now leaving by
both routes.

### The other kind of live region

**2026-08-07.** The section above says what it did precisely: every
`role="alert"`. A `role="status"` is the other half of the same problem and was
never inside that scope. The client has two of them.

`Composer.tsx` routes its queue status through `useAnnounce`, and those are the
very sentences the bus capture above is of — *Messages waiting to send*, *All
sent*. `ArchiveSheet.tsx` did not route its own. It called `useAnnounce(error)`
beside its `role="alert"` and left the `role="status"` next to it on the markup
alone, so **every way of failing spoke and nothing that worked did**:

- `Written to …/export-everything.jsonl — 52 MB.`
- the retention sentence, after a change to how long messages are kept
- `The whole archive deleted. There is no undo, and there was none.`

In this window that is silence rather than a quieter announcement, for the
reason traced to source above: WebKitGTK reports nothing at all for text the
page rewrites, and the status paragraph is a `<p>` whose `textContent` changes.
The markup states an intent the engine does not carry out, which is why the side
channel exists at all.

`useAnnounce(said)` is the whole fix. `succeeded` and `failed` clear one
another, so only ever one of the pair has anything to say and there is no double
announcement to avoid. Two tests in `ArchiveSheet.test.tsx` hold it: the export
that worked, and the delete that cannot be undone — which is the sentence on
this sheet it most matters to have heard.

**Read from source and covered by test rather than heard.** It is the same call
on the same hook that the composer's status makes, and that one is measured on
the bus above, so what is unmeasured here is the wiring rather than the
mechanism.

**It is also a layer below the question run 11 left open.** That run asked
whether the sheet's `role="status"` sentence had ever been heard. For this sheet
the answer was that no announcement was being sent to hear.

**The rest of the non-alert regions, so the count is closed.** Beyond the two
statuses there are two more live regions in the client and both are silent on
purpose. `TypingIndicator.tsx` carries the `aria-live` the section above already
argues should stay drawn only. `RawLog.tsx` carries a `role="log"` on the raw
protocol scroller, which is every line off the wire — the same argument and
harder: a reader who wants that pane is reading it, and announcing it would talk
over everything else in the window. Neither is an oversight, and with the
archive sheet routed there are no live regions left that are quiet by accident.

## Focus in a modal

**2026-08-04**, #399. Nine dialogs declare `role="dialog" aria-modal="true"`,
which tells a screen reader the rest of the page is not there. The keyboard had
not been told, and this is what it did about it.

Walked with `.claude/skills/run-ircx/driver.mjs`, which is the only instrument
that can answer the question: jsdom implements no sequential focus navigation,
so a `keydown` of `Tab` moves nothing there, and every vitest assertion about a
dialog's focus is an assertion about what the code decided rather than what a
browser did. `src/hooks/useDialogFocus.test.tsx` covers the first; only a walk
covers the second.

### What it was

Tab out of the appearance sheet on `main` at `2a8373b`, one keystroke at a
time. Eight stops belong to the sheet. The ninth does not:

```text
step  inside  what has focus
   8    yes   Read                       ← the last of the sheet
   9     NO   body
  10     NO   Open command palette
  11     NO   Minimise
  12     NO   Maximise
  13     NO   Close
  14     NO   Add a network
```

Steps 11 to 13 are the window's own titlebar. The palette took two Tabs to
reach the same place. Closing any dialog left `document.activeElement` on
`<body>`, so the way back to what the user was doing began at the top of the
document.

### What it is

Every dialog now runs `useDialogFocus`. Walked after the change: 20 Tabs each
in the plugins, archive, upload-provider and search dialogs, 25 in network
setup, 30 in appearance — **no keystroke left any of them**, the ring turning
around at the last stop instead. Each was opened from the header's palette
button, and each put focus back on it when Escape closed it.

Two things the walk decided rather than confirmed.

**The palette's query field lost focus to a fix meant to protect it.** The dev
server runs under `StrictMode`, which mounts every effect twice, and a restore
that ran synchronously in the cleanup moved focus out of the palette between the
two mounts — leaving the container holding focus and the field unable to be
typed into. It is why the restore is deferred by a microtask and skipped when
anything is open by the time it runs. Worth knowing generally: a walk is a walk
of the development build, and an effect that is not idempotent behaves there in
a way it never will in the shipped app.

**A sheet opened from the palette had nothing to go back to.** The palette
closes as the sheet opens, so the field that had focus is unmounted before the
sheet is — the sheet restored to a disconnected element, which is to say to
`<body>`. A dialog opened while focus is inside another now inherits that one's
opener, and Escape out of a sheet reached through `Ctrl+K` lands on the button
the user started from. That is the client's ordinary path, not an edge of one.

### What the browser walk did not reach

- **The channel list.** It opens on a `/list` answer, which the driver's seed
  does not serve. It is the same call as the four sheets that were walked —
  container focus, Escape, no field of its own — so what is unwalked is the
  wiring rather than the behaviour.
- **The two dialogs in `DropToUpload`.** They need a real file drop, which
  Tauri delivers and the browser cannot. They are covered in jsdom instead, for
  the half jsdom can see: the confirmation takes focus when it appears, and
  Escape cancels it. Their Tab ring is unwalked.

### The same walk in the engine that ships

**2026-08-04.** Everything above is Chrome, and #388 is what happens when
Chrome is taken to speak for WebKitGTK. So the walk was run again against the
assembled app on `Xvfb`, reading focus off the AT-SPI bus rather than from a
selector — which is what the window has instead of one.

Both builds were driven identically: Tab once to put focus on something, `Ctrl+K`,
open Appearance, twelve Tabs, Escape. `main` at `2a8373b` is the control, and it
is what makes the after run mean anything: an instrument that reports focus
inside the dialog and nothing else would look the same as a working trap.

```text
              main (2a8373b)                     with the hook
opener        button 'Open command palette'      button 'Open command palette'
sheet open    dialog 'Appearance'                dialog 'Appearance'
tab 1-8       the sheet's eight controls         the sheet's eight controls
tab 9         nothing focused                    button 'Close appearance'  ← wraps
tab 10        button 'Open command palette'      toggle 'ircx Dark'
tab 11        button 'Minimise'                  button 'Edit the colours…'
tab 12        button 'Maximise'                  toggle 'ircx Light'
Escape        button 'Maximise', sheet open      button 'Open command palette'
```

Every chain in the right-hand column runs through `dialog:'Appearance'`. The
left-hand column leaves it at the ninth Tab and reaches the window's own
titlebar at the eleventh, which is the Chrome result to the keystroke.

`focus-in-modals/01-escape-reaches-nothing.png` is that state photographed on
`main`: the sheet still open, because Escape reached whatever had focus rather
than the dialog, and the **Maximise button focused with its tooltip up** while a
modal is on screen. `focus-in-modals/02-focus-comes-back.png` is the same moment
with the hook — sheet closed, focus ring back on the `Ctrl+K` button that opened
it.

So the restore survives the palette hand-over in WebKitGTK too, which is the
part that needed watching: it is the one behaviour here that depends on effect
ordering rather than on the browser.

**Four things the instrument needed**, all of which produced a wrong answer
first:

- **The bus the desktop advertises was dead.** `org.a11y.Bus` handed back
  `/run/user/1000/at-spi/bus_0` and connecting to it was refused. A private
  `dbus-daemon --config-file=/usr/share/defaults/at-spi2/accessibility.conf`
  with `at-spi2-registryd` started explicitly against it is what worked — the
  same shape as the false zero this file already records for announcements.
- **`GTK_MODULES=gail:atk-bridge` is required.** Without it the app never
  reaches the bus at all and the desktop has no applications on it. Nothing
  says so; the tree is simply empty.
- **A GTK control window is no use for focus.** There is no window manager on
  the `Xvfb` display, so a second window is never activated and emits no focus
  events however often it calls `grab_focus`. ircx emits them because with no
  window manager X input focus lands on it by default. The control here is
  therefore the `main` build rather than a second application, and a focus run
  cannot borrow the emitter the announcement runs used.
- **The focused chain is focused all the way down.** The frame's scroll pane
  carries `FOCUSED` exactly as the button inside the web view does, so a walk
  that stops at its first match reports the scroll pane every time and the
  answer never changes. Take the deepest.

### What the WebKitGTK run did not reach

- **A release build.** Both builds above are debug against Vite, which means
  `StrictMode`, which means the harder case rather than the shipped one — the
  restore is the code path that behaves differently under it, and it is the one
  watched here. What is unwalked is the easier path.

## Desktop notifications

Nothing in the suite raises one. `worthNotifying` is tested for every reason it
stays quiet — muted, watched, replayed, the reader's own line, each switch on
its own — and that is the whole of the decision. What was unverified is
everything after it.

**Most of it is now walked, on Linux** (`docs/end-to-end-run-21.md`, 2026-08-12,
release app against `ergo` 2.19). The entry used to say this needed a person
because a notification ends up on somebody's screen. It does not need one to
answer whether the call was made and what it carried, because a notification is
a D-Bus method call first: `notifyd.py` owns `org.freedesktop.Notifications` and
records every `Notify` the client sends down the path a desktop's own daemon
sits on.

What that run settled:

- **The call is made, and it carries the conversation.** `app` is `ircx`,
  `summary` is `phrack in #harness` for a channel and `phrack` alone for a
  query.
- **The focus rule, in both directions.** The same line from the same client
  raises nothing while the window has focus and one notification when it does
  not, one `XSetInputFocus` apart and nothing else changed.
- **Twenty at once are twenty notifications**, inside eight milliseconds, none
  dropped and none coalesced by the client.
- **On Linux there is nothing to grant.** No dialogue between the click and the
  notification.

**They arrive out of order**, and this is the path's rather than the client's:
`sendNotification` returns `void`, so there is nothing to await and no handle on
the ordering. Twenty sent in sequence reached the bus as `2, 1, 3, 4, 6, 7, 5,
…` while the timeline held them in order. Ordering them means notifying outside
the plugin, per platform — the same larger thing the click target needs, below.

**What still needs a person:**

- **What a desktop does with one.** `notifyd.py` draws nothing, so how a real
  daemon renders a notification, how long it stays up, and whether it coalesces
  twenty are all unwatched.
- **macOS.** The first `requestPermission` there is a system dialog, and run 21
  was Linux.
- **A real refusal.** The page is tested against a mocked one and there was
  nothing on this desktop to refuse with.

**What cannot be made to work, and is not a bug here:** clicking a notification
does not open the conversation. `tauri-plugin-notification`'s desktop path is
`notification.show()` and nothing else — no `actionPerformed` is ever emitted,
so `onAction` is mobile-only. The notification names the conversation for that
reason. Making it clickable means notifying outside the plugin, per platform,
which is a larger thing than this feature is.
