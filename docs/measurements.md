# Measurements

Numbers this project has actually measured, with what each one covers. They
exist because `ircclient.md` justifies the whole stack on fast startup, low
memory and small installed size — claims worth holding to evidence.

**A number without its method is not evidence.** Every row says what it
includes and excludes. Where a figure has not been re-measured since the code
moved under it, that is stated rather than implied.

## Startup

| From process exec to | run 1 | run 2 | run 3 |
|---|---|---|---|
| first frame committed — window on screen | 665 ms | 679 ms | 679 ms |

**Covers:** `exec` of `target/release/ircx` to the frame the compositor was
handed, timed via `WAYLAND_DEBUG`. Release profile (`lto = true`,
`opt-level = "s"`, stripped), frontend built with `npm run build`, empty
profile, warm page cache, unpackaged binary.

**Excludes:** connecting to anything. Measured 2026-07-30 during the second
Libera run (PR #48).

A separate figure from the same run: **5.84 s** from process exec to
RPL_WELCOME with no UI. Most of that is Libera's identd timeout rather than
anything ircx does — worth confirming before anyone treats it as a startup
figure.

> The end-to-end runs in `docs/end-to-end-run.md` and `-run-2.md` used a **debug**
> binary against the Vite dev server. Nothing in those documents is a startup
> measurement, and they should not be cited as one.

## Size

| | |
|---|---|
| `ircx` release binary, stripped | 9.25 MiB |

Rust side only — no frontend bundle embedded, no installer packaging.

The preview fetch (`ircx-net::http`, issue #14) added **46.0 KiB**: 9,650,552 to
9,697,656 bytes. Measured as a back-to-back pair on one machine, building the
same tree with and without the change, because a shared `CARGO_TARGET_DIR`
makes the previous row's absolute figure a poor baseline — it and a clean
rebuild of the same commit differ by 18 KiB. The added dependency is `httparse`;
`http` and `base64` were already linked, and the TLS stack is the one the IRC
transport already carried.

## Memory

| | |
|---|---|
| RSS, connected, idle | 13.3 MiB |
| RSS, holding 3,006 messages | 20.5 MiB |

**Upper bound**: measured on a debug build inside the test harness, so the
release figure is lower. Not re-measured since.

## Archive

| | |
|---|---|
| `Store::open`, fresh database | 2.7 ms |
| `Store::open`, 3,006-message archive | 0.37 ms |
| On-disk size, 3,006 rows | 1.9 MiB |

## Plugin isolation

Added cost per mechanism, measured exec-to-answer over 200 runs on the release
profile. Full method and the reasoning in `docs/plugin-isolation.md`.

| backend | median | added |
|---|---|---|
| none | 0.87 ms | — |
| QuickJS | 1.53 ms | +0.66 ms |
| wasmtime | 3.34 ms | +2.47 ms |
| child process | 1.66 ms | +0.79 ms |

Worst case is 0.37% of the startup budget, which is why the startup constraint
did not decide that choice. Permission enforcement did.

## Not measured

- macOS and Windows. Everything here is Linux x86-64.
- Startup with a populated archive and several networks auto-connecting.
- Memory on a release build, or over a long session.
- Anything under netsplit-scale traffic.
