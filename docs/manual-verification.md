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
  during either run. The client held a busy channel's member list correctly
  across the churn it did see, but that churn was one JOIN in 45 seconds, so it
  says almost nothing about a burst of hundreds of QUITs and the rejoin storm
  after it. Whoever is next in a channel when a split happens should watch what
  the member list and the timeline do.

- **Reactions on the wire.** `+draft/react` is a work-in-progress tag and no
  run has carried one. The scripted tests in `crates/ircx-core/tests/session.rs`
  are written from the IRCv3 `react` client tag specification, not off a
  server, and the specification's own examples are what they replay. What
  nobody has seen: whether Libera relays a `TAGMSG` carrying the tag at all,
  and whether the `msgid` a `+reply` names survives the relay unchanged. Send
  one from a client that supports it — IRCCloud does — and watch the raw log.
  The timeline now sends one as well as drawing it, and neither direction has
  met a server. Nobody has watched a chip appear on the other client.

## The preview fetch over TLS

`crates/ircx-net/tests/http_loopback.rs` drives the whole fetch — framing,
redirects, caps, timeouts — over plaintext loopback, for the same reason
`tests/loopback.rs` does: TLS needs a certificate fixture. So nothing has
watched the preview fetch complete an actual handshake, and `ircx-net::http`
sets `alpn_protocols` where the IRC transport does not.

Paste an `https://` link to a PNG into a channel, click fetch, and watch the
image appear. Then check that a link to a host that redirects across origins
(`https://imgur.com/<id>.png` does) refuses and names the host it would have
gone to, rather than following it.

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

- **The topic path.** `##test` has no topic set, so nothing exercised `332` or a
  `/topic` round trip. Whoever is next in a channel that has a topic should
  check that the header carries it.
- **Independent scrolling between split panes.** The store keeps a scroll
  position per view and the code path looks right, but nothing has watched two
  panes scroll apart. The first run's panes held three rows each; the second run
  never split.
- **The lock icon in the sidebar.** `isRestricted` reads the channel's mode
  flags and `##test` drew a lock. There is no way to see a channel's modes in
  the interface, so nobody knows whether that lock is right.
- **A conversation closed before quitting staying closed.** The restart in the
  second run restored a channel and a query, both of which were open when the
  app was closed. Nobody has closed one first and checked that it stays gone.
- **The raw log under load.** It renders every line it holds, up to the store's
  cap of 2,000, and re-renders per arriving line while it is open. It held the
  ~200 lines of a quiet session comfortably. Nobody has watched it during a
  netsplit or a `LIST`.

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

- **A narrow window.** The roster is a fixed 208px and there is no longer a
  width below which it is withheld — the shared sidebar had one at 900px, and
  the embedded mode this replaced ignored it anyway. A half-width pane on a
  small window now spends 208px of whatever it has on the roster. Nobody has
  watched what is left of the conversation at, say, 1000px split in two.

- **A large channel.** The second Libera run read `#libera`'s member list across
  31 replies, so it is the size of channel worth trying. `MemberList` renders
  the list it is given, and one roster per pane means two of those rendering at
  once, each re-rendering as members come and go. Both end-to-end runs split
  panes on quiet channels, so nothing has drawn two busy rosters together.

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
- **Whether the grant dialogue reads as plain terms.** `Permission::summary` is
  written for someone who has never heard the word capability, and the tests
  only assert that the string arrives — no test can say whether it lands.
  Install a plugin asking for all seven and read the seven lines cold: the
  question is whether you would know what you were agreeing to.
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
