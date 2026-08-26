# ircx

Desktop IRCv3 client. Rust core, Tauri 2 shell, React 19 frontend.
Product spec: `ircclient.md`. Visual reference: `docs/mockup.png`.

`docs/mockup.png` is the visual authority and is deliberately minimal: flat
sidebar, icon-only header actions, members-only context panel, no chrome that
does not earn its space. When adding UI, the question is whether the mockup
would have drawn it.

How the conversation *reads* — grouping, gutter timestamps, nick colour,
presence digests, the unread seam, typography — follows
`readability/READABILITY.md`, which supersedes the mockup on those points. The
code and tests remain authoritative for constants: the nick palette stays
inside 186-335deg, asserted by `src/styles/tokens.test.ts`.

The spine carries grouping, and its hue names the group — taken from whoever
opened it. `src/components/timeline/groups.ts` assigns each message to at most
one, on the evidence of what people typed: a `[topic]` somebody declared, or a
leading `nick:` naming somebody in the channel. An addressed group is between
the two people whose exchange opened it: a third person answering into it opens
their own rather than joining, because admitting them chained one pair's rule
into the next until a group ran down the screen. A declared topic is a fact its
author typed and still takes anybody. A group keeps the spine even
where the run names you; the mention is already marked by the line above the
run and by the tint on its row, and letting it take the spine cost the accent
the second block of every exchange the reader was in.

The spine, the clock's format, the side of the nickname it is set on, whether
the name is stated in front of every line or once above the run, and the angle
brackets an older client put round it are the reader's, on the settings
window's Appearance page beside the density and in
`src/lib/theme/presentation.ts`. They are settings
rather than tokens, for the density's reason: a theme is a set of token values,
and each of them changes what a component draws. The name on every line is the
prefix and not the column the head of a run replaced: it sits in the flow of the
prose, where a longer name cannot move the left edge the words start at.
Turning the spine off costs the hue that names a conversation, so a declared
group falls back to the name above its run and an addressed one to the two nick
colours; the gap between two blocks of one group comes back with it, there being
nothing left to span it.

Whether the mIRC codes a message arrives with are drawn is the reader's too, and
`src/lib/ircFormat.ts` is where they are read. This client used to strip them,
on the argument that mIRC's sixteen colours have nowhere to land: the warm hues
mean security state, the nick palette is pinned inside 186-335deg, and a literal
`#FF0000` is colour from outside the token system. That ruled out the palette
rather than the codes. A colour code is an index, and here it resolves to an
expression built from tokens the theme already defines — the extended palette's
own structure gives the hue (`(code - 16) % 12`) and the shade
(`Math.floor((code - 16) / 12)`), the twelve hues land on eight colour tokens
with the gaps filled by mixing the two either side, and the greys run the ramp
from `--surface-base` to `--text-primary`. Nothing in that file emits a literal
colour, which is what keeps the contract `overrides.ts` enforces intact. The
greys make the ramp one of prominence rather than of lightness, so mIRC's black
comes out faint: on a dark theme the honest alternative is text the colour of
the surface behind it, which is a refusal to render rather than a rendering.

Markdown is parsed first, on the raw line, and `applyIrcFormat` walks the tree
afterwards with one cursor — the codes mean nothing to `parseSpans` and reach it
inside ordinary text spans. The state is a machine over the line rather than a
tree, so a colour opened before a `**bold**` is still open after it, and that is
why the walk threads a cursor instead of mapping. A fenced paste keeps its text
and loses its codes: colouring it would be the client editing what somebody
pasted. What still strips everywhere is what quotes a message rather than draws
it — excerpts, search snippets, the presence digests and the system rows, a
topic change among them, those being the client's own summary lines.

The composer sends them as well as draws them, on the chords mIRC bound:
Ctrl+B, Ctrl+I, Ctrl+U, Ctrl+R and Ctrl+O, wrapping a selection when there is
one because the codes come in pairs. They are handled in the composer rather
than in `src/lib/keybindings.ts`, which dispatches actions at the app while
these edit the text in the box the way Ctrl+A selects it. The colour picker
takes Shift with it — Ctrl+K is the command palette, which the title bar
advertises — and its swatches are drawn in the values this theme resolves them
to, a swatch showing mIRC's own being a promise the timeline would not keep.
A control code puts nothing on screen inside a textarea, so a draft carrying one
is previewed above the box; that is the only thing in the composer that says a
line is being formatted at all.

The two faces and the window scale are the reader's too, in
`src/lib/theme/typography.ts`. A face is chosen from a list rather than typed,
because `src/lib/theme/overrides.ts` keeps `--font-ui` and `--font-mono` out of
a theme's reach on the argument that an arbitrary value on the root element is a
stylesheet-shaped hole, and a list opens that door only as far as a reader needs
it. The faces paint after the theme, so a theme cannot take back a font somebody
chose. The scale is not a token at all: the app sets its type in px, so a
font-size on the root moves nothing, and a CSS `zoom` would scale boxes without
scaling `window.innerWidth` — it goes to the webview's own zoom, where every
measurement scales together.

A look is more than a palette, so `src/lib/theme/presets.ts` is what bundles
one: a theme, the timeline settings and the two faces, applied together and each
still the reader's afterwards. Classic IRC is the one that needed it — black
surfaces are not the old clients, the time and then `<nick>` at the head of a
run and no spine are the rest of it. What a preset does not touch is as
deliberate: the window scale, because it is an accessibility setting somebody
chose for their eyes, and the name in front of every line, because it decides
how much of the window a conversation takes rather than what it looks like. A
preset writes what somebody could have written by hand and stops existing;
nothing is ever marked as being in a preset. This is the shape that keeps a
theme a set of token values, which is the contract
`overrides.ts` enforces and the reason widening `theme.json` was refused.

All of it lives in a dialog over the conversation, in
`src/components/settings`, and **the dialog has no scrim**. That is the whole
of the design: what ruled a sheet out was never the overlay but the scrim,
because every control on the Appearance page changes how a conversation reads
and dimming the window behind dims the only evidence any of them can be judged
against. `SettingsOverlay` is told apart from the client by its own border and
shadow instead, and what it does not cover stays lit. It is modal all the same —
`aria-modal`, the focus trap in `useDialogFocus` — because the pages behind
cannot be worked while their own settings are being changed.

Two shapes were built before it and both are instructive. A second window kept
the evidence and cost a second webview, a copy of every setting crossing
between them, and a page that could not see a conversation. A pane of the
layout kept it and charged the tree: a leaf that was not a conversation, a
floor of its own for the divider beside it, and a second answer to "which pane
is the reader in" for everything that asks. The dialog keeps the evidence and
owes neither, so `AppState.settings` is a `SectionId | null` and nothing that
walks the panes has to be told to pass over it.

Escape and a click outside both close it, and both decline while a page has a
request in flight — `SettingsBusy`, which `Done` is already disabled by:
closing loses the answer. Escape from inside a field is not a close at all, on
`isTextEntry`, because that is how a value being typed is abandoned and the
token editor behind Custom… is nothing but fields.

The sample channel stays. `previewChannel.ts`, drawn by `buildRows` and
`renderRow` — the timeline's own — is what the page shows in the middle of the
dialog while the reader's real channel reads around it, and the only evidence
there is on a first run. It is the real render path because the components
under it read the presentation out of the store, so a preview cannot show a
layout the client would not, and it is scripted for what `groups.ts` makes of
it: a run, an addressed pair, a declared topic and a message in no group, which
are the four states a spine has.

The sections are `sections.ts`, and Networks is no longer the gap among them.
It was one for as long as settings was a window of its own: configuring a
network is the onboarding flow, its last step watches the connection it
started, and that window ran no event bridge to watch it with. A dialog inside
the client does, so `Connecting` reads the store the sidebar reads.

The flow moved whole rather than being written again — `NetworksPage` draws the
same `Onboarding` the first launch does, on a `start` that skips the chooser.
Which screen the page is on is `AppState.setup`, in the store rather than in the
component, because the entry points are not the component: the sidebar's `+`, a
network row's menu, the channel header's `⋮` and the palette each mean
"configure this one", and `openSetup` opens settings on Networks and names the
network in one write. Nothing else edits a network, which is what the
standalone dialog had become.

That form is the one screen in settings that claims Escape. The dialog declines
Escape from inside a field, so that a value being typed is what the key
abandons, and this form opens with a field focused — which left the key doing
nothing at all on a screen that used to close with it. It goes back to the
list, and focus goes back to the dialog with it: a field that unmounts leaves
focus on `body`, outside the React tree the dialog's own handler listens in.

A page that lays out against the window rather than against what holds it will
clip; the Appearance rail was found doing exactly that, and asks its container
rather than the viewport for the room to sit beside the preview. The dialog is
sized so that it has it on the window this app opens at.

`readability/READABILITY.md` records a third grouping grade, guessed from timing
and participants. **It shipped and was taken out again**, and the reason is the
useful part: grouping separates conversations happening at once, so a channel
where everybody is in the same conversation has nothing to separate. A live run
returned twenty messages between three people as one group spanning the lot. No
threshold fixes it — a shorter gap only chops one conversation into arbitrary
pieces. A guess worth drawing fires only where it separates two disjoint sets of
people in one window, which is clustering rather than a timer.

Muting silences a conversation and ignoring silences a person, and a channel is
not the person in it who will not stop. An ignore takes effect at the door:
`append` in `crates/ircx-core/src/message.rs` drops the line before it becomes a
`ChatMessage` event, so there is no row, no unread, no notification and no
archive record. **The hole in the archive is not arranged — it falls out.**
Writing is driven off `MessagesAppended` in the event pump, so a line nothing
emits is a line nothing writes down, and the bargain that comes with it is the one irssi and weechat
make: un-ignoring restores nothing, and what was said meanwhile is gone rather
than hidden. Keeping it would mean persisting without emitting, which splits an
invariant that currently holds.

One predicate answers for speech and for the noise of coming and going alike,
because `chat_message` puts the actor in `sender` for a join as much as for a
sentence. `handle_privmsg` returns before it as well, so an ignored line opens
no query, marks nobody online and draws no CTCP reply out of us — an ignore that
replies is not one. What it leaves is as much of the design: kicks, modes and
topics still draw, because those change the channel rather than say something
and somebody kicked by a person they ignore still needs to see why; and the
roster keeps them, because hiding somebody from the member list would be a lie
about who can read what the reader types. A person is named by nick, folded by
the network's casemapping, and the set follows them through a rename for the
reason `move_muted` follows a renamed query — an ignore a rename escapes is an
ignore that stops working. Not a hostmask pattern: a pattern language is a thing
to explain and get wrong, and the question being asked is "I do not want to hear
from this person".

`/ignore` and `/unignore` move the session's own set first and tell the store
afterwards, so the very next line is already gone; a bare `/ignore` lists who is
ignored, in the server tab, while the confirmation lands in the conversation it
was typed in — otherwise the whole of what an ignore looks like is somebody
going quiet. The member menu and the user inspector offer the same, and the
inspector says so when there is one, because a reader who is not told is looking
at somebody whose messages are missing for no reason the window gives. The
settings window lists them beside the mutes, which is where the difference
between the two is worth stating and where an ignore made on a network nobody is
connected to can still be undone.

Every pane on a channel draws its own member list inside it. A split carries a
ratio and its divider moves by pointer or arrow key. The layout tree survives a
restart, written down as the conversations its panes hold; one whose
conversation is gone takes its pane with it.

`docs/measurements.md` holds every figure this project claims, with the method
behind it. The spec justifies the stack on startup, memory and size, so those
claims live in one place and say what they exclude. Do not cite a number from a
PR description; if it is load-bearing, put it there.

`docs/manual-verification.md` lists only what no test can establish. Keep
historical results in Git, add a test when a check becomes repeatable, and do
not let an unverified path pass for a verified one.

## Layer boundaries

Dependencies point one direction. A layer may use the one below it, never above.

```
src/                 React UI
src-tauri/           Tauri commands, event pump, app wiring
crates/ircx-core     caps, SASL, session state, command dispatch
crates/ircx-plugin   plugin manifest, permission grants, QuickJS sandbox
crates/ircx-store    SQLite archive, FTS5, drafts, config, keyring
crates/ircx-net      TLS transport, line framing, reconnect, the preview fetch
crates/ircx-proto    line parsing and serialisation
crates/ircx-ipc      types crossing the Tauri boundary
```

`ircx-proto` has no I/O and no async. `ircx-net` knows where a line ends and
nothing about what it means. Neither depends on `ircx-ipc`. `ircx-plugin` knows
nothing about IRC: it takes a command and gives back what the plugin asked the
host to do, and `ircx-core` is what turns that into messages. `docs/plugins.md`
is the permission model. Message renderers, link and attachment providers, and
protocol adapters are outside this milestone; the same document records the
constraints future implementations must keep.

## The IPC contract

`crates/ircx-ipc` is the single source of truth. Rust types there generate
`src/types/generated/*.ts` via ts-rs during `cargo test -p ircx-ipc`
(`npm run bindings`).

Changing a type in `ircx-ipc` means regenerating and committing the TypeScript
in the same commit. CI fails otherwise. Never hand-edit `src/types/generated`.

Frontend code imports types from `@/types` and calls the backend through
`@/lib/ipc`, never `invoke` directly.

## Conventions

- Colours come from the theme in force. `src/styles/tokens.css` states the
  contract, `src/styles/themes/<id>/` holds the values, and `src/lib/theme`
  loads them. A hardcoded colour, shadow, scrim or opacity in a component is a
  bug: a theme is a set of token values and cannot patch anything else.
- Every Tauri command returns `Result<T, String>` where the error is written for
  a user, not a log. "Nickname already in use on irc.libera.chat" — not
  "ERR_NICKNAMEINUSE (433)".
- Unsupported IRCv3 capabilities degrade to plain IRC. A missing capability
  changes what the UI offers; it never produces an error.
- `unwrap()` and `expect()` are for invariants that cannot fail, not for cases
  you have not handled yet. A panic in a connection task kills the session.

## Scope for the current milestone

Not in scope, but keep the extension points clean: custom encryption, voice,
file hosting, threads, cloud sync. `EncryptionState` stays `Plaintext`; no
encryption UI ships even though the mockup shows it.

Attachments are render-only. Previews load on explicit user action; the client
never fetches a remote URL on its own.

## Working agreement

One issue, one branch, one PR. Branch names: `feat/<area>-<slug>`,
`fix/<area>-<slug>`. Keep PRs reviewable — if a change touches more than its
issue describes, split it.

Before pushing:

```
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck && npm run lint && npm run test
```

Write tests for parsing, state transitions, and anything with an edge case a
server can trigger. Do not write tests that assert a mock was called.
