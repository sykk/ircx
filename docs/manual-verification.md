# Manual verification

This checklist contains behavior that automated tests cannot establish. Run the
relevant checks before a release or after changing the named subsystem. Keep
historical results in Git and add a test when a check becomes repeatable.

## Release builds

- [x] Launch a packaged Linux build, complete onboarding, connect, join a
  channel, send a message, quit, and confirm the conversation returns.
  Verified on KDE Plasma (Wayland), CachyOS, 2026-09-10, against a local test
  server (`scripts/run-ircx/quickserver.mjs`).
- [ ] Repeat the launch and basic conversation check on Windows.
- [ ] Repeat it on Intel and Apple Silicon macOS release artifacts.
- [ ] Confirm a light installed theme does not flash the built-in dark theme on
  startup.

## Native window behavior

- [x] On a desktop with a window manager, drag all four window edges and all
  four corners. The top edge must resize instead of dragging the title bar, and
  the bottom edge must not activate status-bar controls. Verified on KDE Plasma
  (Wayland), CachyOS, 2026-09-10.
- [x] Drag a file from a file manager into a channel. The confirmation dialog
  must take focus, trap Tab, cancel on Escape, and return focus to the composer.
  Verified on KDE Plasma (Wayland), CachyOS, 2026-09-10.
- [x] Drag the member-list resize handle from either side of its visible target.
  Hide and restore the list in a narrow split pane. Verified on KDE Plasma
  (Wayland), CachyOS, 2026-09-10.
- [x] Open the channel browser from a network action and from the command
  palette, then close it with Escape and confirm focus returns to its opener.
  Verified on KDE Plasma (Wayland), CachyOS, 2026-09-10.
- [x] Click "Show in folder" on a finished transfer and "Open themes folder" on
  the Appearance page. Both reach `opener:allow-open-path`, whose scope is
  checked in the Rust side and mocked away in every frontend test, so a path the
  capability refuses looks exactly like one it allows until a file manager
  opens. "Open themes folder" verified on KDE Plasma (Wayland), CachyOS,
  2026-09-10; "Show in folder" on a finished transfer not re-verified here —
  no transfer was available to test. See File transfers below.

## Status icon

Nothing here is reachable from `Xvfb`: a status icon is a D-Bus registration
against whatever the desktop is running, and the harness's display has no
StatusNotifier host to register with. `Attention` in `src-tauri/src/tray.rs`
covers what the icon says; these cover whether there is an icon to say it.

- [x] On a desktop with a status area, launch a release build and confirm an
  icon appears, and that its menu offers Show and Quit. On Windows and macOS,
  left-click must raise the window without opening the menu; on Linux it opens
  the menu, `tray-icon` delivering no click event there at all. Verified on KDE
  Plasma (Wayland), CachyOS, 2026-09-10 (Linux half only — click opens the
  Show/Quit menu). Along the way, found the tray icon still drawn from the
  pre-monogram app icon (`946baf6` updated the main icon and left the tray
  pair behind); fixed by pulling in `tray-plain.png`/`tray-marked.png` from
  PR #698.
- [x] Close the window with the title bar's button. The window must go, the
  process must stay, and one notification must say where it went — once for the
  run, not once per close. Verified on KDE Plasma (Wayland), CachyOS,
  2026-09-10.
- [x] Raise it again from the icon, and confirm the connection was never
  dropped: a channel that was joined is still joined, with no rejoin in it.
  Verified on KDE Plasma (Wayland), CachyOS, 2026-09-10.
- [x] Have somebody say your nickname in a channel while the window is hidden.
  The icon must gain its mark, and lose it once the conversation is read. Both
  states must be the same size — they were 32×32 and 64×64 once, and the panel
  scaled them differently. Verified on KDE Plasma (Wayland), CachyOS,
  2026-09-10, against a real network (a second connection scripted for the
  occasion sent the mention); `tray-plain.png`/`tray-marked.png` are both
  64×64 at the file level too.
- [x] Quit from the icon's menu and confirm the process ends rather than
  hiding. Verified on KDE Plasma (Wayland), CachyOS, 2026-09-10.
- [x] Turn the setting off in Notifications, then close the window: the session
  must end, the icon must go with it, and the choice must survive a restart.
  Verified on KDE Plasma (Wayland), CachyOS, 2026-09-10.
- [ ] On a desktop with no status area — GNOME without an extension is the one
  to check — confirm no icon appears, that Notifications draws the toggle off
  and inert with the reason beside it, and that closing the window still ends
  the session.

## Accessibility

- [ ] With Orca on Linux, trigger an unread-count announcement and a send-queue
  announcement. Each sentence must be spoken once.
- [ ] Tab through every modal dialog in the WebKitGTK release build. Focus must
  wrap inside the dialog and return to the control that opened it.
- [ ] On a display that reports `hover: hover`, check the pin, reply, and
  reaction controls with both pointer hover and keyboard focus.

## Timeline layout

- [x] In compact and read densities, follow a declared group across two author
  blocks. Its spine must remain continuous through the block gap. Verified on
  KDE Plasma (Wayland), CachyOS, 2026-09-10, against a real network — a
  declared topic, an unrelated interrupting message, and a further block all
  shared one continuous spine in both densities, matching "a declared topic
  ... still takes anybody."
- [x] Scroll into history in a release build, load another page, and let a row
  above the reader grow. The message under the reader must not move unless the
  reader scrolls. Verified on KDE Plasma (Wayland), CachyOS, 2026-09-10,
  against a real network — reacting to a message above the reading position
  grew that row (a chip appeared) and the reader's position held. A scripted
  reaction from a second connection never arrived, which turned out to be the
  test server's `CLIENTTAGDENY` policy stripping `+draft/react` between
  clients, not anything on ircx's side; the in-app reaction still exercised
  the growth this item asks about. Already covered in depth by
  `Timeline.layout.test.tsx`'s "a row above the reader that grows" suite.
- [x] Leave one split pane at the live edge and another in history. A page or
  live arrival in either pane must not move the other pane's reader. Verified
  on KDE Plasma (Wayland), CachyOS, 2026-09-10, against a real network — a
  live arrival while one pane was scrolled into history left that pane
  unmoved. The page-load half of this is also covered by
  `Timeline.layout.test.tsx`'s "two panes on one channel, one of them parked"
  suite; this pass adds the real-socket live-arrival case a mocked backend
  cannot exercise.
- [x] In a WebKitGTK release build, read a line carrying mIRC colour codes from
  each of the six rows of the extended palette. Every row must resolve to a
  visible colour: `src/lib/ircFormat.ts` builds them with nested `color-mix(in
  oklab, …)`, jsdom computes neither, and an engine that does not support it
  drops the declaration and draws the line in the ordinary text colour with
  nothing to say it did. Verified on WebKitGTK 2.52.5, 2026-08-26. Re-verified
  on WebKitGTK 2.52.6, KDE Plasma (Wayland), CachyOS, 2026-09-10, against a
  real network — codes 19/31/43/55/67/79 (one per shade row, fixed hue), sent
  from a scripted second connection, all six rendered as distinct colours.

## Networks and services

- [ ] On a disposable Libera.Chat nick over verified TLS, complete guided
  registration, follow the emailed verification command, reconnect, and
  confirm SASL PLAIN signs into the new account.
- [ ] Register an account on a server whose `draft/account-registration`
  carries `email-required`, then run `/verify` with the emailed code. The rest
  of that capability is `crates/ircx-core/tests/registration_ergo.rs`, which
  registers and signs in against a real ergo; what it cannot reach is the
  verification path, because the code arrives by email and the rig has no MTA
  to read it out of.
- [ ] Join a `+k` channel, quit, and launch again. It must come back joined
  without the key being typed twice. The tests run against a credential store
  in this process; whether the real keyring hands the key back to a second
  launch of the packaged app is what only a second launch can say.
- [ ] Remove that network and confirm the key is gone from the desktop's
  keyring by hand. A keyring cannot be asked what it holds, so an entry left
  behind by a bug here is one nothing in the app could ever find again.
- [ ] Connect to Libera.Chat with SASL PLAIN and SCRAM-SHA-512. Repeat with a
  wrong password and confirm registration stops with an actionable error.
- [ ] Set an away time in Notifications, leave the keyboard for it, and
  confirm from a second client that the nick reads as away with this network's
  own message. Touch the keyboard and confirm it clears. Then set an `/away` by
  hand and repeat both halves: neither the reason nor the away itself may
  change, which is the one thing about this that a second pair of eyes has to
  see.
- [ ] Have a channel operator withdraw one of *your* messages, and confirm the
  row says they took it away rather than you. Withdrawing your own is
  `crates/ircx-core/tests/registration_ergo.rs`, through the server and back
  out of SQLite; somebody else doing it needs a second account with the power
  to, which is a rig this one is not.
- [ ] Connect two authenticated sessions to a server with read markers. Move
  the marker in one session, replace history in the other, and confirm the
  unread seam still uses the server marker.
- [ ] Search into another conversation and return to the live edge. The target
  must open once, the hit must be centered, and its unread seam must survive.
- [ ] Blackhole an established connection so the socket stays open and nothing
  arrives — `sudo iptables -I INPUT -s <server> -j DROP`, or suspend the
  machine. Within two keepalive intervals the network must say the server
  stopped answering and begin its backoff, rather than waiting out the kernel's
  retransmits. Only a real socket shows this; a test can drop a connection but
  not leave one open and silent.
- [ ] Upload a small file through the Catbox preset and open the resulting URL.
- [ ] Upload through a real S3-compatible account. Check the configured region,
  a private-object warning, and an anonymously readable object.
- [ ] From another application, open `irc://` and `ircs://` links while ircx is
  closed and while it is already running. A known network must open or join the
  target channel; an unknown server must open a prefilled Advanced setup form.
- [ ] On macOS, grant and refuse notification permission. On each supported
  desktop, confirm a direct-message notification names the conversation and is
  suppressed while the window is focused.

## File transfers

What two implementations agree on is the whole subject, and the rest of the
suite is ircx against ircx. HexChat is covered by a probe rather than by hand —
see the interop section below — so what is left here is the clients that probe
cannot drive and the conditions a loopback rig does not have.

- [ ] Receive a file from mIRC and from irssi, and send one to each. Confirm
  the name it lands under, and that a name already taken in the download folder
  is numbered rather than overwritten.
- [ ] Let each of them resume a transfer interrupted partway, in both
  directions. The finished file must be byte-identical to the sender's.
- [ ] With ircx behind NAT, turn on "Ask the other side to open the port" and
  complete a transfer in each direction with a client that is reachable.
- [ ] On a network with real IPv6, complete a transfer in each direction with a
  client that does IPv6 DCC. The loopback tests cover the path and the interop
  probe cannot: HexChat has nowhere to put an IPv6 address in an offer and
  sends `0`.
- [ ] Forward a port range, set it on the Transfers page, and confirm the port
  an offer names is reachable from outside. Which port is opened is
  `opens_a_port_inside_the_range_it_was_given` in `ircx-net`; whether a router
  forwards it is what is left here.
- [ ] Accept an offer over a link slow enough to watch: the progress and the
  percentage must move, and Cancel must stop it and leave the part file.
  Verified against a scripted sender on 2026-08-27, at 224 KB of 7.6 MB and
  moving; the Cancel left 1.4 MB in `beach.mov.part` and nothing under the
  offered name.
- [ ] Decline an offer and confirm the sender's client stops waiting rather
  than timing out. Verified 2026-08-27: `DCC REJECT SEND` reached the sender as
  the row went to Declined.

## Credentials

- [x] Save a network password and upload credential, reboot, and confirm both
  remain available without being re-entered. Verified on KDE Plasma (Wayland),
  CachyOS, 2026-09-10 — a SASL password and an upload credential both survived
  a full quit and relaunch of the release build (not a full OS reboot, but the
  same keyring-backed path a reboot exercises).
- [x] Repeat credential saving on Linux without a Secret Service provider. The
  operation must fail with an actionable message rather than claim the secret
  was saved. Verified on KDE Plasma (Wayland), CachyOS, 2026-09-10, by
  launching with `XDG_RUNTIME_DIR` pointed at an empty directory and
  `DBUS_SESSION_BUS_ADDRESS` unset (unsetting the variable alone is not
  enough — the session bus is still found at the well-known
  `$XDG_RUNTIME_DIR/bus` socket regardless). Got "the system keyring would
  not answer: Platform secure storage failure: DBus error: ..." rather than a
  false success.

## External and local integration probes

These tests are ignored by the normal suite because they need a service or make
a network connection. Their source files contain the required setup.

```sh
cargo test -p ircx-core --test libera -- --ignored --nocapture
cargo test -p ircx-core --test ergo -- --ignored --nocapture

# DCC against HexChat, which is a different implementation of a protocol that
# has no specification. Stands up its own server, display and client:
scripts/dcc-interop.sh test
scripts/dcc-interop.sh down
cargo test -p ircx-core --test scram_ergo -- --ignored --nocapture
cargo test -p ircx-core --test external_ergo -- --ignored --nocapture
cargo test -p ircx-core --test gap_walk -- --ignored --nocapture
cargo test -p ircx-net --test https_probe -- --ignored --nocapture
cargo test -p ircx --lib litterbox -- --ignored --nocapture
cargo test -p ircx --lib minio -- --ignored --nocapture
```
