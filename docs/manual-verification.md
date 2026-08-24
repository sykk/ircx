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

## Networks and services

- [ ] On a disposable Libera.Chat nick over verified TLS, complete guided
  registration, follow the emailed verification command, reconnect, and
  confirm SASL PLAIN signs into the new account.
- [ ] Connect to Libera.Chat with SASL PLAIN and SCRAM-SHA-512. Repeat with a
  wrong password and confirm registration stops with an actionable error.
- [ ] Connect two authenticated sessions to a server with read markers. Move
  the marker in one session, replace history in the other, and confirm the
  unread seam still uses the server marker.
- [ ] Search into another conversation and return to the live edge. The target
  must open once, the hit must be centered, and its unread seam must survive.
- [ ] Upload a small file through the Catbox preset and open the resulting URL.
- [ ] Upload through a real S3-compatible account. Check the configured region,
  a private-object warning, and an anonymously readable object.
- [ ] On macOS, grant and refuse notification permission. On each supported
  desktop, confirm a direct-message notification names the conversation and is
  suppressed while the window is focused.

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
cargo test -p ircx-core --test scram_ergo -- --ignored --nocapture
cargo test -p ircx-core --test external_ergo -- --ignored --nocapture
cargo test -p ircx-core --test gap_walk -- --ignored --nocapture
cargo test -p ircx-net --test https_probe -- --ignored --nocapture
cargo test -p ircx --lib litterbox -- --ignored --nocapture
cargo test -p ircx --lib minio -- --ignored --nocapture
```
