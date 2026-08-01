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

A third run on 2026-08-01 went to a local `ergo` instead, because what it was
there to see was `draft/chathistory` and Libera has none to give.
`docs/end-to-end-run-3.md`; six defects, #221 to #226.

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

- **The topic path.** `##test` has no topic set, so no run has seen one. Core is
  covered — `session.rs` feeds `332` and asserts what the header is told — so
  what is left is narrower: that the header draws a topic it is given, and that
  a `/topic` typed by the user comes back from the server changed. Whoever is
  next in a channel that has one should look.
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

### Still open

- **Declared grouping has never been seen outside a fixture.** No other client
  reads a `[topic]` prefix, so nothing types one. It is exercised by tests and
  by the preview harness and by nothing else.
- **What an unmarked exchange costs.** Two exchanges now go unmarked where one
  crosses the other, and no live round has shown how often a real channel puts
  them that way round. The count is measurable on a busy channel and has not
  been measured.

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

**Not walked**:

- **SHA-512 against any server.** Libera advertises it and `ergo` does not, so
  the walk is a registered Libera account.
- **The redrawn connection-failure screen, against a live refusal.** The
  wrong-password walk drew the same sentence three times in one view and headed
  it `Could not connect to 127.0.0.1:6668`, which is not what happened — it
  connected and was refused a login. Fixed in #256: the steps are history, so a
  refused login now reads `Connected to 127.0.0.1:6668` above `Authentication
  failed`, and the sentence itself appears once, in the alert that announces it.
  The status bar names the network and stops at `failed`; the reason is on the
  setup screen and in the server buffer, which every failure path notes it into.
  Covered by `Connecting.test.tsx` and `StatusBar.test.tsx` — but no server has
  refused a login since, so what no test sees is how the three lines read
  together when a real one does.

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

**A dropped hook coming back** is walked on 2026-08-01, against local `ergo`,
as a step in `crates/ircx-core/tests/ergo.rs`. A plugin written to throw is
installed and granted, a second client says three things, and the hook is
dropped into the server console:

```text
The flaky plugin failed 3 times in a row, so ircx stopped asking it to annotate
messages. Install it again from Plugins once it is fixed.
```

Repaired, installed over — the same call the sheet makes — and told the network
it changed, it answers on the next message without a restart.

**The step was checked against a build with the clearing taken out**, which is
the only reason it is worth anything: it failed there, with `the repaired
plugin was never asked again — the strikes outlived the install`. A step that
passes either way says nothing about the mechanism it names.

**The half above the core is walked too**, by the owner in the assembled
application on 2026-08-01, against local `ergo` with a second client in
`#test`. The ergo run sends `PluginChanged` itself; this is the path where the
plugins sheet sends it.

A plugin written to throw was installed through the folder picker and granted
the channel. Three messages, three seconds apart — spaced because a strike is
counted per batch of arrivals, and three lines landing together count once. The
console said the plugin had been dropped. A repaired build was then installed
over it, granted again, and the next message came back annotated, with no
restart.

So the whole path is joined: the click, the grant, the strikes, the drop, the
repair and the return.

Worth keeping for the next run of this: installing over a plugin resets its
grants, so a repaired plugin that is not granted again annotates nothing and
looks exactly like strikes that outlived the install. The two are told apart by
whether the sheet shows the channel granted, and nothing on the screen says so.

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

  **What survives the cap is the oldest of what was missed, not the newest.**
  `AFTER` pages forward, so the reader gets lines 1 to 2000 and loses 2001 to
  2500 — the five hundred closest to now. The discontinuity therefore sits
  immediately above the live seam, which is where a reader is least likely to
  expect one, and the sentence explaining it is drawn below the seam rather than
  at the join. `continue_gap` states the reasoning for saying something at all;
  what it does not decide is which end of the gap to keep, and this walk is the
  first time anyone has seen which end that turns out to be.
- **Libera offers no history to ask for.** The capability was not in what
  `cadmium.libera.chat` advertised on 2026-07-30, so nothing is sent there and
  the archive stays the whole history. That is the degrade working, and it also
  means no Libera run can exercise any of this.

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

**Not verified:** the export. `save()` opens a real file dialog, which the
harness cannot answer, so the button was watched doing nothing when the dialog
is dismissed and the writing itself is covered only by the store's tests. Export
one conversation and one archive, and read the file back — it is JSON Lines, one
message per line, and `jq` is enough to check it.
