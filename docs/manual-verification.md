# Manual verification

Things no agent can check, because they need a real account or a human watching
the assembled app. Nothing here is covered by `cargo test` or `npm test`.

## SASL against real services

The only protocol path with unit tests and no live verification. `ircx-core`
covers the 900-908 numerics and the 400-byte base64 chunking against scripted
dialogues, but nothing has ever authenticated against actual services.

You need a registered NickServ account. Run `npm run tauri dev`, add Libera
through onboarding, and enter the account name and password.

Watch for, in order:

1. **`CAP ACK` includes `sasl`.** Libera advertises
   `sasl=ECDSA-NIST256P-CHALLENGE,EXTERNAL,PLAIN`; we request and use `PLAIN`.
   Check the raw log — if `sasl` is missing from the ACK, nothing below happens
   and the client should say so rather than connecting anonymously.
2. **`AUTHENTICATE PLAIN`, then a bare `+` from the server, then the base64
   payload.** The `+` is the server asking for the credential; a client that
   sends the payload before it is a protocol error.
3. **`903 RPL_SASLSUCCESS`.** The status bar's SASL indicator should turn from
   in-progress to authenticated, naming the account.
4. **Registration completes after SASL, not before.** `CAP END` must follow the
   903, not race it.

Then test the failure path with a deliberately wrong password:

5. **`904 ERR_SASLFAIL` must abort registration**, not connect you
   unauthenticated. This is the one most likely to be wrong, and the one that
   matters: silently connecting without the identity the user asked for is worse
   than failing. The status bar should show the failure and the error should
   name what to do.

Also worth a look: whether the password field shows "Saved in your system
keyring" rather than an empty box when you reopen the network's settings. That
path has a unit test but has never been seen by a person.

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
