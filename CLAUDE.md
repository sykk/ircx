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
structural findings and leave the verdict machinery. Two deliberate departures
from it: typography stays semantic (prose in the text face, data in mono) and
the nick palette stays inside 186-335deg, asserted by `src/styles/tokens.test.ts`.

`docs/multiwindow.md` describes split panes and per-pane context. Not built
yet; it will move `active` and the context panel out of global store state.

## Layer boundaries

Dependencies point one direction. A layer may use the one below it, never above.

```
src/                 React UI
src-tauri/           Tauri commands, event pump, app wiring
crates/ircx-core     caps, SASL, session state, command dispatch
crates/ircx-store    SQLite archive, FTS5, drafts, config, keyring
crates/ircx-net      TLS transport, line framing, reconnect
crates/ircx-proto    line parsing and serialisation
crates/ircx-ipc      types crossing the Tauri boundary
```

`ircx-proto` has no I/O and no async. `ircx-net` knows where a line ends and
nothing about what it means. Neither depends on `ircx-ipc`.

## The IPC contract

`crates/ircx-ipc` is the single source of truth. Rust types there generate
`src/types/generated/*.ts` via ts-rs during `cargo test -p ircx-ipc`
(`npm run bindings`).

Changing a type in `ircx-ipc` means regenerating and committing the TypeScript
in the same commit. CI fails otherwise. Never hand-edit `src/types/generated`.

Frontend code imports types from `@/types` and calls the backend through
`@/lib/ipc`, never `invoke` directly.

## Conventions

- Colours come from `src/styles/tokens.css`. A hardcoded hex in a component is
  a bug: themes are stylesheets that redefine those properties.
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
