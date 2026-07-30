# Driving the assembled application

One session of the real app against irc.libera.chat, 2026-07-30, walking the
path a new user walks: first launch, onboarding, connect, join, talk, split,
search, quit, relaunch. Nobody had done this before; `crates/` had been verified
against a live server and `src/` in a browser, and the IPC seam between them had
only ever been crossed by a boot against an empty database.

The seam had ten defects in it. Every one of them is filed:

| | |
|---|---|
| [#49](https://github.com/sykk/ircx/issues/49) | A message you send never appears in the conversation |
| [#50](https://github.com/sykk/ircx/issues/50) | `/help` prints nothing: `CommandOutcome::Output` is discarded |
| [#51](https://github.com/sykk/ircx/issues/51) | A conversation never loads its history |
| [#52](https://github.com/sykk/ircx/issues/52) | Channels and queries are not remembered across a restart |
| [#53](https://github.com/sykk/ircx/issues/53) | The server console is unreachable: core writes to `*`, the frontend opens `""` |
| [#54](https://github.com/sykk/ircx/issues/54) | Typing in the network console sends `TAGMSG` with no target; the server answers 411 |
| [#55](https://github.com/sykk/ircx/issues/55) | Searching for a hyphenated word fails: input reaches FTS5 as a query expression |
| [#56](https://github.com/sykk/ircx/issues/56) | IRC formatting codes are drawn as literal control characters |
| [#57](https://github.com/sykk/ircx/issues/57) | No discoverable way to join a channel after onboarding without autojoin |
| [#58](https://github.com/sykk/ircx/issues/58) | A whole session logs nothing, and the raw protocol log is shown to nobody |

No code was changed. The report is the deliverable.

## How it was run

A debug build of `src-tauri` against the Vite dev server on 5183 — the two
halves of `npm run tauri dev`, started separately so the environment could be
controlled. `XDG_DATA_HOME` pointed at a scratch directory, so the archive under
test was `…/scratchpad/profile/data/chat.ircx.app/ircx.sqlite3` and no real
profile was touched.

The window ran on a nested `Xwayland :99` sized 1280x880 rather than on the
owner's desktop, which is why every screenshot here is the application and
nothing else. Input was synthesised with XTEST through `ctypes` — there is no
`xdotool` on this machine — so the clicks and keystrokes below went through the
same GTK and WebKit input path a person's would.

Conduct on Libera: one connection, a throwaway unregistered nick
(`ircx-e39169`), no SASL, `##test` only, one message sent to it, one `INFO`
to NickServ, and a clean quit. A second connection followed after the restart,
as the test called for. Nothing was said in a channel with strangers in it.

## What happened, in order

### First launch against an empty profile

Onboarding appeared: "Welcome to ircx", three routes in, and "Skip for now".
`docs/end-to-end/01-onboarding.png`.

"Join a public network" opened the preset form with Libera.Chat selected, the
nickname field focused, and the SASL box unticked.
`docs/end-to-end/02-public-network-form.png`.

### Connecting

Clicking Connect produced three states in the right order, each of them read off
a backend event rather than scripted:

- "Connecting to irc.libera.chat:6697" — `docs/end-to-end/03-connecting.png`
- "Registering with irc.libera.chat:6697" — `docs/end-to-end/04-registering.png`
- Connected, at which point the flow dismissed itself — `docs/end-to-end/05-connected.png`

The whole thing took a few seconds; the frame capture was sampling at roughly
three frames a second and is not precise enough to give a number worth quoting.
Registering was the state it sat in for almost all of it, which matches Libera
sending `001` before the MOTD.

The status bar populated. Left: "Connected to irc.libera.chat:6697 (TLS)", with
"(TLS)" in the muted colour. Right: "Lag —", "Caps 13", and a SASL indicator
with a grey dot. Lag filled in later — "Lag 95ms" by the time the palette was
opened, which is consistent with the two-minute keepalive interval. The SASL
indicator shows grey-and-labelled for `NotConfigured` rather than hiding; that
reads as deliberate.

A note for whoever looks at capabilities: the first connection reported **Caps
13** and the second, four minutes later, reported **Caps 12**. Both to
`irc.libera.chat`, same config, no SASL either time. I have no explanation and no
way to get one from the interface (#58), so this is recorded rather than
diagnosed.

### Joining `##test`

This is where the first defect showed up, before the join even happened: a
connected network with no channels has no composer, and clicking the network in
the sidebar does nothing visible. The route that works is Ctrl+K, the network
row, Enter — which opens a pane with a composer and an empty timeline
(`docs/end-to-end/06-network-console.png`). Nothing signposts it. **#57.**

That pane is also where two more defects live. Its timeline is empty because it
is pointed at target `""` while core has been filing the connection line, the
ident notices, the entire MOTD and the umode change under `*` — 35 rows sitting
in the archive with no window onto them. **#53.** And typing into its composer
sends `TAGMSG` with an empty parameter; Libera answered `411 No recipient given
(TAGMSG)` four times over the eleven characters of `/join ##test`. **#54.**

The join itself worked. `##test` appeared in the sidebar, the header read
"##test · 5 members", and the drawer listed all five:

> fugue, ircx-e39169, jstoker, lonjil, Sario

`docs/end-to-end/07-channel-joined.png` and `docs/end-to-end/08-member-list.png`.
Five in the header, five in the drawer, and the nick colours differ per nick.
I could not compare that against the `353` on the wire, because there is nowhere
in the application to see a `353` (#58); `crates/ircx-core/tests/libera.rs`
covers that assembly directly and found it correct.

**No topic appeared, and I cannot say whether that is right.** The archive shows
a `329` creation-time reply for `##test` and no `332`, so the likeliest reading
is that `##test` has no topic set and there was nothing to draw. The topic path
is untested by this run either way.

One thing I could not resolve: the sidebar row for `##test` carries a lock icon.
`isRestricted` triggers on `k`, `i`, `s` or `p` in the channel's mode flags, and
there is no way to read the mode string from the interface, so whether the lock
is correct is unknown.

### Sending a message

Typed `ircx end-to-end run e39169 - please ignore`, pressed Enter. The composer
cleared. **Nothing was drawn** — no optimistic copy, no confirmed copy, no error.
`docs/end-to-end/09-sent-message-missing.png` is the channel a second and a half
later, unchanged.

The message was sent. The archive has it as delivered:

```
('##test', '"privmsg"', '{"state":"delivered"}', 'ircx end-to-end run e39169 - please ignore', …)
```

and Ctrl+F finds it (`docs/end-to-end/13-search.png`). So the send path, the
`echo-message` match and the archive write all work; the local copy is handed
back as `CommandOutcome::Sent` and the composer throws it away. **#49.**

This makes one of the questions in the brief unanswerable as asked. "Does the
delivery state settle, or stay `Pending` on screen?" — there is no row on screen
to carry a state. In the archive it settled to `Delivered`.

`/help` behaved the same way for the same reason: nothing at all.
`CommandOutcome::Output` is discarded too. **#50.**

`/msg NickServ INFO ircx-e39169` *did* render, which is what pinned the cause
down: `cmd_msg` appends every local copy, `say_here` withholds the first one for
the caller. NickServ's reply rendered too, so receiving works.

That reply is also where **#56** showed up: it came in as
`\x02ircx-e39169\x02 is not registered.` and the timeline drew the two `\x02`
bytes as boxes. Nothing in the codebase touches IRC formatting codes.

### Splitting a pane

Ctrl+\ split cleanly. Both halves rendered a header, a timeline and a composer,
and the right one took focus. `docs/end-to-end/10-split-panes.png`.

Ctrl+K in the focused pane, "nick", Enter pointed it at the NickServ query while
the left stayed on `##test`. Two targets, side by side, each with its own
composer placeholder. The context panel followed focus off the channel and out
of view, which is what `docs/multiwindow.md` describes.
`docs/end-to-end/11-two-targets.png`.

**Independent scrolling was not demonstrated.** Neither pane held more than
three rows, so there was nothing to scroll. The store keeps `scrollPosition` per
view and the code path looks right, but this run does not evidence it.

### Command palette and search

Ctrl+K opened over both panes and listed 23 results grouped into NETWORKS,
CHANNELS, QUERIES and COMMANDS. Typing `nick` narrowed to two — the NickServ
query with its unread badge, and `/nick` — with the matched span highlighted.
`docs/end-to-end/12-command-palette.png`.

Ctrl+F searched the open conversation and returned two hits from `##test` with
sender, target, time and the match highlighted.
`docs/end-to-end/13-search.png`.

Selecting a hit closed the overlay and did nothing else, because the message it
points at is not in the timeline (#49, #51).

### Quit and relaunch

Closing the window exited 0 both times, so `RunEvent::ExitRequested` reached
`App::shutdown` and the `QUIT` had its grace period.

On relaunch onboarding correctly did not reappear, and the network reconnected
on its own to green. `docs/end-to-end/14-after-relaunch.png`.

**The archive survived and the interface did not reload it.** Ctrl+F for
`ignore` found the message from the previous session. Pressing Enter on it
switched the pane to `##test` — placeholder "Message ##test" — and the timeline
said "Nothing here yet". Scrolling did nothing, because there was nothing to
scroll and history is only ever fetched from a scroll handler. **#51.**
`docs/end-to-end/16-history-not-reloaded.png`.

The sidebar came back with the network and nothing under it. `##test` and the
NickServ query were both gone, with no record anywhere that either had been
open. **#52.**

So the answer to "does the archive reload" is: the database reloads, and nothing
in the interface reads it.

Searching for `end-to-end` on the way through produced

> the message archive could not be read: no such column: to

which is FTS5 parsing the hyphen as NOT and `to` as a column name. **#55.**
`docs/end-to-end/15-search-fts-error.png`.

## Two smaller things, not filed

**A panic instead of a sentence.** With a data directory that cannot be created,
the app dies with

```
thread 'main' panicked at tauri-2.11.5/src/app.rs:1425:11:
Failed to setup app: No such file or directory (os error 2)
```

`open_store` returns `Box<dyn Error>` from `setup`, and Tauri unwraps it. This
is outside the "every command returns a user-facing string" rule in `CLAUDE.md`
because it is not a command, but it is the one failure a user might actually
hit — a full disk, a locked home directory — and a stack address is the wrong
answer to it.

**`##test` reads oddly in the sidebar.** `channelSigil` draws `#` in the gutter
and `stripSigil` takes one `#` off the name, so `##test` renders as `#` then
`#test`. Correct by construction, and it still looks like a typo.

## What this run does not cover

- **SASL.** Reserved for the owner; the checkbox was never ticked and no
  credential was entered.
- **The topic path.** `##test` appears to have no topic. Neither `332` nor a
  `/topic` round trip was exercised.
- **Independent scrolling in split panes.** No pane had enough content.
- **Reconnect after a socket drop, and netsplit recovery.** Neither was provoked;
  `crates/ircx-core/tests/libera.rs` covers the first.
- **Attachments, previews, the drawer's pinned and embedded modes, the keyring.**
  Not visited.
- **The raw wire.** There is no view of it and nothing is logged (#58), so every
  claim above about what the server sent is read out of `ircx.sqlite3` rather
  than off the socket.
