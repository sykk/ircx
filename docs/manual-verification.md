# Manual verification

Things no agent can check, because they need a real account or a human watching
the assembled app. Nothing here is covered by `cargo test` or `npm test`.

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

- **Mechanisms other than PLAIN.** Libera also offers `EXTERNAL`,
  `ECDSA-NIST256P-CHALLENGE` and `SCRAM-SHA-512`. ircx requests PLAIN only.

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

- **Netsplit recovery.** Nothing can provoke one politely, and none happened
  during either run. The member list half is now scripted instead:
  `a_netsplit_takes_its_half_of_the_channel_and_gives_it_back` in
  `crates/ircx-core/tests/session.rs` divides a hundred-member channel with a
  burst of QUITs carrying a split reason, brings them back with a burst of
  JOINs and a second NAMES, and asserts nobody is lost, doubled or stripped of
  their rank. A rejoin arriving before the QUIT that explains it has its own
  test.

  What that leaves is what a hundred arrivals at once look like: the timeline
  folds presence into a digest and the roster re-renders per change, and neither
  has been watched under a burst. Whoever is next in a channel when one happens
  should look at those two rather than at the membership, which is settled.

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

**On Libera it will not work**, and the client cannot tell in advance. Client
tags there are an allowlist holding only `+typing`, and `message-tags` is
negotiated all the same — so ircx attaches `+reply`, draws the quote on the
sender's own copy, and Libera strips the tag before anyone else sees it. That is
exactly the position reactions are in, and for the same reason.

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

What that leaves is the refusal seen from inside the window rather than from a
test. A link that redirects across sites should say where it would have gone and
not go there; `http_loopback.rs` asserts that against a server it controls and
nobody has watched the sentence land in a conversation. The same goes for a link
too large for the cap, and for what the timeline does with a fetch that fails.

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

What is still open:

- **The topic path.** `##test` has no topic set, so no run has seen one. Core is
  covered — `session.rs` feeds `332` and asserts what the header is told — so
  what is left is narrower: that the header draws a topic it is given, and that
  a `/topic` typed by the user comes back from the server changed. Whoever is
  next in a channel that has one should look.
- **Independent scrolling between split panes.** `PaneTree.test.tsx` asserts
  both halves — two panes on one channel restore their own positions, and
  scrolling one leaves the other's alone. jsdom lays nothing out, so those
  positions are numbers rather than pixels; what is left is whether two panes
  scroll apart on screen. The first run's panes held three rows each and the
  second never split.
- **The lock icon in the sidebar.** `isRestricted` reads the channel's mode
  flags and `##test` drew a lock. There is no way to see a channel's modes in
  the interface, so nobody knows whether that lock is right.
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

  What is left is a netsplit, which is the other burst this entry was written
  for and which nothing has yet seen. It differs from a `LIST` in a way that
  matters: a `LIST` is one numeric that now bypasses the timeline, where a split
  is thousands of QUITs and JOINs that each legitimately belong there.

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

- **The seam between the pane header and the roster.** The roster's own header
  is empty and carries the same height and rule as the pane header beside it, so
  the line under that header should run straight on into the roster. Nothing
  measures that. If the two rules are a pixel apart the roster reads as
  application furniture parked next to the conversation, which is the thing this
  replaced.

- **A narrow pane was watched, and it was worse than this entry guessed.** A
  `Ctrl+\` split on a 1194px window gave the roster about 45% of each pane and
  wrapped `/help` mid-phrase — #114. The roster no longer takes a fixed column:
  it asks for the longest name it holds, between a 7rem floor and the 13rem it
  used to always take. What is left to watch is a channel whose nicks are long
  enough to reach that ceiling, where the old problem returns in miniature.

- **A large channel.** The second Libera run read `#libera`'s member list across
  31 replies, so it is the size of channel worth trying. `MemberList` renders
  the list it is given, and one roster per pane means two of those rendering at
  once, each re-rendering as members come and go. Both end-to-end runs split
  panes on quiet channels, so nothing has drawn two busy rosters together.

## Resizing a split

`PaneTree.test.tsx` drives the divider with a mocked rectangle, because jsdom
lays nothing out. So every figure in those tests is one this file supplied, and
what nobody has done is drag one.

- **Whether the divider can be hit.** It draws a one-pixel rule inside a
  four-pixel target. Four pixels is a guess at the smallest thing a pointer can
  reliably catch, checked against nothing.

- **A nested split.** Dragging an outer divider changes the space its children
  divide, and each child's own ratio then applies to the new width. That falls
  out of the tree rather than being arranged, so it is worth watching a
  three-deep layout rather than assuming it.

- **The 15% floor.** It is a share of the split, not a width, so on a narrow
  window 15% of half a window is a very small pane — and the roster inside it is
  a fixed 208px that will not shrink. Drag one all the way in on a small window
  and see what the conversation has left.

- **Where a resize goes when the app closes.** Nowhere: the layout tree is not
  persisted, so a restart is back to even halves. That is what today's code
  does, not a decision anybody made — `viewState.ts` persists the sidebar width
  and the collapsed networks, and the layout could join it.

## Plugins

The failure modes are covered by `crates/ircx-plugin/tests/failure_modes.rs`,
which asserts that the host survives each one. What no test reaches:

- **The unresponsive backstop.** If a plugin's thread never comes back, the host
  stops waiting after the call deadline plus its grace, abandons the thread and
  carries on. Nothing in the current host surface can produce that: the only
  function that waits is `ircx.fetch`, and it is bounded by what is left of the
  same deadline. The path exists for the next host function that waits, and it
  is reachable only by making one misbehave.
- **A plugin's request crossing a real socket.** The permission tests give the
  sandbox a fetcher that answers without a network, so what they cover is the
  grant, the host list and the budget. The socket underneath is `ircx-net`'s and
  is covered by its own tests, but nothing exercises the two together.
- **Cancelling the folder picker.** Installing through the native dialogue is
  verified — two plugins went in that way on 2026-07-30 — but nobody has
  cancelled one. It should leave the library alone rather than installing
  nothing under a blank name.
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
- **Picking a folder that is not a plugin.** The likeliest mistake with a
  picker, and the one whose message was rewritten for #89. Choosing a folder
  with no `plugin.json` should say which file it went looking for.

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

### Still open

- **Groups chain.** Addressing somebody already in a group joins that group, so
  a run of people answering each other within reach never closes. One round
  drew five messages and two separate question-and-answers as one group. It did
  not recur in the last round — ordinary chatter breaks the chain — but the
  mechanism is there, and it is the shape of the failure that took guessing out.
  Worth measuring on a channel busier than three people before trusting it.
- **Declared grouping has never been seen outside a fixture.** No other client
  reads a `[topic]` prefix, so nothing types one. It is exercised by tests and
  by the preview harness and by nothing else.
- **Whether the split reads as stutter.** A run that spans two groups is broken
  in two, repeating the name and the time. It did not come up in these rounds
  because it needs somebody to say two things about two conversations in one
  breath.

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
- **S3-compatible storage**, which is built and has never sent a byte.
  `src-tauri/src/sigv4.rs` is checked against the worked example AWS publishes
  for a single-chunk `PUT` — their credentials, their bucket, their clock,
  their answer — so the arithmetic is not in doubt. Everything around it is:
  whether the region a provider expects is the one it documents, whether the
  endpoint shape the settings sheet asks for fits how MinIO and the rest
  address a bucket, and whether a refusal says anything a person can act on. A
  signature wrong for any of those reasons is a 403 with nothing in it to read,
  which is exactly why this one has to be walked against a real server rather
  than a fixture.

## SCRAM

**SCRAM-SHA-256 can be walked here; SCRAM-SHA-512 cannot.** `ergo` advertises

```text
sasl=PLAIN,EXTERNAL,SCRAM-SHA-256
```

and Libera advertises `SCRAM-SHA-512` (the capability list in
`tests/session.rs` is a real capture from #43). So the local walk is SHA-256
against `ergo` with a registered account, and SHA-512 has no server here to
answer it.

That is worth stating plainly: SHA-512 shipped first and there was nowhere to
run it. The mechanism's own tests are strong — the SHA-256 half is checked
against RFC 7677's published vectors, and the exchange, the nonce check and the
signature check are shared — but no server has answered a SHA-512 exchange this
client sent.

**SCRAM-SHA-256 is walked**, on 2026-07-31, against local `ergo` with a
registered account. The whole exchange ran against a real server: a real salt
and iteration count, and the server's signature verifying. Confirmed from
`ergo`'s side rather than from the client's own report —

```text
:ergo.test 330 whoisprobe syk syk :is logged in as
```

— because the client saying it authenticated is the thing under test. This is
the first time SASL has been verified against a real account at all; the
mechanism this milestone shipped first, SHA-512, still has not been.

**Not walked**:

- **SHA-512 against any server.** Libera advertises it and `ergo` does not, so
  the walk is a registered Libera account.
- **A wrong password.** SCRAM fails at the signature rather than at a numeric,
  so the sentence a user sees comes from a different path than PLAIN's.

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

Still not walked:

- **A dropped hook coming back.** Installing a plugin again now clears the
  strikes against it on every running network, so a plugin repaired and
  installed should start answering without a restart. The clearing is unit
  tested at both ends and the two have never been joined in the application —
  which is the same shape as the gap that made the drop itself worth walking.

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
  messages on screen than comfortable. `read` has never been looked at against
  a long backlog at all.
- **Changing theme while on a density that is not comfortable.** The
  implementation is built around this case — theme and density write the same
  three properties to the same inline declaration — and `apply.test.ts` covers
  it, but it has not been seen. The density should survive and the colours
  should still change.

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

- **Going back.** A profile at version 5 makes `migrate` answer
  `StoreError::SchemaTooNew` for any earlier build. Nobody has run an older
  ircx against a migrated profile to see what that failure does to a launch, or
  what the user is told. It is the one path where a user with a working client
  ends up with one that will not open their history.
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

- **The themes directory.** `list_themes` resolves `app_data_dir()/themes` and
  reads each subdirectory's `theme.json` and `theme.css`. No test creates that
  directory, because no test has an app data dir. Copy
  `src/styles/themes/ircx-light` into it under another name, relaunch, and it
  should appear in the palette under "theme".
- **Hot reload.** A task polls the directory's metadata every two seconds and
  re-emits the whole directory when anything changes. Edit a colour in an
  installed theme with the app running: the window should follow within a couple
  of seconds, without a relaunch. Deleting the theme that is in force should
  drop the window back to the built-in dark one rather than leaving it
  half-styled.
- **`color-scheme` on a real window.** The manifest's `appearance` is written to
  the root element, which is what makes native scrollbars and form controls flip.
  Headless Chrome does not draw either, so nobody has seen it take effect.
- **What a browser does with a value it cannot parse.** The appearance editor
  refuses a value holding a stray `;` or `!` because `setProperty` is specified
  to ignore a custom property whose value is not a `<declaration-value>` —
  silently, leaving the token unset and uncovering the dark theme `global.css`
  imports statically. jsdom's `cssstyle` stores such a value verbatim instead,
  so the tests pin the gate's behaviour and nothing pins the behaviour it is
  premised on. Paste `#0969da;` into a colour field on `ircx-light` with the app
  running: the editor should refuse it in a sentence, and nothing should change
  on the window. The same paste with the gate removed is what it is protecting
  against — that surface should go dark.
- **The sheet against a theme installed on disk.** Every component test uses the
  two built-ins. An edit is keyed by theme id and kept in `localStorage`, so a
  theme that arrives after first paint takes its edits a frame later than the
  built-ins do. Install a theme, edit a colour in it, relaunch, and the edit
  should be there; the window should not flash the theme's own value first.
