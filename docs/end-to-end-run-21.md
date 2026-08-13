# The twenty-first run: the half of a notification no test can see

Run on 2026-08-12 against a local `ergo` 2.19 on `127.0.0.1:6712`, in the
assembled release app on `Xvfb :103`, against `main` at `c6f19fe`.

Runs 12 to 20 spent nine runs on history paging and run 20 closed the thread.
This one goes somewhere nothing has been: `docs/manual-verification.md` says
plainly that nothing in the suite raises a notification, that `worthNotifying`
is tested for every reason it stays quiet, and that **everything after it** —
`sendNotification` reaching a daemon, the permission prompt, the focus rule, a
burst — needs a person on each desktop.

It needed a person because a notification ends up on somebody's screen. It does
not need one to answer whether the call was made, what it carried, and how many
there were, because a notification is a D-Bus method call before it is anything
visual. `notifyd.py` owns `org.freedesktop.Notifications` on a session bus of
this run's own and writes down every `Notify` it is told. It is not a mock:
`tauri-plugin-notification` reaches it by exactly the path a desktop's own
daemon is reached by, so a call recorded here is a call the shipped client made
to a real notification service.

## What was asked

Four things, in the order they cost to set up. `walk.sh` drives the window, the
second client and the X focus in turn, and puts a marker in the notification log
between segments so they are separated by position in one file rather than by
two clocks with different zeros.

| segment | what it is |
|---|---|
| `focused-watching` | a highlight in the conversation on screen, window focused |
| `blurred` | the same line with the focus taken away |
| `refocused` | and given back |
| `burst` | twenty at once |
| `query` | a PRIVMSG to the walker rather than to the channel |

## What it found

Everything the feature claims, claimed correctly. `counts.txt`, from the walk on
this run's own server:

```text
walk  segment                      raised  detail
   1  focused-watching                  0
   1  blurred                           1  phrack in #harness
   1  refocused                         0
   1  burst                            20  phrack in #harness — out of order
   1  query                             1  phrack
```

**The call is made and it reaches a real daemon.** `app` is `ircx`, `summary` is
`phrack in #harness`, `body` is the message. That is the first time any of it
has been observed outside a unit test.

**The focus rule works in both directions, and it is the whole of the
difference.** The same sentence from the same client into the same channel
raises nothing while the window has the focus and one notification when it does
not. Nothing else changed between those two segments — the same second client,
still joined, one `XSetInputFocus` apart. `onFocusChanged` is the only input to
that decision and no test can drive it, which is why this was worth a walk.

**A query is titled by the sender alone**, `phrack`, where a channel message is
titled `phrack in #harness`. Both match what the page tells the reader.

**On Linux there is nothing to grant.** The switch goes on and stays on, with no
system dialogue between the click and the notification — `switches-on.png` is
both switches checked, the client connected to `127.0.0.1:6712`, and no prompt
anywhere. The refusal path stays as `docs/manual-verification.md` has it: tested
against a mocked refusal, never against a real one, because this desktop has no
way to refuse.

**Twenty arrive, and none is dropped or coalesced.** Twenty messages sent in one
write became twenty `Notify` calls inside eight milliseconds. Whether a desktop
stacks them is the desktop's business, as that document says; what is settled
here is that the client does not decide it for them.

## The one thing that is not in order

Those twenty arrive **shuffled**: `2, 1, 3, 4, 6, 7, 5, 8, 9, 10, 17, 18, 19,
20, 16, 15, 11, 12, 14, 13`. `burst-in-order.png` is the same twenty in the
timeline, `burst 01` to `burst 20`, in the order they were sent. So the pane is
ordered and the notification stack is not, from one loop over one batch.

The first walk of the run supplies the control by accident. It ran against a
server that was still applying fakelag (below), so the same twenty arrived five
at once and then one every 500 ms — and in that walk the order held, save for
one swap among the five that were simultaneous. Spaced out, the order survives;
sent together, it does not.

**Nothing in `notifications.ts` can fix this**, which is the useful half of the
finding. `sendNotification` returns `void` — it is `new window.Notification(...)`
— so there is nothing for the loop to await and no handle on the ordering. The
calls leave the page in order and reach the bus shuffled, somewhere below it. To
order them the client would have to raise notifications itself rather than
through the plugin, per platform, which is the same larger thing
`docs/manual-verification.md` already declines for the click target.

So it is written down as a property of the path rather than as a defect with a
fix, and the cost is small: a reader who steps away and comes back to twenty
notifications gets them out of order, in a stack whose whole purpose is to be
skimmed rather than read in sequence.

## The harness finding, which is run 19's for the second time

**The first walk ran against another session's proxy.** `ergo.sh` started this
run's server on 6688 with fakelag off, waited for `ss -lnt | grep 127.0.0.1:6688`
and reported success. Ergo had failed to bind — *address already in use* — and
what was answering on 6688 was a `python3` proxy belonging to a concurrent
session, forwarding to their ergo on 6677 with fakelag on. The walk connected,
the client joined, the notifications were real, and the burst had a shape the
config said was impossible.

The check verified that somebody was listening. That is not the question. It now
matches the pid in the socket's own line against the pid it started, and refuses
a port that is already taken before writing the config. Run 19 found the same
thing wearing a different hat, when `pgrep -x ircx` matched another session's
debug build: **on a shared machine a name is not an identity, and neither is a
port.**

The result stands anyway, and it is worth saying why rather than leaving it to be
assumed. Every finding above except the burst timing is a count of notifications
against a focus state, and both walks agree on every one of those counts. The
burst is the only measurement the wrong server touched, and it was re-taken —
`burstcheck.txt` is two bare clients on this run's server, twenty messages in one
write, all twenty delivered inside a millisecond and no client under test in the
picture at all.

## What this does not say

**Nothing about what a desktop does with a notification.** `notifyd.py` draws
nothing. Whether a real daemon coalesces twenty, how long one stays up, and what
the notification looks like are all still a person's to check, and the entry in
`docs/manual-verification.md` keeps saying so.

**Nothing about macOS.** The permission prompt there is a system dialogue and
this run is Linux. The entry keeps that too.

**Nothing about the click target.** It is still true that
`tauri-plugin-notification` emits no `actionPerformed` on desktop, and this run
did not try to click one.

## For the next run

The notification path is walked as far as a machine can walk it, and what is
left needs eyes. Two things elsewhere are worth more than another notification
run:

- **A release-build walk of something already covered.** Almost every walk in
  this series is the debug build against Vite, which means `StrictMode`. This
  run is release throughout — that is why the burst count means anything, since
  a double-mounted bridge would have raised forty — and it is the first that
  can say so plainly.
- **`docs/notifications.md` is stale.** It opens with "This is a design note,
  not a description of something built", and both of the pieces it says to ship
  have shipped. It should describe what exists, and this run's numbers are what
  its *Desktop notifications* section was waiting for.
