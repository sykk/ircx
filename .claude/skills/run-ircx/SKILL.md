---
name: run-ircx
description: Build, run, and drive ircx. Use when asked to start ircx, run its tests, build it, take a screenshot of its UI, click through the app, or check that a frontend change works in the running client.
---

ircx is a Tauri 2 desktop client: a React frontend in a WebKitGTK window, a Rust
core behind it. The window itself cannot be driven here — see Gotchas — so an
agent drives the **frontend in headless Chrome** via
`.claude/skills/run-ircx/driver.mjs`, which starts Vite, launches Chrome, and
takes commands on stdin. It needs no npm package and no display.

Almost everything a change touches is reachable that way: the shell, the command
palette, every sheet, themes, the timeline. What is not reachable is anything
that needs the Rust side to answer — see Gotchas before assuming a blank panel is
your bug.

## Prerequisites

`google-chrome` and Node 22+ (the driver uses the built-in `WebSocket`, so there
is nothing to install). Verified against:

```bash
google-chrome --version   # Google Chrome 151.0.7922.71
node --version            # v24.13.1
```

## Setup

Each git worktree needs its own `node_modules`:

```bash
npm ci
```

## Run (agent path)

Pipe commands in, read one `ok`/`err` line back per command:

```bash
mkdir -p /tmp/shots
printf 'goto /\nss /tmp/shots/shell.png\ntext body\nquit\n' \
  | node .claude/skills/run-ircx/driver.mjs
```

Opening a sheet from the command palette — this is the flow most UI work needs:

```bash
printf 'goto /
key ctrl+k
type Plugins
wait 400
key Return
wait 600
text [role=dialog]
ss /tmp/shots/plugins.png
key Escape
count [role=dialog]
quit
' | node .claude/skills/run-ircx/driver.mjs
```

That prints the sheet's text, writes the screenshot, and ends with `ok 0`
confirming Escape closed it.

| command | what it does |
|---|---|
| `goto <path>` | navigate, default `/` |
| `ss <file>` | screenshot to `<file>` (PNG) |
| `eval <expr>` | evaluate, print the JSON result |
| `text <sel>` | `textContent` of the first match |
| `count <sel>` | how many match — `0` is how you assert something closed |
| `click <sel>` | click the first match |
| `fill <sel> <value>` | set an input's value the way React notices |
| `filllabel <label> <value>` | the same, finding the field by its visible label |
| `type <text>` | insert text at the focus |
| `key <combo>` | `ctrl+k`, `Escape`, `Return`, `a` |
| `wait <ms>` | |
| `quit` | stop Chrome and Vite |

The driver picks a free port and prints it as `ok ready http://localhost:<port>/`.
It kills both children on `quit`, on EOF, and on a closed stdin.

## Run (human path)

```bash
npm run tauri dev   # → the real window, Rust backend and all. Ctrl-C to stop.
```

Use this for anything touching the Rust side. It needs a display, and it will
refuse to start if another dev server holds port 5183 (see Gotchas).

## Test

```bash
npm run typecheck && npm run lint && npx vitest run   # 47 files, 806 tests
CARGO_TARGET_DIR=/home/syk/ircx/target cargo test --workspace
```

The `CARGO_TARGET_DIR` is not optional in a fresh worktree — see Gotchas.

## Gotchas

- **The frontend throws without Tauri, and the failure looks like CSS.**
  `onFileDrop` in `src/lib/ipc.ts` calls `getCurrentWindow()` unguarded the
  moment `<DropToUpload>` mounts. Outside a Tauri webview that throws
  synchronously and React unmounts the whole tree, leaving a window that is the
  right dark colour and **completely empty** — it reads like a stylesheet
  problem, not a crash. `vite.browser.config.mjs` injects a
  `window.__TAURI_INTERNALS__` stub to get past it. `TitleBar.tsx` guards for
  this properly with `"__TAURI_INTERNALS__" in window`; that call site does not.
- **`npm run tauri dev` cannot run twice.** `vite.config.ts` pins port 5183 with
  `strictPort: true` so the Rust side's `devUrl` cannot drift, so a second one —
  or another agent's worktree — fails outright. The driver asks for port 0
  instead and is unaffected. If `npm run dev` dies with "Port 5183 is already in
  use", that is another session, not you: leave it alone and use the driver.
- **A fresh worktree rebuilds ~51G of Rust dependencies.** Point
  `CARGO_TARGET_DIR` at an existing checkout's `target/` and `cargo test`
  finishes in seconds. Cargo locks it, so a concurrent build blocks rather than
  corrupts.
- **Assigning `.value` to an input does nothing React can see.** React installs
  its own setter and listens for the event after it, so a plain assignment
  updates the DOM while React's state keeps the old value — the field looks
  edited and nothing else reacts. `fill` goes through the prototype's setter and
  then dispatches `input`. Use it rather than `eval`.
- **Form fields have no stable selector.** `src/components/onboarding/fields.tsx`
  labels its inputs with a React `useId`, so the id is generated per render and
  nothing in CSS reaches a field by the name a person sees. Everything built on
  those fields — onboarding, the plugin permissions form — needs `filllabel`,
  which goes through the `<label for>`. `fill` only works where a selector
  genuinely exists.
- **`key` cannot type punctuation.** It maps a character to a US-layout key code,
  so `(` and `)` are unreachable through it. Use `type`, which goes through
  `Input.insertText` and is layout-independent. This matters for anything
  pasting a CSS value like `rgb(...)` or `url(...)`.
- **Backend-dependent UI is empty, not broken.** Every `invoke` rejects, so the
  network list, plugins, uploads and themes installed on disk show their
  backend-absent state — the plugins sheet renders "no backend: the frontend is
  running in a browser" where the list would be. The two built-in themes still
  load, because they are compiled in rather than read from disk. Anything that
  must exercise the Rust side needs `npm run tauri dev`.
- **`.claude/**` is already excluded** from vitest (`vite.config.ts`) and passes
  eslint and tsc as-is, so the driver does not need an ignore entry.

## Troubleshooting

- **`ok ready` never prints, `timed out waiting for the Vite dev server`**: run
  `npm ci` — a fresh worktree has no `node_modules`.
- **`err no element matching <sel>`**: the sheet had not rendered yet. Add
  `wait 400` after the `key Return` that opens it.
- **Blank screenshot, no error**: the Tauri stub did not load. Check the driver
  was started with `--config .claude/skills/run-ircx/vite.browser.config.mjs`
  — it is, unless you launched Vite yourself.
- **`process exited with 1 before Chrome's debugger`**: another Chrome is using
  the profile directory. The driver makes a fresh one under `/tmp` per run, so
  this means a stale process; `pkill -f ircx-chrome-` and retry.
