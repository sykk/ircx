# Driving the assembled application, second time

A second session of the real app against irc.libera.chat, 2026-07-30, to see
whether the ten defects the first run found (`docs/end-to-end-run.md`, issues
#49 to #58) are fixed for a person rather than for a test. Same method: a
nested X server so the screenshots are the application and nothing else, a
scratch `XDG_DATA_HOME` so no real profile is touched, XTEST for input.

**All ten hold up.** Every one was re-walked the way a user walks it and every
one now does the thing it failed to do. Two new defects turned up on the way and
are filed as [#67](https://github.com/sykk/ircx/issues/67) and
[#68](https://github.com/sykk/ircx/issues/68). No code was changed; the report
is the deliverable.

| | | |
|---|---|---|
| #49 | A sent message never appears | **fixed** — drawn on the next frame, dim, then full |
| #50 | `/help` prints nothing | **fixed** — fifteen lines, alignment still #64 |
| #51 | A conversation never loads its history | **fixed** — restored channel came back with its archive |
| #52 | Channels and queries are not remembered across a restart | **fixed** — both back before the connection finished |
| #53 | The server console is unreachable | **fixed** — palette, network row, Enter; MOTD is in it |
| #54 | Typing in the console sends a targetless `TAGMSG` | **fixed** — refused with a sentence, nothing on the wire |
| #55 | Hyphenated search fails | **fixed** — one hit, highlighted |
| #56 | Formatting codes drawn as control characters | **fixed** — stripped |
| #57 | No way to join a channel after onboarding | **fixed** — `/join ##test` from the palette |
| #58 | The raw protocol log is shown to nobody | **fixed** — header toggle, both directions, whole session |

## How it was run

The debug binary built from `main` at `cace208`, against the Vite dev server on
5183 — the two halves of `npm run tauri dev` started separately so the
environment could be controlled. `XDG_DATA_HOME` pointed at a scratch directory,
so the archive under test was
`…/scratchpad/profile2/data/chat.ircx.app/ircx.sqlite3`.

The window ran on a nested `Xwayland :99` at 1280x880. Input went through XTEST
via `ctypes`, so the clicks and keystrokes below took the same GTK and WebKit
path a person's would.

One thing the first run could not do was catch a state that lasts a few frames.
For the send, the display was recorded as PNG frames at 30fps with `ffmpeg`
`x11grab`, which is where the frame numbers below come from.

Conduct on Libera: one connection, a throwaway unregistered nick
(`ircx-4b1d7a`), no SASL, `##test` only, **two** short messages to it, one
`INFO` to NickServ, and a clean quit. A second connection followed the restart,
because the restart is the test. Nothing was said in a channel with strangers
in it beyond the two lines, and no busy channel was joined.

## What happened, in order

### Launch, onboarding, connect

Onboarding on an empty profile, "Join a public network", Libera.Chat preselected,
nickname focused, SASL unticked, autojoin left empty on purpose so that joining
would have to go through the palette.
`docs/end-to-end-2/01-onboarding.png`, `02-public-network-form.png`.

Connect went through Connecting and Registering to green in a few seconds.
Status bar: "Connected to irc.libera.chat:6697 (TLS)", "Lag —", "Caps 12", SASL
grey. `03-connected.png`.

The first run recorded a Caps 12 / Caps 13 discrepancy it had no way to explain.
It is explicable now, because the raw log exists: the `CAP REQ` we send lists
twelve, and Libera's ACK returns the same twelve
(`15-raw-log-registration.png`). Whatever produced 13 that day was not this
path, and there is now somewhere to look next time it happens.

### The server console — #53

Ctrl+K, the Libera.Chat row under NETWORKS, Enter. The console opened **already
scrolled to the end of the MOTD**, ending on "End of /MOTD command."
`04-server-console-motd.png`. That is the thing `docs/manual-verification.md`
said wanted one live connection to see: core files the MOTD under `*` and the
pane draws it.

### The raw log — #58

The `>_` button in the console header swaps the timeline for the raw log; the
subtitle changes from `irc.libera.chat:6697` to "raw protocol".
`05-raw-log-tail.png`. Scrolled to the top it starts at `>> CAP LS 302` and runs
through `NICK`, `USER`, the ident notices, `CAP REQ`, the ACK, `CAP END`, `001`
and the `005`s — outbound faint, inbound normal.
`15-raw-log-registration.png`.

Every claim in this report about what went over the wire was read off that pane,
not out of the database. That is the difference from last time.

### Typing in the console — #54

Typed `hello` into the console composer and pressed Enter. A red line appeared
above the box:

> This tab is the server's, not a conversation. Try `/msg <target> <message>`.

and `hello` was put back in the input so it is not lost.
`06-console-refusal.png`. The raw log's last line was `376 End of /MOTD command.`
before and after — nothing left. Later, scrolling the whole log, every `TAGMSG`
in the session is a typing notification from a channel or query composer and
carries its target: `>> @+typing=active TAGMSG ##test`,
`>> @+typing=done TAGMSG NickServ`, and so on. There is no targetless one and
no `411`.

### Joining through the palette — #57

Ctrl+K, `/join ##test`. The palette offered it under a RUN group as
"/join ##test — On Libera.Chat" (`07-palette-join.png`); Enter ran it. The pane
switched to the channel, the sidebar grew a `##test` row, the header read
"##test · 5 members" and the composer read "Message ##test".
`08-channel-joined.png`.

### Sending — #49

The first message was typed into `##test` and sent while screenshots were being
taken every 120ms; it was already on screen in the first one. So the second one
went out under a 30fps recording, and so did the `INFO` to NickServ. Measuring
the luminance of the timeline row across frames:

| frame | ms after Enter | peak luminance of the row |
|---|---|---|
| 0064 | 0 | 13 (background — nothing drawn) |
| 0065 | 33 | 124 |
| 0073 | 300 | 124 |
| 0074 | 333 | 216 |

So: **the line was drawn on the next frame after Enter, at the reduced opacity
`MessageRow` gives `pending`, and settled to full opacity 300ms later.**
`09-send-pending.png` and `10-send-delivered.png` are frames 0065 and 0074.
Lag to the server was reading 63ms at the time, so the 300ms is the round trip
plus the echo-message match plus the archive write plus a repaint.

The archive agrees — both `##test` messages are `{"state":"delivered"}`.

### Formatting codes — #56

NickServ's reply came back on the wire as

```
<< :NickServ!NickServ@services.libera.chat NOTICE ircx-4b1d7a :␂ircx-4b1d7a␂ is not registered.
```

— visible as two boxes in the raw log, which is correct, raw is raw — and the
timeline drew `-NickServ- ircx-4b1d7a is not registered.` with no boxes and no
stray characters. `11-formatting-stripped.png`. The archive keeps the `\x02`
bytes; the stripping is at the render, which is where
`src/lib/ircFormat.ts` says it should be. Note that the bold is removed rather
than mapped onto a weight, which that file argues for deliberately.

### `/help` — #50

Fifteen lines, one per command, from `/join` to `/help this list`.
`12-help.png`. The columns do not line up — that is **#64**, known, being fixed
separately, and not re-filed.

### Searching for a hyphenated word — #55

Ctrl+F, `end-to-end`. One result: sender, target, time, and the phrase
highlighted inside the message text. `14-search-hyphenated.png`. No
`no such column: to`.

### Quit and relaunch — #52 and #51

Closing the window exited cleanly both times, and `open_targets` in the archive
held

```
##test|channel
NickServ|query
```

On relaunch the sidebar came back with `##test` under NETWORKS and NickServ
under QUERIES, both present in a frame taken one second after exec, with the
network already green. `16-after-relaunch.png`. `##test` was rejoined.

Opening `##test` showed its history: the join from the first session at 10:11,
both messages at 10:12 and 10:13, and the fresh rejoin at 10:21.
`17-restored-channel-history.png`. **#51 holds across a restart.**

## The two new defects

### The timeline stops following the tail — #67

The server console, parked at the very bottom, does not move when new lines
arrive. Run `/help`, scroll down so `/help this list` is the last visible line,
run `/help` again: fifteen more lines land, the scroll thumb shrinks, and the
viewport is unchanged. `13-console-does-not-follow.png` is the frame after.

Reading the code for the cause: `Timeline.tsx` follows on `[rows.length]`, and
`buildRows` merges consecutive system messages into one open row with no bucket
boundary, so a console — whose entire content is system messages — is one row
for the whole session and `rows.length` never changes. The same shape applies to
two messages inside one minute bucket, and to a run of joins and parts. The two
messages sent to `##test` happened to fall either side of a minute boundary,
which is why sending looked fine.

### "Beginning of history" is drawn over the conversation — #68

It is an overlay pinned to the top of the scroller, not a row, and once a
conversation holds all of its archive it is there permanently, on top of
whatever is scrolled under it. `04-server-console-motd.png` has it across a MOTD
line; `17-restored-channel-history.png` has it printed over the "Today"
separator.

## Two things seen and not filed

**#63 reproduced, as expected.** The restored NickServ query opened on "Nothing
here yet" (`18-restored-query-empty.png`) even though its two messages are in
the archive. This is the `loadOlder` bail already filed and being fixed. Worth
recording is *why* the channel escaped it and the query did not: rejoining
`##test` files a JOIN, which creates the timeline entry `loadOlder` needs. A
query has nothing to file on connect, so its entry is absent and the archive is
never read. So #63 is a query-shaped bug in practice, not a channel-shaped one.

**#64 reproduced, as expected.** `/help`'s columns do not align.

## What this run still does not cover

Unchanged from the first run except where noted:

- **SASL.** Reserved for the owner.
- **The topic path.** `##test` still has no topic.
- **Independent scrolling between split panes.** Not visited this time at all;
  panes were never split.
- **Netsplit recovery, reconnect after a socket drop.** Neither provoked.
- **The lock icon on `##test`.** Still no way to read a channel's modes from the
  interface, so still unknown whether the lock is right.
- **Attachments, previews, the drawer's pinned and embedded modes, the keyring.**
  Not visited.
- **The raw log under load.** It held roughly 200 lines comfortably. Nobody has
  watched it during a netsplit or a `LIST`.
- **A conversation closed before quitting staying closed.** The restart test
  restored two targets; neither was closed first.
