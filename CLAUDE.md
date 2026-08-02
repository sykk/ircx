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
