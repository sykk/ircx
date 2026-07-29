# ircx

A lightweight IRCv3 desktop client. Terminal-inspired, keyboard-driven, and
built to stay fast: Rust core, Tauri 2 shell, React frontend.

Keeps what IRC does well — networks, channels, nicks, `/commands`, raw protocol
access — and drops the parts that make it hostile to newcomers. TLS, SASL, and
capability negotiation are configured for you and stay visible when you want them.

## Status

Pre-alpha. The MVP targets Libera.Chat: TLS connection, capability negotiation,
SASL, channels and queries, member list, message timeline, slash commands, and
local SQLite history.

## Build

Requires Rust 1.85+, Node 24+, and the Tauri system dependencies for your
platform ([Tauri prerequisites](https://tauri.app/start/prerequisites/)).

```sh
npm install
npm run tauri dev
```

Release build:

```sh
npm run tauri build
```

## Layout

```
crates/ircx-proto    IRC line parsing
crates/ircx-net      TLS transport and reconnect
crates/ircx-core     capabilities, SASL, session state
crates/ircx-store    SQLite archive and credentials
crates/ircx-ipc      types shared with the frontend
src-tauri/           Tauri commands and app wiring
src/                 React UI
```

Architecture notes and contribution rules: [CLAUDE.md](CLAUDE.md).
Product spec: [ircclient.md](ircclient.md).

## License

MIT
