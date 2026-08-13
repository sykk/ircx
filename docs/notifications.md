# Notifications

The settings section for what is allowed to interrupt the reader: which
messages count, what happens when one arrives, and which conversations are
exempt. `docs/plugins.md` is the permission model it sits beside;
`readability/READABILITY.md` is where the unread seam and the mention tint come
from.

This was a design note until both of its pieces shipped. What it is now is the
argument behind the shape they took, which is the part worth keeping: most of
what follows explains why the code refuses something, and a reader who removes
that refusal without the reason will put it back.

Three things ended up different from the plan, and each says so where it
happened: the sound switch does not exist, the settings window became a dialog,
and clicking a notification cannot open the conversation.

## What the section owns

### Words that count beside your nick

A list of plain words, matched the way the nick is: case folded, on a word
boundary, anywhere in the line. Adding `deploy` means a line saying `deploying
now` raises the channel and tints the row exactly as your nick would.

Plain words rather than patterns. A regular expression is a rule you cannot
debug from the settings window — it either matches too much for reasons the
reader cannot see or matches nothing and reports no error — and the escape
hatch for anyone who wants one already exists and is better: a notification
rule is arbitrary JavaScript with an explicit permission and a strike counter
behind it. The built-in floor stays the thing a plugin does not need to exist
for.

Global rather than per network. The question a keyword answers is "tell me
when anybody says this", and nobody wants to be told about `deploy` on one
network and not the other badly enough to pay for the list being four lists.

### What a highlight does

Two switches over the badge, which is unconditional. Both default to off,
because a client that starts interrupting somebody the first time it is run has
decided something that was theirs to decide.

- **Notify me about highlights.** Your nick or one of your words, in a channel.
- **Notify me about direct messages.** Any line in a query. A separate switch
  rather than a case of the one above: a DM carries no keyword and needs none,
  because somebody opened a conversation with you and nobody else. The two are
  wanted separately — a reader who has notifications on for DMs and off for
  keywords is asking for something coherent.

**The third switch was Sound, and it could not be told the truth.** The plugin
takes the *name* of a sound to play, so turning it off leaves whatever the
desktop plays for a notification anyway. A switch labelled Sound that cannot
make one silent is worse than no switch, so `Notifications`
(`src/lib/notifications.ts`) has two fields and the page has two rows.

The badge is not a switch. Turning off the count of what you have not read is
not a notification setting, and the reader who wants a conversation to stop
counting has muted it.

### Muted conversations

Mute means *never interrupt me here*. Precisely:

- No desktop notification.
- `channel.highlights` does not rise, so the badge stays quiet even for your
  own nickname.
- `channel.unread` still rises, and the badge still shows the number. A muted
  channel is still unread; not counting it at all is *ignore*, which is a
  different act nobody asked for.
- Rules are still asked, the raise is still written to the `raised` table, and
  the message still draws its `RaisedLine`. Mute is a statement about being
  interrupted, not about the record — a channel unmuted next week should still
  show what the deploys plugin thought was worth reading in it.

That last point is the one that costs something. Skipping `notifiers()`
entirely in a muted conversation would be cheaper and is the obvious
implementation; it is wrong, because it silently drops an annotation the
archive is the only copy of. Mute is applied at `session.raise()`, after the
rule has answered.

Muting is per conversation, and a network can be muted whole — the same shape
`retention` has, a table keyed `(network, target)` where an empty target is the
network's own rule.

A query can be muted, and mute means there what it means everywhere. In a query
the loud badge is already the plain one, so what mute actually suppresses is the
desktop notification, and that is the case it is reached for: a bot sending you
build output in a DM. This is not a blocking feature under another name — the
lines still arrive, the badge still counts them, the conversation still opens.
The client has no `/ignore`, and mute is not the place to grow one.

Two costs come with keying a query's mute on a nick, and both are already
retention's. A mute follows a rename, beside the draft it travels with
(`IrcxEvent::QueryRenamed` → `move_draft`) — the bot that renames should stay
quiet, and a rename that silently un-mutes is the failure that interrupts you.
And a nick is not a person: whoever takes the nick next inherits the mute.
Retention has held that trade since it shipped, and mute is the more recoverable
of the two — it is undoable, and the list on this page says the conversation is
muted, where retention just deletes.

## Queries have no loud state, and it is deliberate

The words are matched in a query the way they are matched anywhere — the row
tints and `splitOnMention` picks the word out, which is what already happens
there for your nickname, since `isHighlight` passes no roster in a query. What a
match does not do is change the badge, and that is right rather than a gap: a
query's badge is already the loud one. Its presence means somebody opened a
conversation with you and nobody else, and a red one would say the same thing in
a second colour. The sidebar reasons this way about queries already, drawing
presence as a quiet dot rather than a badge.

So `Query` has no `highlights` field, the sidebar's network header aggregates
highlights from channels alone, and `session.raise()` in a query is a no-op —
but a commented one, because as it stood it read as an oversight and a future
reader would have fixed it into a bug. What a raise means in a query is the
`raised` row and the `RaisedLine` under the message, which is the record, and
that part works.

The attention a DM deserves is real, and it is answered one level up: the
direct-message switch fires on any line in a query, which is what somebody who
wants to be told about DMs was actually asking for. Routing it through a keyword
match would have been the wrong mechanism — it would notify for `syk: ping` in a
DM and stay silent for `the build is broken`, in a conversation where both are
equally addressed to you.

`docs/plugins.md` carries the consequence for rule authors: a rule can raise in
a query and the badge will not move, whatever it answers.

## Where the settings live

**The words and the mutes are the backend's.** The badge is counted in
`ircx-core` against `self.nick`, so the words have to reach a running session,
and mute has to be readable by whatever decides not to raise. Both are stored
the way retention is (`crates/ircx-store/src/migrations.rs`):

```sql
CREATE TABLE highlight_word (word TEXT PRIMARY KEY COLLATE NOCASE);
CREATE TABLE muted (network TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', ...);
```

Four commands beside `set_retention`, each returning `Result<T, String>` with
the error written for a reader:

```text
highlight_words()                    -> Vec<String>
set_highlight_words(words)           -> ()
muted_conversations()                -> Vec<MutedConversation>
set_muted(network, target, muted)    -> ()
```

`set_highlight_words` writes the table and then tells every live session, by
walking `App.networks` the way any command that reaches a session does. A
session holds the words beside the nick it already holds and matches on both.

**The two switches are not**, and they are the exception the rest of the page
explains. They live in `localStorage` under `ircx.notifications`, beside every
appearance setting and for the same reason: nothing in Rust needs to know
whether a desktop notification was wanted. The badge is counted in the backend;
the interruption is decided in the window that would be interrupted. They are
read out of storage as each batch of messages arrives, so nothing has to
announce a change to anybody.

`muted_conversations` exists because a page needs to unmute a conversation the
reader is not standing in. A page that can only mute the channel you happen to
be looking at is a page that cannot unmute anything else, and a silent channel
whose silence you cannot find the cause of is worse than no mute at all. So: the
scoped control for here, and a list of everything muted with a way out of each.

**The scope is read rather than handed over**, and that is the settings dialog's
doing. As a second window these pages had no conversations of their own and the
client wrote the answer into `localStorage` for them; a dialog sits over the
window that has one, so `SettingsScope` (`src/components/settings/scope.ts`)
asks the store. It follows the reader as they move between channels, which the
snapshot could not.

The sidebar marks a muted conversation, which is the thing that answers "why is
this quiet" where the reader is actually standing.

## The rule in two languages

Adding words did not create the duplication between `text::mentions` and
`selectors.ts` — that was already there — but it widened it from one value both
sides can hold to a list both sides have to agree about, and the two have
different jobs: Rust decides the badge and what plugins are asked, TypeScript
decides the tint and which span inside the line gets marked.

They are bound by a shared fixture, `fixtures/highlight.json`: a table of
`(text, nick, words) -> matches` asserted by both `cargo test -p ircx-core` and
vitest. It was new machinery — nothing else in the repo tests one rule from both
sides — and it is the cheapest thing that fails loudly when one side learns
something the other does not.

The alternative was having Rust mark each message and the frontend believe it.
It does not work: `splitOnMention` needs to know *which* word matched to pick it
out of the prose, so the frontend needs the words whatever else it is handed,
and replayed history would need the flag recomputed against today's words
anyway.

## Desktop notifications

`tauri-plugin-notification`, a `notification:default` entry in
`capabilities/default.json`, and `src/lib/notifications.ts` deciding what is
worth one. `worthNotifying` holds every reason to stay quiet in one place, in
the order they cost least to ask: the reader's own line, the server console, a
backfill, a muted conversation, the conversation they are watching.

Two rules there are behaviour rather than settings:

- **Nothing notifies for the conversation you are looking at**, where the window
  has focus. Both halves matter: the pane's focus, because a channel in the
  other half of a split is not one you are reading, and the window's, because a
  notification for the line you just watched arrive is the fastest way to get
  the feature turned off.
- **A notification names its conversation** — `phrack in #ircx` for a channel,
  the sender's nick alone for a query — because it cannot do the thing that
  would make naming unnecessary.

**Clicking one does not open the conversation, and cannot.**
`tauri-plugin-notification`'s desktop path is `notification.show()` and nothing
else: no `actionPerformed` is ever emitted, so `onAction` is mobile-only. The
title carries the conversation for that reason. Making it clickable means
notifying outside the plugin, per platform, which is a larger thing than this
feature is.

### What it costs, and what it does

`docs/measurements.md` has the binary cost with its method:
`tauri-plugin-notification` added **176.6 KiB**, seven crates, for the plugin,
`notify-rust` and what they pull in.

`docs/end-to-end-run-21.md` walked the rest of it against a real notification
daemon on Linux, which is the first time any of it was seen outside a unit test:

- The call is made, and carries `phrack in #harness` for a channel and `phrack`
  alone for a query.
- The focus rule holds in both directions — the same line from the same client
  raises nothing while the window has focus and one notification when it does
  not.
- Twenty messages sent at once are twenty notifications inside eight
  milliseconds. The client neither drops one nor coalesces them, which leaves
  that the desktop's business.
- On Linux there is nothing to grant; on macOS the first `requestPermission` is
  a system dialog, and a refusal leaves the switch off.

**They arrive out of order.** Twenty sent in sequence reached the bus as `2, 1,
3, 4, 6, 7, 5, …` while the timeline held them in order. Nothing here can fix
it: `sendNotification` returns `void`, so there is no handle on the ordering.
Like the click target, ordering them means notifying outside the plugin.

## What the section refuses

- **Per-network or per-channel keywords.** Configuration nobody asked for, and
  four lists to keep in your head instead of one.
- **Regular expressions, and a case-sensitivity switch.** The plugin hook is
  the answer for anyone who needs either. A switch also doubles the matcher,
  which is the thing being asserted from two languages.
- **A sound switch, and a sound file picker.** The system sound or nothing, and
  no switch that cannot make it stop.
- **A "notify only when away" mode.** Away is a server state people set and
  forget; focus is the fact the rule actually wants, and it is already known.
- **A quiet-hours schedule.** A clock that changes what the client does at
  10pm is a feature with its own timezone bugs, and mute already answers the
  case it was reached for.

The section is called Notifications in the sidebar, between Appearance and
Uploads: what the window looks like, then what reaches you, then where files go,
then what is written down, then what other people's code may do.
