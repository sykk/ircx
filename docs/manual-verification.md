# Manual verification

This checklist contains behavior that automated tests cannot establish. Run the
relevant checks before a release or after changing the named subsystem. Keep
historical results in Git and add a test when a check becomes repeatable.

## Release builds

- [ ] Launch a packaged Linux build, complete onboarding, connect, join a
  channel, send a message, quit, and confirm the conversation returns.
- [ ] Repeat the launch and basic conversation check on Windows.
- [ ] Repeat it on Intel and Apple Silicon macOS release artifacts.
- [ ] Confirm a light installed theme does not flash the built-in dark theme on
  startup.

## Native window behavior

- [ ] On a desktop with a window manager, drag all four window edges and all
  four corners. The top edge must resize instead of dragging the title bar, and
  the bottom edge must not activate status-bar controls.
- [ ] Drag a file from a file manager into a channel. The confirmation dialog
  must take focus, trap Tab, cancel on Escape, and return focus to the composer.
- [ ] Drag the member-list resize handle from either side of its visible target.
  Hide and restore the list in a narrow split pane.
- [ ] Open the channel browser from a network action and from the command
  palette, then close it with Escape and confirm focus returns to its opener.
- [ ] Click "Show in folder" on a finished transfer and "Open themes folder" on
  the Appearance page. Both reach `opener:allow-open-path`, whose scope is
  checked in the Rust side and mocked away in every frontend test, so a path the
  capability refuses looks exactly like one it allows until a file manager
  opens.

## Status icon

Nothing here is reachable from `Xvfb`: a status icon is a D-Bus registration
against whatever the desktop is running, and the harness's display has no
StatusNotifier host to register with. `Attention` in `src-tauri/src/tray.rs`
covers what the icon says; these cover whether there is an icon to say it.

- [ ] On a desktop with a status area, launch a release build and confirm an
  icon appears, and that its menu offers Show and Quit. On Windows and macOS,
  left-click must raise the window without opening the menu; on Linux it opens
  the menu, `tray-icon` delivering no click event there at all.
- [ ] Close the window with the title bar's button. The window must go, the
  process must stay, and one notification must say where it went — once for the
  run, not once per close.
- [ ] Raise it again from the icon, and confirm the connection was never
  dropped: a channel that was joined is still joined, with no rejoin in it.
- [ ] Have somebody say your nickname in a channel while the window is hidden.
  The icon must gain its mark, and lose it once the conversation is read. Both
  states must be the same size — they were 32×32 and 64×64 once, and the panel
  scaled them differently.
- [ ] Quit from the icon's menu and confirm the process ends rather than
  hiding.
- [ ] Turn the setting off in Notifications, then close the window: the session
  must end, the icon must go with it, and the choice must survive a restart.
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

- [ ] In compact and read densities, follow a declared group across two author
  blocks. Its spine must remain continuous through the block gap.
- [ ] Scroll into history in a release build, load another page, and let a row
  above the reader grow. The message under the reader must not move unless the
  reader scrolls.
- [ ] Leave one split pane at the live edge and another in history. A page or
  live arrival in either pane must not move the other pane's reader.
- [ ] In a WebKitGTK release build, read a line carrying mIRC colour codes from
  each of the six rows of the extended palette. Every row must resolve to a
  visible colour: `src/lib/ircFormat.ts` builds them with nested `color-mix(in
  oklab, …)`, jsdom computes neither, and an engine that does not support it
  drops the declaration and draws the line in the ordinary text colour with
  nothing to say it did. Verified on WebKitGTK 2.52.5, 2026-08-26.

## Networks and services

- [ ] On a disposable Libera.Chat nick over verified TLS, complete guided
  registration, follow the emailed verification command, reconnect, and
  confirm SASL PLAIN signs into the new account.
- [ ] On a server that advertises `draft/account-registration` — ergo does —
  register an account from Networks, run `/verify` with the code it sends, and
  confirm SASL PLAIN signs into it afterwards. The tests drive the capability's
  replies; what they cannot establish is that a real service accepts the line
  as this client sends it.
- [ ] Connect to Libera.Chat with SASL PLAIN and SCRAM-SHA-512. Repeat with a
  wrong password and confirm registration stops with an actionable error.
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

- [ ] Save a network password and upload credential, reboot, and confirm both
  remain available without being re-entered.
- [ ] Repeat credential saving on Linux without a Secret Service provider. The
  operation must fail with an actionable message rather than claim the secret
  was saved.

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
