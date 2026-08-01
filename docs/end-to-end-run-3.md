# Driving the assembled application, third time

A third session of the real app, 2026-08-01, against a local `ergo` rather than
against Libera. Runs one and two went to Libera because that is the network this
milestone targets. This one could not: what is unverified here is
`draft/chathistory`, merged the same day in #220, and Libera advertises no
history to ask for.

**The backfill works, in a window, for the first time** — on a first join, on a
rejoin after parting, and across a restart with the app closed while the channel
moved on. Six defects turned up around it, filed as
[#221](https://github.com/sykk/ircx/issues/221) to
[#226](https://github.com/sykk/ircx/issues/226). No code was changed; the report
is the deliverable.

| | |
|---|---|
| [#221](https://github.com/sykk/ircx/issues/221) | History is drawn exactly like live conversation, and a service narrating joins reads as a person |
| [#222](https://github.com/sykk/ircx/issues/222) | A join line replayed from history is marked as a mention |
| [#223](https://github.com/sykk/ircx/issues/223) | Nothing marks what arrived while ircx was closed |
| [#224](https://github.com/sykk/ircx/issues/224) | Splitting a pane is reachable only by a shortcut nothing mentions |
| [#225](https://github.com/sykk/ircx/issues/225) | A search result and the message it found disagree about the clock |
| [#226](https://github.com/sykk/ircx/issues/226) | The certificate-verify checkbox stays live with TLS switched off |

Four of the six are about the same thing from different angles: a message the
server replayed is indistinguishable from one somebody is typing now.

## How it was run

The debug binary from `main` at `7780952`, against the Vite dev server on 5183 —
the two halves of `npm run tauri dev` started separately so the environment could
be controlled. `XDG_DATA_HOME` pointed at a scratch directory, so the archive
under test was `…/scratchpad/profile5/data/chat.ircx.app/ircx.sqlite3`.

The window ran on **`Xvfb :98` at 1280x880**, which is the one change of method
from runs one and two. Those used a nested `Xwayland :99`, which is a real window
on the operator's desktop: it takes focus and keystrokes like any other window,
and a first attempt at this run was abandoned because the operator's typing and
the harness's XTEST events went into the same application. The report drawn from
that attempt was wrong, and the correction is worth more than the attempt was —
**a rootful nested X server is not an isolated one.** Xvfb has no window and
cannot be typed into by accident.

Input went through XTEST via `ctypes`, so the clicks and keystrokes below took
the same GTK and WebKit path a person's would.

The second client is a 40-line Python IRC client driven through a FIFO, under
the nick `phrack`. Ergo relays what Libera drops, and it has the history this run
is about.

## What happened, in order

### Onboarding, and a plaintext server

First launch against an empty profile: "Welcome to ircx", three routes, "Skip for
now". `01-welcome.png`.

"Connect to an IRC server" asks for an address and a nickname and says TLS and
reconnect are already on. It has no port and no TLS control, which is the right
default and the wrong form for a loopback ergo, so: "Show every setting".
`02-server-form.png`.

Filling `127.0.0.1` and clearing "Connect over TLS" **moved the port from 6697 to
6667 on its own**, and the network name and username placeholders followed the
address and the nickname. `03-advanced-filled.png`. The certificate-verify
checkbox stayed live underneath, which is #226.

Connected. The status bar reads `Connected to 127.0.0.1:6667 (no TLS)` with the
warning in amber, `Caps 15`, `no account`. `04-connected.png`. The security
indicator does the job the spec asks of it without a panel.

### A channel with a past

`phrack` said three things in `#run3` before ircx had ever been in it. Joining
from the palette drew them. `05-joined-with-history.png`.

That is the `LATEST` request, and it is the first time a chathistory answer has
been drawn in the assembled application. The messages are grouped under one
`phrack` header with one spine, which is the grouping rule working on messages it
never saw arrive.

Two things in the same screenshot are wrong, and they are the run's main find.
Ergo replays presence as `PRIVMSG`s from `HistServ`, so **`HistServ` appears to
be a person in the channel narrating other people's joins** (#221), and because
one of those lines is `ircx-run3 joined the channel`, the timeline reports
**"HistServ addressed you by name"** and tints the row the way a real mention is
tinted (#222).

### The gap, and filling it

`/part`, three more messages from `phrack`, rejoin. `06-rejoined-backfill.png`.

The three missed messages come back **in the right place** — after `thanks`,
which was the last thing seen live, and before the rejoin — grouped under one
header. The presence digest above them reads `21:25  1 left, 1 joined. 2 of them
involve you.`

This is the `AFTER` request, and the ordering is what the merge added in #220 is
for. It also puts #221 at its sharpest: the live join is in the digest, quietly,
and the replayed copy of that same join is a full `HistServ` block directly
below it. One event, twice, in two voices.

### Splits

`Mod+\` splits the pane. `07-split-panes.png`. Two panes on one channel, each
with its own roster, its own composer, and **its own scroll position** — the left
pane sitting at "Beginning of history" while the right is at the bottom. That
answers the entry `manual-verification.md` has carried since run two: they do
scroll apart on screen, and it reads as two views of one conversation rather than
as two things sharing a box.

Nothing outside the keybinding reaches this. The palette answers "Nothing matches
split" and the header menu offers `Invite` and settings. #224.

### Search

One hit for `flaky`, the term picked out inside it, with nick, channel and time.
`08-search.png`. The time is `09:24 PM` where the timeline says `21:24`. #225.

### Quit, three messages, relaunch

The app was closed, `phrack` said three more things, and the app was started
again. `09-after-relaunch.png`.

The network reconnected, `#run3` came back, and **the three messages said while
the app was not running are in it**, in order. This is the case the feature was
built for and it is the first time it has been seen.

Nothing marks them as new. No badge on the sidebar row, no divider above them.
That is two deliberate rules agreeing — core keeps a backfill out of the unread
counts, and the reducer will not let one move the seam — and #223 argues the
rules are right for a rejoin and wrong for a restart.

The raw log holds the whole exchange, batch markers and all. `10-raw-log.png`.

## What this run did not cover

- **Libera.** Nothing here connected to it. Every finding is from ergo, and
  #221's cause is an ergo representation, though what it exposes is not.
- **A gap wider than the request's limit.** Three messages, not two hundred. The
  hole a truncated page would leave is still unseen, and still invisible to the
  client by construction.
- **Queries.** `CHATHISTORY TARGETS` is unbuilt, so a private message sent while
  ircx was closed is still not found at all. Deferred in #219.
- **Netsplits, plugins, uploads, themes.** All untouched here. The entries
  `manual-verification.md` carries for them are unchanged.
