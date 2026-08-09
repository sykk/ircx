# Notifications

A settings section for what is allowed to interrupt the reader: which messages
count, what happens when one arrives, and which conversations are exempt.

This is a design note, not a description of something built. `docs/plugins.md`
is the permission model it sits beside; `readability/READABILITY.md` is where
the unread seam and the mention tint come from.

## What exists

The client already decides what is worth your attention, and none of those
decisions has ever had a setting attached to it.

**The host's own rule is your nickname.** `text::mentions`
(`crates/ircx-core/src/text.rs:100`) matches the nick on a word boundary, case
folded. `count_towards_unread` (`crates/ircx-core/src/message.rs:417`) calls it
on arrival and bumps `channel.highlights`, which is what turns the sidebar
badge loud (`SidebarNetworks.tsx:419`). Queries carry `unread` alone: a DM has
nobody else in it, so every line in one is already addressed to you.

**A plugin can raise anything else.** A rule holding
`Permission::RaiseNotifications` is asked about each batch
(`Action::Notify` → `task.rs:1003`), answers with message ids, and each one is
written to the archive's `raised` table and sent as `IrcxEvent::MessageRaised`,
which bumps the same counter through `session.raise()`. The type is one-way:
`NotifyReply` has a `raised` field and no field for the opposite, so a rule
cannot quiet a message the host or another rule raised. `worth_raising`
withholds from rules anything that already mentions you, on the grounds that the
call could not change the outcome.

**The frontend re-derives the same judgement for what it draws.**
`isHighlight` (`src/store/selectors.ts:253`) decides the row tint,
`splitOnMention` picks the nick out inside the text, and the unread seam counts
"N of them mention you". It is deliberately not the same rule as the Rust one —
it also requires the sender to still be in the channel, which is what keeps
replayed `HistServ` narration of your own joins from reading as a mention
(#222).

**A raise in a query is dropped on the floor.** Nothing filters queries out of
`worth_raising` or out of the `Action::Notify` push, so a rule is asked about
DMs, answers, and has its answer written to the `raised` table and sent as
`MessageRaised` — the row draws its `RaisedLine`. Then `session.raise()`
(`crates/ircx-core/src/session.rs:431`) looks the target up in `self.channels`,
finds nothing, and returns. A `Query` has `unread` and no `highlights`
(`crates/ircx-ipc/src/model.rs:273`), so there is no counter for it to reach.
This is not deliberate, and what to do about it is the section on queries
below.

**Nothing raises a desktop notification.** There is no
`tauri-plugin-notification` in `src-tauri/Cargo.toml` and no notification
permission in `src-tauri/capabilities/default.json`. A highlight is a red badge
and a tinted row, and that is the whole of it. There is also no mute: the string
does not appear in the tree.

So the page has three questions to answer, and each of them is a gap rather
than a preference over something already configurable.

## What the page owns

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

Three switches over the badge, which is unconditional:

- **Notify me about highlights.** Your nick or one of your words, in a channel.
  Off by default.
- **Notify me about direct messages.** Any line in a query. Off by default, and
  a separate switch rather than a case of the one above: a DM carries no
  keyword and needs none, because somebody opened a conversation with you and
  nobody else. The two are wanted separately — a reader who has notifications
  on for DMs and off for keywords is asking for something coherent.
- **Sound.** The system's own, off by default, offered only where one of the
  two above is on, because a sound with no notification is an interruption with
  no way to find out what it was about.

The badge is not a switch. Turning off the count of what you have not read is
not a notification setting, and the reader who wants a conversation to stop
counting has muted it.

### Muted conversations

Mute means *never interrupt me here*. Precisely:

- No desktop notification and no sound.
- `channel.highlights` does not rise, so the badge stays quiet even for your
  own nick.
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

Muting is per conversation, and a network can be muted whole. That is the shape
`retention` already has: a table keyed `(network, target)` where an empty target
is the network's own rule (`crates/ircx-store/src/migrations.rs:140`).

A query can be muted, and mute means there what it means everywhere. In a
query the loud badge is already the plain one, so what mute actually suppresses
is the desktop notification, and that is the case it is reached for: a bot
sending you build output in a DM. This is not a blocking feature under another
name — the lines still arrive, the badge still counts them, the conversation
still opens. The client has no `/ignore`, and mute is not the place to grow
one.

Two costs come with keying a query's mute on a nick, and both are already
retention's. A mute follows a rename, beside the draft it travels with
(`IrcxEvent::QueryRenamed` → `move_draft`, `task.rs:767`) — the bot that
renames should stay quiet, and a rename that silently un-mutes is the failure
that interrupts you. And a nick is not a person: whoever takes the nick next
inherits the mute. Retention has held that trade since it shipped, and mute is
the more recoverable of the two — it is undoable, and the list on this page
says the conversation is muted, where retention just deletes.

## Queries have no loud state, and should not get one

The words are matched in a query the way they are matched anywhere — the row
tints and `splitOnMention` picks the word out, which is what already happens
there for your nick, since `isHighlight` passes no roster in a query. What a
match does not do is change the badge, and that is right rather than a gap: a
query's badge is already the loud one. Its presence means somebody opened a
conversation with you and nobody else, and a red one would say the same thing
in a second colour. The sidebar reasons this way about queries already, drawing
presence as a quiet dot rather than a badge.

So `Query` does not grow a `highlights` field, the sidebar's network header
goes on aggregating highlights from channels alone (`SidebarNetworks.tsx:86`),
and `session.raise()` in a query stays a no-op — but a deliberate one, with a
comment saying why, because as it stands it reads as an oversight and a future
reader will fix it into a bug. What a raise means in a query is the `raised`
row and the `RaisedLine` under the message, which is the record, and that part
already works.

The attention a DM deserves is real, and it is answered one level up: the
desktop-notification switch for direct messages fires on any line in a query,
which is what somebody who wants to be told about DMs was actually asking for.
Routing it through a keyword match would have been the wrong mechanism — it
would notify for `syk: ping` in a DM and stay silent for `the build is broken`,
in a conversation where both are equally addressed to you.

One consequence for the plugin contract: a rule can raise in a query and the
badge will not move, whatever it answers. That is worth a line in
`docs/plugins.md` beside the existing statement that a rule can raise and
cannot lower, because "raised, and the interface has nowhere to show it" is a
thing a plugin author would otherwise discover by testing.

## Where the settings live

Not in localStorage, which is where every appearance setting lives. The badge
is counted in `ircx-core` against `self.nick`, so the words have to reach a
running session; and mute has to be readable by whatever decides not to raise.
Both are the backend's, stored the way retention is:

```
CREATE TABLE highlight_word (word TEXT PRIMARY KEY COLLATE NOCASE);
CREATE TABLE muted (network TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', ...);
```

Two commands beside `set_retention`, each returning `Result<T, String>` with the
error written for a reader:

```
highlight_words()                    -> Vec<String>
set_highlight_words(words)           -> ()
muted_conversations()                -> Vec<Muted>
set_muted(network, target, muted)    -> ()
```

`set_highlight_words` writes the table and then tells every live session, by
walking `App.networks` (`src-tauri/src/state.rs:49`) the way any command that
reaches a session does. A session holds the words beside the nick it already
holds and matches on both.

`muted_conversations` exists because the settings window has no conversations.
It runs no event bridge, so it knows one conversation — the one the client was
on when the window was asked for, handed over through localStorage as
`SettingsScope` (`src/lib/settingsWindow.ts`), which is how the Privacy page
scopes retention. A page that can only mute the channel you happened to be
looking at is a page that cannot unmute anything else, and a silent channel
whose silence you cannot find the cause of is worse than no mute at all. So:
the scoped control for here, and a list of everything muted with a way out of
each.

The sidebar should mark a muted conversation too. That is the client's change
rather than this page's, and it is the one that answers "why is this quiet"
where the reader is actually standing.

## The rule in two languages

Adding words does not create the duplication between `text::mentions` and
`selectors.ts:mentions` — that is already there — but it widens it from one
value both sides can hold to a list both sides have to agree about, and the two
have different jobs: Rust decides the badge and what plugins are asked, TypeScript
decides the tint and which span inside the line gets marked.

Bind them with a shared fixture: a JSON table of `(text, nick, words) ->
matches`, asserted by both `cargo test -p ircx-core` and vitest. It is new
machinery — nothing in the repo currently tests one rule from both sides — and
it is the cheapest thing that fails loudly when one side learns something the
other does not. `presentation.test.ts` asserting every `CLOCK_FORMATS` example
against `formatClock` is the same move inside one language.

The alternative was having Rust mark each message and the frontend believe it.
It does not work: `splitOnMention` needs to know *which* word matched to pick it
out of the prose, so the frontend needs the words whatever else it is handed,
and replayed history would need the flag recomputed against today's words
anyway.

## Desktop notifications

`tauri-plugin-notification`, a `notification:default` entry in
`capabilities/default.json`, and a permission prompt the first time on macOS.

Two rules that are behaviour rather than settings:

- **Nothing notifies for the conversation you are looking at**, where the
  window has focus. The pane's focus is already tracked — `followFocus` in
  `src/lib/bridge.ts` calls `mark_read` on it — and the window's own focus is a
  Tauri window event. A notification for the line you just watched arrive is
  the fastest way to get the feature turned off.
- **Clicking one goes to the conversation.** A notification you cannot act on
  is a sound with a picture.

The binary cost has to be measured and written into `docs/measurements.md` with
the method, not quoted from a PR. #462 spent a week taking 780 KiB back out;
this is the first thing since to add a dependency with a system library behind
it, and if it is expensive that is worth knowing before the page ships rather
than after.

## What the page refuses

- **Per-network or per-channel keywords.** Configuration nobody asked for, and
  four lists to keep in your head instead of one.
- **Regular expressions, and a case-sensitivity switch.** The plugin hook is
  the answer for anyone who needs either. A switch also doubles the matcher,
  which is the thing being asserted from two languages.
- **A sound file picker.** The system sound or nothing.
- **A "notify only when away" mode.** Away is a server state people set and
  forget; focus is the fact the rule actually wants, and it is already known.
- **A quiet-hours schedule.** A clock that changes what the client does at
  10pm is a feature with its own timezone bugs, and mute already answers the
  case it was reached for.

## Shipping it

The section is worth landing in two pieces, because the second one carries a
dependency and a platform permission and the first does not.

**One — Highlights.** The words, the mute, `muted_conversations`, the sidebar
mark, the mute moving with a renamed query, the shared fixture, and the
`"notifications"` topic added to `SettingsTopic` (`src/lib/ipc.ts:314`) so both
windows re-read on a change. Everything here is observable without a single
notification: the badge goes loud on a keyword and stays quiet in a muted
channel.

The two notes about queries belong in this piece and are a few lines each — the
comment on `session.raise()` saying the query case is deliberate, and the
sentence in `docs/plugins.md` telling a rule author that a raise in a query
has nowhere to show.

**Two — Desktop notifications.** The plugin, the capability, the focus rule,
the click target, the two switches, and the measurement.

The section is called Notifications in the sidebar from the start. Naming it
Highlights and renaming it later is churn in `sections.ts`, in the URL the
window opens at, and in whatever the reader has learned to look for. It sits
between Appearance and Uploads: what the window looks like, then what reaches
you, then where files go, then what is written down, then what other people's
code may do.
