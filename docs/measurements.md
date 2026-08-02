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
| first message to the compositor | 42.4 ms | 43.1 ms | 42.5 ms |
| surface committed, no content yet | 70.0 ms | 71.2 ms | 70.3 ms |
| first frame committed — window on screen | 665 ms | 679 ms | 679 ms |
| **webview content committed — ircx on screen** | **819 ms** | **722 ms** | **819 ms** |

**The last row is the one a person experiences.** A window at 679 ms is a
window; the client is not on it yet. Quote 722–819 ms for how long ircx takes to
start, and 665–679 ms only for how long it takes to put a frame up.

**Covers:** `exec` of `target/release/ircx` to each of those, anchored to the
launcher's clock and read off the compositor via `WAYLAND_DEBUG`. Release
profile (`lto = true`, `opt-level = "s"`, stripped), frontend built with
`npm run build`, empty profile so nothing dials out, warm page cache — the
binary had just been built and run. Includes the launcher's `fork`/`exec`, a
few milliseconds of it.

**Excludes:** connecting to anything, a cold page cache (dropping caches needs
root), a packaged bundle, and a profile with networks in it. Measured 2026-07-30
during the second Libera run (PR #48).

All four rows were measured in that run. Only the third was carried into this
file, and the fourth — the one worth quoting — stayed in the pull request
description, which is the thing this file exists to stop happening.

A separate figure from the same run: **5.84 s** from process exec to
RPL_WELCOME with no UI. Most of that is Libera's identd timeout rather than
anything ircx does — worth confirming before anyone treats it as a startup
figure.

> The end-to-end runs in `docs/end-to-end-run.md` and `-run-2.md` used a **debug**
> binary against the Vite dev server. Nothing in those documents is a startup
> measurement, and they should not be cited as one.

## Size

| | measured | bytes | |
|---|---|---|---|
| `ircx` release binary, stripped | 2026-08-01 | 11,320,792 | 10.80 MiB |
| the same, when the plugin runtime landed (#88) | 2026-07-30 | 10,570,584 | 10.08 MiB |

Rust side only — no frontend bundle embedded, no installer packaging.

**Covers:** `cargo build --release -p ircx` on the profile in the workspace
`Cargo.toml` — `lto = true`, `opt-level = "s"`, `strip = true`, `panic`
deliberately left unset. Linux x86-64, `stat -c%s` on
`target/release/ircx`.

The 2026-08-01 figure was taken twice: once in the shared `CARGO_TARGET_DIR`
this repo normally builds in, and once in a fresh empty one. **The two came out
byte-identical**, so the 18 KiB discrepancy the rows below warn about did not
reproduce, and the absolute figure is trustworthy here as a baseline for the
next change.

**The 732.6 KiB since #88 is ircx's own code.** `Cargo.lock` is unchanged over
that interval — not one crate added or removed — across 46 commits and 9,731
inserted lines of Rust: SCRAM, SigV4 and the S3 upload path, the archive and
its controls, history and backfill, the annotator and the notification rule.
The crypto SCRAM needed and the HTTP the uploader needed were both already
linked, for TLS and for the preview fetch respectively.

That attribution is by dependency diff rather than by the back-to-back pairs
the rows below use, because nobody measured each change as it landed. It says
where the growth did **not** come from with confidence, and divides the rest
across forty-six commits without separating them.

The preview fetch (`ircx-net::http`, issue #14) added **46.0 KiB**: 9,650,552 to
9,697,656 bytes. Measured as a back-to-back pair on one machine, building the
same tree with and without the change, because a shared `CARGO_TARGET_DIR`
makes the previous row's absolute figure a poor baseline — it and a clean
rebuild of the same commit differ by 18 KiB. The added dependency is `httparse`;
`http` and `base64` were already linked, and the TLS stack is the one the IRC
transport already carried.

The plugin runtime (issue #13) added **851 KiB**: 9,698,552 to 10,570,584
bytes, measured the same way, back to back. Almost all of it is QuickJS, which
the spike measured on its own at 793 KiB. The `network-requests` permission
adds nothing to that: plugins fetch through `ircx-net`, which the binary
already carried. None of it is touched at launch by a user with no plugins.

## Memory

**The application**, measured 2026-08-01 on the release binary, connected to a
local `ergo` with one channel joined and 45 messages archived — a client with
nothing in it:

| | PSS | RSS |
|---|---|---|
| **whole application** | **176.3 MiB** | 385.6 MiB |
| `ircx` — Rust, Tauri, GTK | 66.6 MiB | 155.2 MiB |
| `WebKitWebProcess` | 89.5 MiB | 172.3 MiB |
| `WebKitNetworkProcess` | 20.2 MiB | 58.1 MiB |

**PSS is the figure to quote.** A WebKitGTK application is three processes
sharing a great deal of mapped library, so adding their RSS counts those pages
three times: 385.6 MiB is not what the machine gives up to run this. PSS
divides each shared page among the processes mapping it, and 176.3 MiB is.

**Covers:** `smaps_rollup` for the whole process tree, 45 seconds after `exec`,
after the connection settled. Release profile, Linux x86-64, one sample on one
machine. **Excludes:** any real backlog. WebKit's share moves with what the page
holds, and this page held nothing.

**Under two fifths of it is ours.** The Rust side is 66.6 MiB of the 176.3 —
38% — and the two WebKit processes are the rest.

### The row this replaces measured something else

It read:

| | |
|---|---|
| RSS, connected, idle | 13.3 MiB |
| RSS, holding 3,006 messages | 20.5 MiB |

— labelled an upper bound *"measured on a debug build inside the test harness,
so the release figure is lower"*, and it is still true of what it measured:
`ircx-core` in a test process, with no window, no WebKit and no GTK.

What it does not say is that it excludes the whole application. Read as a
memory figure for ircx — which is what a row headed **Memory** in a file of
claims about ircx invites — it is out by more than a factor of ten in the
direction that flatters. The 3,006-message row is the same core-only
measurement and stays useful for what it is: what an archive of that size costs
in Rust, which is 7.2 MiB over an empty one.

Both are kept above, relabelled. Neither should be quoted as what running ircx
costs.

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

## Plugin runtime

What the plugin system costs once it is built rather than compared. Medians in
one process on the release profile, from
`cargo run --release -p ircx-plugin --bin bench`.

| what | runs | median |
|---|---|---|
| open the library, no plugins installed | 200 | 0.0038 ms |
| look a command up, nothing installed | 10,000 | 0.0014 ms |
| install one plugin | 50 | 0.063 ms |
| first call, cold plugin | 50 | 0.374 ms |
| call, warm plugin | 5,000 | 0.021 ms |
| build a QuickJS runtime and load one plugin | 200 | 0.214 ms |
| look for annotators, none installed | 10,000 | 0.0014 ms |
| look for annotators, one installed | 10,000 | 0.0018 ms |
| annotate a batch of 1, warm plugin | 5,000 | 0.026 ms |
| annotate a batch of 50, warm plugin | 500 | 0.207 ms |

Every row is from one run of the command above, on 2026-07-31. Taken together
rather than accumulated, because a table with rows from different days compares
nothing.

**The first row is the load-bearing one.** It is the whole of what a user with
no plugins pays at runtime: one listing of a directory that is usually not
there. No QuickJS runtime is built and no thread is spawned until a plugin's
command is actually typed, which is the third and fourth rows.

**The seventh is the annotator's version of it**, and it is paid more often: a
command is typed, while a batch of arrivals happens whenever anyone talks. At
0.0014 ms it is the same map lookup as the second row, and it is what a
conversation costs when nothing annotates it — which is every conversation for
a user with no plugins.

**The last two rows are why a batch is a batch.** Fifty messages handed over
one at a time would be fifty crossings at 0.026 ms, about 1.3 ms; handed over
together they cost 0.207 ms, which is 6 times cheaper. The marginal message is
0.0037 ms — the boundary dominates, and a netsplit rejoin or a history backfill
is exactly where that matters.

**Covers:** in-process work only. **Excludes:** process start, and anything a
real plugin does with its argument — the fifth row is boundary cost, not the
cost of a plugin. The annotator rows carry one regex against each message,
which is the shape `docs/plugins.md` gives as the example, so they are a
plausible plugin rather than an empty one.

What it adds to the binary is under [size](#size). A user with no plugins never
touches that text; the spike measured the demand-paging cost of unused text at
around 0.1 ms.

## A netsplit through the frontend

A split of `n` people out of a channel of `n`, then the same `n` returning a
minute later. Each one is a member event and a timeline message, so `n = 2,500`
is 10,000 events carrying 5,000 messages. Median of three runs, jsdom on Node
24, `performance.now()` around each half.

| channel | events | messages | `applyEvents` | `buildRows` | rows drawn |
|---|---|---|---|---|---|
| 100 | 400 | 200 | 1.5 ms | 0.4 ms | 2 |
| 500 | 2,000 | 1,000 | 3.8 ms | 1.0 ms | 2 |
| 1,000 | 4,000 | 2,000 | 17.2 ms | 1.4 ms | 2 |
| 2,500 | 10,000 | 5,000 | 61.6 ms | 3.0 ms | 2 |

**The row builder is not where the cost is.** `buildRows` is linear at about
0.6 µs a message, and the two rows are one digest and the day divider above it —
five thousand comings and goings fold into a single *2500 quit, 2500 joined*,
with every message still held inside the row it folded into. That is what the
digest was built for and it holds at this size. `rows.test.ts` asserts the fold
and the count so a regression shows up as a test rather than as an unscrollable
channel.

**Which half of `applyEvents` costs, measured separately**, because the first
version of this row attributed the whole of it to the roster and that was wrong.
The same batch split into its member events and its messages:

| channel | roster events | messages |
|---|---|---|
| 100 | 0.4 ms | 1.0 ms |
| 500 | 0.5 ms | 3.1 ms |
| 1,000 | 0.5 ms | 16.0 ms |
| 2,500 | 1.4 ms | 58.5 ms |

**The roster is linear now** (#321). It was `n²/2` element copies — each
`memberRemoved` filtering the whole list — and the batch holds the roster as a
map of nick to member instead, so five thousand roster events cost 1.4 ms
against the 75 ms they used to. What is left is one rebuild of the list.

**The messages are the remaining `n²`.** `mergeByTime` builds a new message list
per `messagesAppended` event, so a thousand messages arriving as a thousand
events is a thousand merges over a growing list. It is the same shape the roster
had and the same fix would work, but the unread seam is decided against
`activeViewId` at the moment each event lands, and another event in the same
batch can move it — so coalescing messages is a correctness question rather than
a mechanical one. Filed separately.

**Covers:** the store reducer and the row builder, in jsdom. **Excludes:**
everything the real client would also be doing — parsing the lines, writing them
to SQLite, and WebKit laying out and painting the result. The figures are the
floor, not the whole cost.

## Not measured

- macOS and Windows. Everything here is Linux x86-64.
- Startup with a populated archive and several networks auto-connecting.
- Memory over a long session, or with a real backlog rendered.
- A netsplit against a real server, end to end. The row above measures the two
  frontend stages in isolation; nothing has yet driven thousands of real QUITs
  through the socket, the archive and the compositor together.
