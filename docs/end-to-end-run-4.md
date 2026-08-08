# The fourth run: the queue, watched

Run on 2026-08-02 against a local `ergo` 2.19 on `127.0.0.1:6667`, in the
assembled app on `Xvfb :98`.

The three runs before this one walked the app end to end. This one went after a
single thread — what a paste looks like while it drains, and what a cut does to
it — because that thread had been built blind. #332, #334, #339, #340, #341 and
#342 all shipped against evidence read out of the archive: the last two runs
never got a conversation on screen, so nothing anybody had built for this case
had been looked at.

Everything below is a first.

## What made it possible

Two things, and neither is a change to the client.

**A window that opens itself.** #344 landed hours before this run: an empty
window takes the first conversation there is. The profile was seeded with a
network whose `connect_commands` join `#walk`, and the app came up in the
channel with nobody touching it — `01-opens-itself.png`. That is the same change
verified in Chrome through the walk driver, now in WebKitGTK.

**Input injection, which this host turns out to have.** `docs/manual-verification.md`
recorded that there is none — "no `xdotool`, `ydotool` or `wtype`" — and that was
a statement about installed tools rather than about the machine. `gcc`,
`/usr/include/X11/extensions/XTest.h` and `libXtst` are all present, and a
hundred lines of C over `XTestFakeKeyEvent` types and clicks into the real
window. Every keystroke below went through it.

**Set `GDK_BACKEND=x11` and unset `WAYLAND_DISPLAY` first.** GTK prefers Wayland
when `WAYLAND_DISPLAY` is set, so an app launched with `DISPLAY=:98` opens its
window on the operator's actual desktop instead — the Xvfb root stays black and
nothing says why. This is the same hazard the third run wrote up as "a rootful
`Xwayland` is an ordinary window on the operator's desktop", wearing different
clothes. `xprop -name ircx` against `:98` answers it in one line.

## The topic path

The open item this closes asked two things: that the header draws a topic it is
given, and that a `/topic` typed by the user comes back from the server changed.

**The second works.** `/topic release notes, and who is taking them` typed into
the composer reached `ergo`, which relayed it back:

```text
:walker!~u@f6u3beryjfghu.irc TOPIC #walk :release notes, and who is taking them
```

read off a probe client in the channel, and the timeline drew `walker set the
topic of #walk to release notes, and who is taking them`.

**The join path works too.** A restart with the probe holding the channel open
brought the topic back as `332` and `333`, and the timeline drew both lines —
`02-topic-on-join.png`:

```text
The topic of #walk is: release notes, and who is taking them
Set by walker on 2026-08-02 at 22:54 UTC
```

**The first does not, and the reason is that nothing draws a topic at all.** The
pane header reads `#walk   2 members` with the topic set and showing in the
timeline two rows below it. `ChannelHeader.tsx` contains no reference to a topic
and neither does anything else: `channel.topic` crosses `ircx-ipc`, is parsed by
`on_topic_reply` and `handle_topic`, is asserted in `session.rs`, reaches the
store — and the only component in the app that renders it is the `/list`
browser, for channels the user has not joined. Filed as #345.

Worth knowing before reproducing it: **an empty unregistered channel ceases to
exist on `ergo`, and takes its topic with it.** The first attempt at the join
path restarted the client alone, which emptied `#walk`; the rejoin made a fresh
channel with no topic and no `332`, which reads exactly like the client dropping
it. A second client has to stay in the channel. The same footnote is already
under the lock-icon entry for the same reason.

## A paste, while it drains

Forty lines typed into the composer as one message with `Shift+Enter` between
them, sent with one `Enter`.

**The count is on screen** — `03-waiting-to-send.png`. Three seconds in, the
composer's hint row reads `31 waiting to send` where `Markdown is supported`
normally sits, and every message row visible in the pane is drawn at the pending
fade. That is #340 against a real socket, which its own entry says nobody had
seen.

It also settles what #339's entry argued about the fade. Every row on screen is
queued, so there is nothing unfaded to compare against, and the fade conveys
nothing on its own. The count is doing the whole job. The entry reasoned its way
to that and this is the picture of it.

## The cut

A second paste of forty lines, and `ergo` killed four seconds in.

Read off the probe: **twelve delivered before the cut, twenty-eight failed
after it, and nothing between them lost.** 12 + 28 = 40, which is the accounting
#332 and #334 built.

**One notice for the twenty-eight** — `04-one-notice-for-the-run.png`:

```text
cut line 78                                              Not sent
cut line 79                                              Not sent
cut line 80
28 messages were not sent — not connected to ergo   Retry
```

Every row of the run is marked in the column the reply controls would have used,
and the last row carries the one notice and the one `Retry`. That is #342, and
before it this screen held twenty-eight notices and twenty-eight `Retry` links.

The status bar counted the reconnect down — `Reconnecting to 127.0.0.1:6667 in
2s`, then `17s` as the backoff grew — and reconnected and rejoined on its own
once `ergo` came back.

## Retry, against a real socket

The one `Retry` was clicked once. All twenty-eight lines went, read off a second
probe:

```text
87.850  cut line 53   ┐
87.858  cut line 54   │  the burst
87.919  cut line 55   │
87.998  cut line 56   │
88.028  cut line 57   ┘
88.529  cut line 58   ┐  500 ms apart
89.030  cut line 59   │
  …                   │
99.541  cut line 80   ┘
```

`53` through `80` with nothing doubled, nothing missing and nothing out of
order, paced by the same rate limiter that was draining them when the connection
went. Eleven and a half seconds for a click.

**The link moves while you are aiming at it.** The first click missed, because
the reconnect had drawn its rejoin rows and pushed the notice up the pane
between the screenshot and the click. Nothing was wrong with the control; a walk
that clicks by coordinate has to screenshot and click without letting the
timeline move in between.

## What this run did not reach

- **The export.** Still the file dialog, still unanswered — though a harness
  that can click can probably answer one now, which is the first time that has
  been true.
- **A screen reader.** The queue's announcements are still only asserted as a
  tree. Nobody has heard them.
