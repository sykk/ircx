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

## Assembled-application testing

Agents have verified the protocol layer against a live server and the UI in a
browser. Nobody has driven the whole application end to end: launch, onboard,
connect, talk, split a pane, restart, and confirm the archive reloaded.
