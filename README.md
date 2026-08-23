# ircx

A lightweight IRCv3 desktop client. Terminal-inspired, keyboard-driven, and
built to stay fast: Rust core, Tauri 2 shell, React frontend.

Keeps what IRC does well — networks, channels, nicks, `/commands`, raw protocol
access — and drops the parts that make it hostile to newcomers. TLS, SASL, and
capability negotiation are configured for you and stay visible when you want them.

## Status

Pre-alpha. The current build connects to IRCv3 networks, with Libera.Chat as
the primary compatibility target.

It includes:

- TLS, capability negotiation, reconnect, and SASL PLAIN, SCRAM-SHA-256,
  SCRAM-SHA-512, and EXTERNAL
- channels, queries, a raw server console, slash commands, a command palette,
  split panes, and per-pane member lists
- server history, replies, reactions, typing indicators, unread markers, and
  desktop notifications
- a local SQLite archive with full-text search, drafts, retention, export,
  deletion, mute, and ignore controls
- themes, S3-compatible uploads, and permissioned QuickJS plugins for commands,
  annotations, and notification rules

This milestone does not include:

- message encryption, voice, built-in file hosting, threads, or cloud sync
- plugin message renderers or protocol adapters
- automatic remote previews; ircx fetches a preview only when you ask

## Build

Requires Rust 1.94.0, Node 24, and the
[Tauri system dependencies](https://tauri.app/start/prerequisites/) for your
platform.

### Windows

1. Install [Visual Studio Build Tools 2022](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   with the **Desktop development with C++** workload (MSVC linker + Windows SDK).
2. Install the [WebView2 runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)
   if it is not already present (Windows 11 usually includes it).
3. From the project root:

```sh
npm ci
npm run tauri:dev
```

`npm run tauri:dev` bootstraps the MSVC environment automatically. If you prefer
to run `npm run tauri dev` yourself, open a **Developer Command Prompt for VS
2022** first so `link.exe` and `msvcrt.lib` are both on the path.

If you see `LNK1104: cannot open file 'msvcrt.lib'`, the shell picked up a
partial Visual Studio install (linker only, no SDK libs). Use `npm run
tauri:dev`, or repair VS by adding **Desktop development with C++** and the
**Windows 11 SDK** in Visual Studio Installer.

### Custom themes

Themes are folders of CSS. Copy `examples/themes/cyberpunk/` into
`%APPDATA%\chat.ircx.app\themes\` and pick it in Appearance.

- `theme.css` — colours and spacing (CSS variables on `:root`)
- `ui.css` *(optional)* — animations and effects via `[data-theme]` and
  `[data-ui="…"]` hooks

See [examples/themes/README.md](examples/themes/README.md) for the full list of
UI hooks and rules.

### Linux / macOS

```sh
npm ci
npm run tauri dev
```

Release build:

```sh
npm run tauri build
```

### Release

Keep the version in `Cargo.toml`, `package.json`, and
`src-tauri/tauri.conf.json` identical. After the version change is on `main`,
push its tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds Linux, Windows, Intel macOS, and Apple Silicon
installers and adds them to a draft GitHub release. Check the artifacts before
publishing the draft. macOS artifacts use ad-hoc signing until release signing
credentials are configured.

## Layout

```
crates/ircx-proto    IRC line parsing
crates/ircx-net      TLS transport and reconnect
crates/ircx-core     capabilities, SASL, session state
crates/ircx-plugin   plugin manifests and the QuickJS sandbox
crates/ircx-store    SQLite archive and credentials
crates/ircx-ipc      types shared with the frontend
src-tauri/           Tauri commands and app wiring
src/                 React UI
```

Architecture notes and contribution rules: [CLAUDE.md](CLAUDE.md).
Product spec: [ircclient.md](ircclient.md).

## License

MIT
