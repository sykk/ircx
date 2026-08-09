# ircx

Desktop IRCv3 client. Rust core, Tauri 2 shell, React 19 frontend.
Product spec: `ircclient.md`. Visual reference: `docs/mockup.png`.

`docs/mockup.png` is the visual authority and is deliberately minimal: flat
sidebar, icon-only header actions, members-only context panel, no chrome that
does not earn its space. When adding UI, the question is whether the mockup
would have drawn it.

How the conversation *reads* — grouping, gutter timestamps, nick colour,
presence digests, the unread seam, typography — follows
`readability/READABILITY.md`, which supersedes the mockup on those points. Its
studies assume an encryption layer this milestone does not build; take the
structural findings and leave the verdict machinery. Three deliberate departures
from it: typography stays semantic (prose in the text face, data in mono); the
nick palette stays inside 186-335deg, asserted by `src/styles/tokens.test.ts`;
and a message in no group keeps a neutral spine where the study draws nothing.

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

All of it lives in a second window rather than a sheet over the client, in
`src/components/settings`. A sheet is a scrim over the only evidence these
settings can be judged against, and the page is built round that: a sample
channel drawn by `buildRows` and `renderRow` — the timeline's own — over the
theme cards and the rail. It is the real render path because the components
under it read the presentation out of the store, so a preview cannot show a
layout the client would not. `previewChannel.ts` is scripted for what
`groups.ts` makes of it: a run, an addressed pair, a declared topic and a
message in no group, which are the four states a spine has.

Both windows are one `index.html` under one bundle, told apart by the query the
settings window opens at — `SETTINGS_URL` in `src-tauri/src/commands.rs`. The
query and not the window's label, though the label identifies the window to
Rust: a label is only readable inside a Tauri webview, and keying on the URL
leaves the page reachable at `/?settings` in the browser harness, which is
where this project walks its layouts. Two webviews on one origin share
localStorage, so what crosses between them is a bare "something changed" and
the receiver reads the settings back for itself — `adoptAppearance` in
`session.ts`. Nothing travels in the payload, because a copy of a value that is
already written down is a second answer to a question with one. A preset says
it once rather than three times; told after each of the settings it bundles,
the other window would paint the new theme against the old faces on the way
past.

`readability/ircx-live-studies.html` names a third grade, guessed, from timing
and participants. **It shipped and was taken out again**, and the reason is the
useful part: grouping separates conversations happening at once, so a channel
where everybody is in the same conversation has nothing to separate. A live run
returned twenty messages between three people as one group spanning the lot. No
threshold fixes it — a shorter gap only chops one conversation into arbitrary
pieces. A guess worth drawing fires only where it separates two disjoint sets of
people in one window, which is clustering rather than a timer.

`docs/multiwindow.md` describes split panes and per-pane context. The layout
tree is built, and every pane on a channel draws its own member list inside it —
the three context-panel modes that doc originally specified are gone, and the
doc says why. A split carries a ratio and its divider moves, by pointer or by
arrow key. The tree survives a restart, written down as the conversations its
panes hold; one whose conversation is gone takes its pane with it.

`docs/measurements.md` holds every figure this project claims, with the method
behind it. The spec justifies the stack on startup, memory and size, so those
claims live in one place and say what they exclude. Do not cite a number from a
PR description; if it is load-bearing, put it there.

`docs/manual-verification.md` lists what no test covers — SASL against a real
account, and the gaps the live Libera runs left open. Add to it rather than
letting an unverified path pass for a verified one.

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
is the permission model. `docs/renderers.md` and `docs/adapters.md` are the
design notes for the two extension points that are still only described; both
say what they would be and neither recommends building it yet.

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
