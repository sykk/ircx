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

## Not measured

- macOS and Windows. Everything here is Linux x86-64.
- Startup with a populated archive and several networks auto-connecting.
- Memory on a release build, or over a long session.
- Anything under netsplit-scale traffic.
