# Contributing to ircx

ircx is a pre-alpha desktop IRC client with a Rust core, Tauri shell, and React
frontend. Keep changes focused so they can be reviewed and tested independently.

## Set up the project

You need Rust 1.94.0, Node.js 24 or newer, and the Tauri system
dependencies for your platform. Follow the platform-specific [build
instructions](README.md#build), then install the locked frontend dependencies:

```sh
npm ci
```

On Linux and macOS, start the app with `npm run tauri dev`. On Windows, use
`npm run tauri:dev` so the script can configure the Visual Studio build tools.

## Keep generated bindings current

Rust types in `crates/ircx-ipc` define the contract between the backend and the
frontend. After changing one of those types, regenerate the TypeScript files:

```sh
npm run bindings
```

Commit the resulting changes under `src/types/generated` with the Rust change.
Do not edit generated files by hand. CI fails if the committed bindings do not
match the Rust types.

## Run the checks

Before pushing, run the same checks required by the repository:

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run typecheck
npm run lint
npm run test
```

Add tests for parsing, state transitions, and edge cases a server can trigger.
Test behavior rather than whether a mock was called. Record checks that cannot
be automated in [the manual verification list](docs/manual-verification.md).

## Open a pull request

Use one branch and one pull request per issue. Name branches
`feat/<area>-<slug>` for features or `fix/<area>-<slug>` for fixes. Split
unrelated work into separate pull requests.

In the pull request, explain what changed and why, list the automated and manual
checks you ran, and call out anything that remains unverified. Keep generated
files in the same commit as the source change that produced them.
