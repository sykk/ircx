# End-to-end run 38: the rest of what interrupts the reader

Run 21 walked the half of a notification no test can see: that
`sendNotification` reaches a real daemon, what it carries, that the focus rule
works in both directions, and that twenty at once are twenty. What it did not
walk is the rest of `worthNotifying` — the mute, a word added while the client
is running, a line that arrives as history rather than live, and a person the
reader has ignored. Those are unit-tested against a store the test builds, and
this run puts them on a live server.

Thirteen provocations, five notifications, and a defect that has nothing to do
with notifications.

## The instrument is run 21's

`notifyd.py` is that run's, copied rather than written again: it owns
`org.freedesktop.Notifications` on a session bus of the walk's own, answers the
two questions `notify-rust` asks before it sends anything, and appends one JSON
object per `Notify`. Its docstring is the reason it looks the way it does, and
both of the traps it names — own the name *before* the app starts, answer
`GetCapabilities` — are traps this run would otherwise have fallen into, because
`notifyForEvents` catches its own failures and a walk reads a swallowed error as
a rule working.

What is new here is only the plumbing around it: `walk.py` is run 37's, started
under `dbus-run-session` with the daemon as its first child, so the window
inherits the bus and nothing reaches the operator's desktop.

## What was raised, and what was not

Both switches default to off and the run turned them on from the settings dialog
(`notifications-page.png`, `both-switches-on.png`). Nothing prompted for
permission, which is run 21's finding holding: on Linux there is nothing to
grant.

| provoked | switches | where the reader was | raised |
|---|---|---|---|
| `walker: are you there` | both off | another channel | — |
| `walker: the build is green` | highlights | another channel | **`sable in #run38`** |
| `nothing to do with anybody` | highlights | another channel | — |
| `walker: and again, while you are here` | highlights | **that channel** | — |
| `hello, a private word` (query) | + direct | a channel | **`nyx`** |
| `while you are reading this one` | + direct | **that query** | — |
| `and now from somewhere else` | + direct | a channel | **`nyx`** |
| `walker: muted now…` | highlights | another channel, **channel muted** | — |
| `deploy failed on main` | highlights, `deploy` added | another channel | **`sable in #run38`** |
| `redeployed the branch twice` | highlights, `deploy` added | another channel | — |
| `walker: and the nick, for a control` | highlights | another channel | **`sable in #run38`** |
| `walker: and now with the switch off` | **highlights off** | another channel | — |
| `walker: said while you were disconnected`, arriving **as history** | highlights | another channel | — |

Five of those rows are the ones run 21 left:

**A word added while the client is running takes effect on the next line.**
`deploy` went in through the settings dialog and `deploy failed on main` raised
one with no restart between them (`word-added.png`), while `redeployed the
branch twice` raised nothing — the boundary the page promises is what the live
path does, and the timeline agrees with the daemon by tinting the first and not
the second.

**A mute silences the interruption and nothing else.** The badge still counted.

**A query the reader is looking at raises nothing**, where run 21 walked only
the query they are not.

**A backfill is not an interruption.** The line said while the client was
disconnected came back on the reconnect, drew above the *Live from here* seam,
counted toward the badge, and raised nothing
(`backfill-above-the-seam.png`). That is `message.source !== "live"`, walked
rather than asserted.

**A person the reader ignores raises nothing**, which
`docs/manual-verification.md` has named as unwalked since run 34. Same channel,
same mention, one `/ignore sable` apart: `sable in #ign38` before
(`notified-ignore.jsonl`), and after it nothing on the bus, no row, and a badge
that did not move off the one the first mention left
(`ignore-confirmation.png`). That is the ignore taking effect at the door, where
`append` drops the line before it is an event at all — there is nothing for a
notification to be raised from.

## What the run found, which is not about notifications

**`/quit` leaves the client saying it is connected** — #587.

The step that provoked the backfill was `/quit`, and what it left behind is a
window that says `Connected to 127.0.0.1:6677` in the status bar, a green dot
beside the network in the sidebar, a member list with everybody still in it, and
a command palette offering **Disconnect walk** — while the server answers
`401 No such nick` for the client's own nickname, and `NAMES` on the channel it
was in returns everybody except it.

The client is not wrong about this everywhere. The composer refuses every line
with *Not connected to walk — connect first*, which is the backend's own
sentence, in red, above a message that stays in the box
(`says-connected-refuses-to-send.png`). One window holds both answers at once,
and the two a reader glances at are the wrong ones.

The mechanism is one `return`. `/quit` is `Action::Close`, which
`crates/ircx-core/src/task.rs` turns into `Control::Stop`:

```rust
if stop {
    return;                                   // ← /quit leaves here
}
…
let actions = session.on_disconnected(&reason);   // ← what tells the UI
```

`on_disconnected` publishes the status the sidebar and the status bar read, and
the deliberate stop returns before it. The task ends, the handle stays in the map
with nothing behind it, and every send fails on a dropped receiver — which is
exactly the error the composer draws.

The asymmetry is the argument that this is a defect rather than a decision.
`AppState::disconnect` in `src-tauri/src/state.rs` — the route the sidebar's own
Disconnect takes — removes the handle **and** publishes
`ConnectionChanged { Disconnected }` itself. Two ways to put a network down, and
only the typed one is silent.

It is recoverable without a restart: `/connect` brought the session back,
rejoined the channel and filled the gap — which is how the backfill row above
was provoked. A reader who does not think to type it is looking at a client that
says it is connected and will not send anything.

## What this does not claim

- **Anything about an unfocused window.** Run 21 settled the focus rule in both
  directions with `xfocus.c`, and this run did not repeat it: every row above is
  a focused window, and `watching()` is what the same-conversation rows test.
- **That any real desktop draws these.** What is measured is the call. A daemon
  that drops, batches or stacks them is the desktop's business and this stub is
  not one.
- **Anything about clicking one**, which the design says cannot open the
  conversation, or about a plugin's notification rule, or about muting a whole
  network rather than a conversation.
- **The archive.** No restart; every row is the live path.

## Two things the harness learned

**Escape does not close the settings dialog from inside a field**, which is
`isTextEntry` working as designed — a value being typed is what the key
abandons. A walk that types into *Add a word* and then presses Escape is still
in the dialog, and the steps after it land somewhere other than where the script
says. `Done` is the close that always closes. One step of this run was measured
twice for that reason, and the first measurement is not in the table.

**The command palette has no entry for a settings section.** Searching `Notif`
answers *Nothing matches Notif*; the way in is `Sett`, and then the rail.
