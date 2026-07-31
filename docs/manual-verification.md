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

- **A wrong password on a registered account**, as opposed to a nonexistent one.
  Libera answers `904` either way and the client cannot tell them apart, so this
  is thin — but nobody has run it.
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

**A grant reaching a live session is verified** on the same day. `/greet` and
`/roster` both answered in an open channel the moment their grants were saved,
with no reconnect, and revoking `add-commands` took the command back out of the
client — the route table is rebuilt on a runtime the session already holds, so
neither direction is a message anything could miss.

`/roster` also reported `no fetch (ircx: network-requests was not granted)`,
which is #93 seen from the other side: the refusal is an `Error` and a plugin
that degrades can say why it did.

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

Built end to end and **never run in the assembled application.** Every part is
covered by a test — the sandbox refusals, the runtime, the batch, the store
round trip, and the shipped example under `examples/plugins/units` — and no
message has ever reached an annotator inside the running client.

The path to walk, once there is somebody to walk it. Local `ergo` is the server
to do it against, and `docs/plugins.md` describes what should happen at each
step.

- **The install dialogue's eighth line.** `annotate-messages` reads *"Read every
  message as it arrives in the channels you choose, and show its own note beside
  them"*, and nothing has ever displayed it. The seven that came before it were
  read cold by the owner on 2026-07-30 and one of them did not survive the
  reading, so this one is worth the same treatment rather than an assumption.
  It is also the first permission whose manifest asks for `"channels": ["*"]`,
  so the dialogue has to ask which conversations rather than list any.
- **A note appearing at all.** Install `examples/plugins/units`, grant it a
  channel, and have somebody say a temperature in it.
- **The note arriving after the message rather than with it.** This is the
  whole of the design: the annotator runs on arrival and never on draw, so the
  conversation is never waiting on a plugin. A note that appears in the same
  frame as the message would still look right and would mean the ordering is
  accidental.
- **The note not reading as part of what was said.** Named with the plugin and
  set apart from the text. A test asserts the message's own text does not
  contain the note, which is not the same as a person finding them
  distinguishable at a glance.
- **A note surviving a restart.** The archive is the only place one lives once
  the window has moved on. Close the client, reopen the conversation, and the
  note should come back with the message without the annotator running again.
- **A broken annotator being dropped.** Three consecutive failed batches, the
  first reported and the rest silent. An example that throws would show whether
  the report reaches anywhere a person looks — the strike counting is unit
  tested, the reporting is a `warn!` nobody has read in situ.

## Opening a link

Every URL a message carries now leaves through the system opener rather than
through an anchor: the inline link and the attachment line both call
`openExternal`, and neither renders an `href`. The tests assert that no `href`
exists to navigate and that the opener was asked, which is as far as jsdom
reaches.

**Not verified:** that a link actually opens. Nothing has clicked one in the
running client, on any platform. Worth knowing that `opener:allow-open-url` was
granted in `src-tauri/capabilities/default.json` long before anything called it,
and the attachment line relied on `target="_blank"` until 2026-07-31 — so
whether a link in this client has *ever* opened is an open question, not a
regression risk.

## Density

Chosen in the palette and remembered in `localStorage`, verified that far on
2026-07-31: `ircx.density` read back as `read` after a restart, alongside
`ircx.theme`. What is left is a matter of looking rather than of mechanism.

- **The loosened compact.** The first values were too tight against real
  backlog; leading went 1.45 to 1.55 and the block gap 8px to 10px. Nobody has
  looked at the result. `read` has never been looked at against a long backlog
  at all.
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
