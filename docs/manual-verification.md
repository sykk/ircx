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

- **`EXTERNAL`**, which needs a client certificate and a TLS listener, and
  **`ECDSA-NIST256P-CHALLENGE`**, which ircx does not implement.

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

### Still open

- **Whether anybody but us ever types one.** No other client reads a `[topic]`
  prefix, so the grade is only worth its weight if ircx users type brackets at
  each other. The mechanism is walked; the habit is not, and cannot be until
  there are two people using it.
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

**Nobody has listened to it.** The tree can be asserted and was; whether it
*reads* well is a different question, and the same one #318 left behind. What
the tests pin is that two sentences are said and a hundred are not, which is the
failure the design was chosen to avoid — not that the two are the right two, or
that "all sent" arrives when a reader expects it.

Worth an hour with a screen reader, and specifically:

- Whether `Messages waiting to send` at the start of a paste and `All sent` 48 s
  later read as a pair, or as two unrelated interruptions.
- Whether arriving at a queued row and hearing `Waiting to send` before the text
  is the right order, or whether it should follow the message.
- Whether the count in the hint row wants announcing at all for somebody who
  cannot see it — it is deliberately outside the live region, on the grounds
  that a number changing a hundred times is noise, and that reasoning has not
  been tested against a person.
