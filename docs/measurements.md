# Measurements

Numbers this project has actually measured, with what each one covers. They
exist because `ircclient.md` requires evidence for claims about startup, memory,
and installed size.

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

Earlier assembled-application checks used a debug binary against the Vite dev
server. They are not startup measurements.

### With something in the profile

**Measured 2026-08-05**, `scripts/run-ircx/startup.mjs`. The table above
is an empty profile, which was listed here as the thing it excluded: a person's
profile has an archive in it and networks that dial on launch.

Same anchors, same method — release build, real compositor, `WAYLAND_DEBUG`,
exec on the launcher's clock — three runs a condition. Medians, except the last
column, for the reason under it.

| profile | first message | surface, no content | first frame | ircx on screen |
|---|---|---|---|---|
| empty | 45.2 ms | 79.5 ms | 715.8 ms | 764–845 ms |
| a network, not dialling, empty archive | 46.7 ms | 80.3 ms | 718.6 ms | 762–851 ms |
| 100,000 messages, a network, not dialling | 45.5 ms | 81.0 ms | 722.1 ms | 763–859 ms |
| 100,000 messages, three networks dialling | 45.5 ms | 78.5 ms | 716.2 ms | 761–862 ms |

**Nothing in a profile moves any of it.** A 60 MB archive and three networks
dialling put the first frame at 716.2 ms against an empty profile's 715.8 ms,
and the spread inside one condition — 715.6 to 726.5 ms for the second row —
is wider than the gap between any two of them.

**The last column is two clusters rather than a number.** Across all twelve runs
it is either 761–777 ms or 843–862 ms, in every condition including the empty
one, so it is not the profile that decides which. **This is what the 722–819 ms
in the table above is**: those three runs were 819, 722 and 819, which is the
same split read as a range. Quote the pair, not a median between them, and do
not read a difference between two conditions off one run each.

**The networks are connected before the window exists.** All three finished
registering 241–275 ms after exec, against a first frame at 716 ms. Dialling
does not delay startup because it is over before there is anything to delay —
against this server. A real one is slower and mostly not ircx: the 5.84 s figure
above is largely Libera's identd timeout, and it lands on the same path, off the
one that draws.

**Why the archive cannot matter is structural, not a margin.** Nothing on the
path to a first frame reads a message. Conversations are restored from
`open_targets` inside `drive()` in `task.rs` — on the connection task, after
registration — and the timeline then asks for one page per conversation, not for
the archive. A profile a hundred times larger would be read a page at a time
just the same.

**Covers:** `exec` of `target/release/ircx` to each mark, XDG profile seeded on
disk, `npm run tauri build -- --no-bundle`, warm page cache, one machine, one
compositor. The dialling rows answer to
`scripts/run-ircx/quickserver.mjs`, which completes registration
immediately and deliberately: what a real server costs is the server's, and the
figure above is what ircx does with it.

**Excludes:** a cold page cache, a packaged bundle, TLS, SASL, and **when the
restored conversation is drawn** — the frame that puts messages on screen is
another buffer on the same surface and the compositor cannot tell it from any
later one. That it is drawn at all was checked by screenshot rather than timed.

### After splitting the frontend boot path

**Measured 2026-08-23**, before and after moving the emoji picker, settings
dialog and token editor behind dynamic imports. The baseline was commit
`2f9a5f8cd30cc795745ef3b3d27cc1887beb9bbc`; both builds used `npm run tauri
build -- --no-bundle`. Each build ran the four conditions above three times
with:

```bash
env GDK_BACKEND=wayland node scripts/run-ircx/startup.mjs \
  --messages 100000 --networks 3 --runs 3
```

The figures below combine all twelve runs for each build. The first three are
medians. The last remains two clusters; a median between them would describe no
run.

| from process exec to | one boot chunk | split boot path |
|---|---:|---:|
| first message to the compositor | 48.0 ms | 48.1 ms |
| surface committed, no content yet | 82.7 ms | 82.5 ms |
| first frame committed | 726.4 ms | 724.0 ms |
| webview content committed | 778.1–793.1 ms / 869.6–887.5 ms | 780.0–782.5 ms / 860.3–878.2 ms |

The median inside each content cluster moved from 782.6 and 878.8 ms to 781.3
and 865.1 ms. The cluster mix also changed from six runs in each to two low and
ten high. Both ranges overlap the baseline, and the builds were measured in
order rather than interleaved. These runs do not separate the 2.4 ms
first-frame difference or either content-cluster difference from run-order
noise.

| production output | one boot chunk | split boot path | change |
|---|---:|---:|---:|
| initial JavaScript | 994,017 bytes | 503,418 bytes | −490,599 bytes (−49.4%) |
| all JavaScript | 994,017 bytes | 997,380 bytes | +3,363 bytes (+0.34%) |
| release binary | 13,234,048 bytes | 13,242,496 bytes | +8,448 bytes (+0.06%) |

The initial chunk fell 49.4%. Tauri still embeds the lazy chunks, and the extra
chunk machinery and files made the release binary 8.25 KiB larger. This
measurement covers warm page cache on one compositor and the same four seeded
profiles as the table above. It excludes a packaged bundle and a cold page
cache.

## Size

| | measured | bytes | |
|---|---|---|---|
| `ircx` release binary, stripped | 2026-08-02 | 11,332,952 | 10.81 MiB |
| the same | 2026-08-01 | 11,320,792 | 10.80 MiB |
| the same, when the plugin runtime landed (#88) | 2026-07-30 | 10,570,584 | 10.08 MiB |
| **the application binary, frontend inside it** | 2026-08-02 | 11,897,816 | 11.35 MiB |
| the same, a week later | 2026-08-09 | 12,696,096 | 12.11 MiB |

The first three are the Rust side only — no frontend bundle embedded, no
installer packaging. **11,932 bytes over a day**, across the delivery-state
work (#332, #334, #335), the burst batching and the migration test.

The last two rows are what a user runs. `npm run tauri build` embeds the built
frontend in the binary; `cargo build --release` does not, and both land on
`target/release/ircx`. So the difference between the two rows measured on
2026-08-02 — **564,864 bytes, 551.6 KiB** — is `dist/` compressed into the
executable, and the figure this file quoted before that day is the one without
it. The 2026-08-09 row is the same build a week on; *Where the week to
2026-08-09 went* takes it apart.

**Covers:** `cargo build --release -p ircx` on the profile in the workspace
`Cargo.toml` — `lto = true`, `opt-level = "s"`, `strip = true`, `panic`
deliberately left unset. Linux x86-64, `stat -c%s` on
`target/release/ircx`.

The 2026-08-01 figure was taken twice: once in the shared `CARGO_TARGET_DIR`
this repo built in at the time — the practice this file argues against under
*What a worktree's build costs* — and once in a fresh empty one. **The two came out
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

### The desktop notification

`tauri-plugin-notification` added **180,832 bytes, 176.6 KiB**: 12,050,112 to
12,230,944. Measured as a back-to-back pair, the same way the preview fetch and
the plugin runtime below were — one worktree, one tree, the two builds minutes
apart, the only difference being the plugin in `src-tauri/Cargo.toml`, its
`init()` and its `notification:default` capability.

Seven crates: `tauri-plugin-notification` itself, `notify-rust` and the
platform backends it picks between — `mac-notification-sys`,
`tauri-winrt-notification` — and `rand` with `rand_chacha` and `rand_core`
under them. All three platforms' backends are in the tree; only one is compiled
into a given build.

**It is a third of what the keyring cost** for one field on one form (#446,
below), and it is the first dependency added since. The frontend half of the
feature is free by comparison: the decision is `worthNotifying` in
`src/lib/notifications.ts`, which is a hundred lines of TypeScript inside the
bundle already being embedded.

**Covers:** `cargo build --release -p ircx`, so the Rust side only — the rows
under *Size* that include the frontend are `npm run tauri build` and are not
comparable with this pair.

The first attempt at the baseline measured nothing, and the reason is worth
writing down: stripping the plugin from `Cargo.toml` while leaving
`notification:default` in `capabilities/default.json` fails the capability
check, and `cargo build … | tail` reports that as two lines of output rather
than as a failure. `stat` then read the binary the *previous* build left in
place and the pair came out identical. The figure above is from a run with the
binary deleted first.

### Where the week to 2026-08-09 went

**798,280 bytes, 779.6 KiB, over 88 merges.** Attributed by rebuilding at
waypoints rather than by dependency diff, so unlike the #88 row below this one
says where the growth *did* come from.

The baseline was rebuilt first, and came back at 11,897,816 bytes — the
2026-08-02 figure above, to the byte. Nothing about the toolchain or the
dependencies had drifted underneath the comparison, which is what makes the
rest of the table worth reading.

| | bytes | added | of the week |
|---|---|---|---|
| `cdc2729`, the 2026-08-02 baseline | 11,897,816 | — | |
| through 2026-08-05 | 12,034,848 | 137,032 | 17.2% |
| through 2026-08-07 | 12,039,584 | 4,736 | 0.6% |
| the glass theme, emoji picker, context menu, CTCP | 12,142,912 | 103,328 | 12.9% |
| **the upload secret, and the keyring with it (#446)** | **12,567,072** | **424,160** | **53.1%** |
| the four public hosts (#449, #450) | 12,590,240 | 23,168 | 2.9% |
| link previews (#451, #452) | 12,590,240 | 0 | — |
| the sidebar menus placed by measurement (#454) | 12,594,336 | 4,096 | 0.5% |
| the appearance settings (#453, #455, #456) | 12,636,192 | 41,856 | 5.2% |
| the settings window (#458, #460) | 12,696,096 | 59,904 | 7.5% |
| a reply quoting your own line (#457) | 12,696,096 | 0 | — |
| worktree target directories (#461) | 12,696,096 | 0 | — |

The rows sum to 798,280 exactly; nothing is unaccounted for.

**Half the week is one feature's dependencies.** Asking for the secret an
upload provider signs with (#446) put the system keyring behind it, and that
pulled in twenty-five crates — `secret-service` and `dbus-secret-service`, and
the crypto they need: `aes`, `cbc`, `cipher`, `hkdf`, `hmac`, `sha1`, `rand`,
`zerocopy`, the `num` family. 414 KiB for one field on one form. Its interval
also holds a test fix (#447) and a CI file (#448), neither of which is in the
binary, and #446 is the only merge in it that touched `Cargo.lock`.

The rest is what the code cost. The two largest features of the week by diff —
the appearance settings and the settings window — are **99.4 KiB between them,
12.7%**, which is roughly what a week of UI is worth when the dependencies
stand still.

**Covers:** the same method as the row above — `npm run tauri build --
--no-bundle`, `stat -c%s` on `target/release/ircx`, Linux x86-64, the workspace
release profile. Each waypoint built in one worktree, checked out in turn, so
the target directory is warm and the comparison is between binaries rather than
between build environments. Every build was confirmed to have reached *Built
application* before its size was read: a `tauri build` that fails leaves the
previous binary in place, and `stat` cannot tell.

**Excludes changes below about 4 KiB.** Three rows read 0 and are not zero —
a frontend-only change small enough for its compressed assets to land inside
the padding the executable already carries does not move the file size at all.
Read those as under the floor of this method rather than as free.

## What a worktree's build costs

| | measured | wall | on disk |
|---|---|---|---|
| `cargo test --workspace --no-run`, empty target directory | 2026-08-09 | 84.3 s | 7.1 GB |

Measured because a claim built on the opposite number was steering people into
a real defect. The `run-ircx` instructions said a fresh worktree
"rebuilds ~51G of Rust dependencies" and told the reader to point
`CARGO_TARGET_DIR` at another checkout's `target/` instead. Two checkouts
sharing one target directory is not safe: on 2026-08-09 `cargo test
--workspace` in `/home/syk/ircx` ran an `ircx-plugin` test binary another
worktree had built, which failed on a `CARGO_MANIFEST_DIR` baked at compile
time and naming a directory that no longer existed. Four tests failed for a
reason that had nothing to do with the tree being tested. The reverse — a stale
binary that *passes* — is the same mechanism and says nothing at all.

So the sharing is not worth buying, and at 84 seconds it was never worth much.
The default target directory is already per-checkout, so the fix is to stop
overriding it.

**Where the 51G came from:** an accumulated directory rather than a build.
`/home/syk/ircx/target` was 81 GB when this was measured — 77 GB debug, of
which 26 GB was `incremental/` grown over months of rebuilds, plus 4.2 GB
release. That is what a long-lived checkout costs, not what a new one pays.

**Covers:** compile only, `--no-run`, so it excludes running the tests and
excludes the frontend, which `cargo` does not build. Debug profile, 16 cores,
warm `~/.cargo/registry` — a cold registry would add the download. `du -sh` on
the target directory afterwards. Excludes `cargo test --workspace` a second
time, which is the case the shared directory was trying to make fast and which
is already seconds once a worktree has built once.

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
holds, and this page held nothing — which is measured below.

**Under two fifths of it is ours.** The Rust side is 66.6 MiB of the 176.3 —
38% — and the two WebKit processes are the rest.

### What a backlog costs

**Measured 2026-08-02**, same method, two samples from one process: the channel
empty, then the same channel holding 3,007 messages put there by three clients
and drawn in the timeline.

| PSS | empty | 3,007 messages | difference |
|---|---|---|---|
| **whole application** | **221.6 MiB** | **260.2 MiB** | **+38.5 MiB** |
| `ircx` — Rust, Tauri, GTK | 70.9 MiB | 73.4 MiB | +2.5 MiB |
| `WebKitWebProcess` | 131.1 MiB | 167.1 MiB | +36.0 MiB |
| `WebKitNetworkProcess` | 19.6 MiB | 19.7 MiB | +0.02 MiB |

**The page is where a backlog lands.** 36.0 of the 38.5 MiB is WebKit — 94% of
it — against 2.5 MiB for the Rust side holding the same messages in its window
and its archive. Per message: about 13.1 KiB in total, of which 0.87 KiB is
ours. The row above predicted this in words and now has a number.

The 2.5 MiB the Rust side takes is worth reading against the 7.2 MiB that
`ircx-core` alone took for 3,006 messages in a test process, measured
differently and quoted below: that harness held every message with no window to
draw them, and this one is the whole backend of a running client.

**The current 4,000-message cap is chosen from this run, not measured in a new
one.** The largest burst manually drawn in WebKit was roughly 3,800 messages,
so 4,000 keeps it with one 200-message archive page of room. Applying the two
measured rates — 11.2 KiB below and 13.1 KiB here — puts that window at roughly
44–51 MiB per conversation, against 109–128 MiB for 10,000. Those ranges are
arithmetic projections, not another `smaps_rollup` result.

**Covers:** `npm run tauri build` — see below, it is not the same as
`cargo build --release` — driven by
`scripts/run-ircx/window.mjs --release` on `Xvfb`, connected to a local
`ergo`, one channel, the flood paced by ergo's own fakelag at 6 messages a
second and sampled 45 seconds after the last one arrived.

**The absolute level is not comparable to the row above, and the difference is
not explained.** 221.6 MiB empty against that row's 176.3 MiB is 45 MiB more for
a client holding less. Two things differ and this run cannot say which
did it: the display server — `Xvfb` renders in software with no GPU, where the
row above was a real compositor — and a day of frontend, which grew by 551.6
KiB of compressed assets over the same interval. **The difference between the
two columns is what this measures**, both taken minutes apart in one process on
one display, and that is the figure to quote.

### What a long session costs

**Measured 2026-08-07**, `scripts/run-ircx/soak.mjs`. Every figure above
is sampled 45 seconds after `exec`. This one runs for ninety minutes, which is
what the *Not measured* list below used to ask for.

The release app at `9003463` on `Xvfb`, one channel taking 20 messages a second
from `quickserver.mjs`, `smaps_rollup` over the whole process tree every 30
seconds. **72,000 messages across the first 60 minutes, then the channel falls
silent with the connection still up** for the last 30. The store keeps
`TIMELINE_CAP` — 10,000 — a conversation, so from minute 8 onward every message
that arrives evicts one.

| PSS | whole | `ircx` | `WebKitWebProcess` |
|---|---|---|---|
| the cap full, minute 8 | 331.5 MiB | 74.0 | 237.9 |
| the peak, minute 59 | **412.5 MiB** | 74.2 | 318.3 |
| quiet, minutes 64–90 | **342.2 MiB** | 73.6 | 248.6 |

**It climbs past a full cap, and gives it back the moment the channel goes
quiet.** Between minute 9 and minute 59 the tree grew 77.4 MiB — +1.53 MiB a
minute, with the cap long full and nothing net being added to the timeline.
70.7 MiB of that came back inside a single 30-second sample when the traffic
stopped.

**Then it does nothing for 25 minutes.** 341.8 to 344.0 MiB across 52 samples,
a slope of ±0.000 MiB/min. That is the reading the run exists to get, and the
reason the channel is made to fall silent rather than talk for the whole ninety:
a line still climbing under load is a client that is not collecting while it is
busy, a line still climbing after the load stops is a client that is holding the
memory, and on a rising graph the two are the same picture. **This one is the
first, so there is no leak here**, and 342 MiB is the figure to quote for a
client left open.

**The Rust side does not move.** 72.2 to 74.2 MiB across all 180 samples and all
72,000 messages, and the file-backed mapping sat at 181 MiB throughout. Every
megabyte that moved was WebKit's, and anonymous memory tracked
`WebKitWebProcess` one for one: 99 MiB at the first sample, 246 at the peak, 179
quiet. No single mapping ever stepped by 25 MiB, so the harness never had a jump
worth dumping `smaps` either side of.

**It corroborates the backlog figure above at three times the size, loosely.**
The cap full is 331.5 MiB against the 221.6 MiB that section measures for an
empty window — 11.2 KiB a message over 10,000, where that section got 13.1 KiB
over 3,007. Same order from a different build on a different day, which is all
two runs a week apart can say to each other. Do not read the difference between
them as anything.

**Covers:** `smaps_rollup` for `ircx` and both WebKit processes, found by
walking `/proc` from the harness's own child rather than by name, on the release
profile — `npm run tauri build -- --no-bundle` — on `Xvfb`. The full series is
`docs/soak/90-minutes.csv`.

**Excludes:** several conversations each at the cap, which is a larger total
than one; a real GPU, since `Xvfb` renders in software, the same caveat the
section above carries; a week, or anything longer than ninety minutes; and the
residual. That last is worth naming: 342.2 MiB quiet against 331.5 MiB when the
cap first filled is +10.7 MiB after 62,000 further messages. Nothing accumulates
during the 25 minutes of quiet that were watched, but whether it accumulates
across successive busy periods needs a second plateau after more traffic, and
this run has one.

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
| On-disk size, 3,006 rows | 1.9 MiB |

### What opening one costs

**Re-measured 2026-08-07**, because #437 gave `Store::open` a second connection
to open. Release profile, `TMPDIR` on btrfs, medians of five, both columns taken
on the same machine in the same sitting.

| `Store::open` | before #437 | after |
|---|---|---|
| a fresh database, migrations and all | 7.19 ms | 7.69 ms |
| a 3,006-message archive | 0.34 ms | 0.52 ms |

The second connection is 0.5 ms of a first launch and 0.18 ms of every one
after. Against a first frame at 716 ms it is not something a person can be
waiting for, and the *Startup* table above did not move.

> The row that stood here said **2.7 ms** and **0.37 ms** and carried no date or
> method. The before column above is 2.7× the first of those on this machine
> today, so something moved under it long before this change — the second FTS5
> index (#378) is the obvious candidate and nothing measured it. Do not read the
> old figure as a regression this caused; read it as a number that outlived what
> it measured, which is what this file exists to prevent.

### What reading a page of history costs

**Measured 2026-08-14** by `crates/ircx-store/tests/history_page.rs`, which is
ignored by default and says how to run it. Release profile, a 100,000-message
archive of one conversation on `TMPDIR`, medians of nine, every column taken on
the same machine in the same sitting. The frontend pages back in 200s, so that
is the size every row here is about.

| `load_history` | before | #526 | #527 |
|---|---|---|---|
| the newest 200, some carrying reactions and notes | 2.25 ms | 0.86 ms | 0.85 ms |
| 200 at 1,000 messages back | 2.31 ms | 0.90 ms | 0.83 ms |
| 200 at 10,000 back | 3.01 ms | 1.61 ms | 0.82 ms |
| 200 at 50,000 back | 7.57 ms | 6.21 ms | 0.84 ms |
| 200 at 90,000 back | 11.88 ms | 10.55 ms | 0.83 ms |
| 10 at 50,000 back | 5.34 ms | 5.30 ms | 0.11 ms |

**Two costs, and each column is one of them.**

**#526 was per message.** A page is read and then filled in from the three
tables that hang off a message, and those three passes were a statement per
message — 600 executions for a 200-row page, whether or not anything hung off
it. Instrumented separately on the before build:

```text
read 0.50 ms   reactions 0.63 ms   annotations 0.58 ms   raised 0.56 ms
```

1.77 ms of the 2.25 ms, and what the fix takes off is flat: the same 1.4 ms at
every depth rather than a proportion of it.

**#527 was per message skipped.** The page-back filter was
`(?3 IS NULL OR m.timestamp < ?3)`, and a disjunction is not something SQLite
can put on the index, so a page-back started at the newest message and
discarded its way down — every page paying for the whole distance again. It is
the difference between the two plans, which the probe prints rather than argues:

```text
SEARCH m USING INDEX idx_messages_timeline (network=? AND target=?)
SEARCH m USING INDEX idx_messages_timeline (network=? AND target=? AND timestamp<?)
```

**A page now costs the same wherever it is read from**, 0.82–0.85 ms at every
depth measured, against 0.11 ms per thousand messages skipped before it. The
last row is where the old shape shows plainest: ten rows deep in a conversation
were 5.3 ms and are 0.11 ms, because almost none of that was ever the page.

Every figure above is an idle machine reading a file the kernel holds entirely,
which is the best case and neither of the two cases the argument behind #526
was about. The two arms below are the ones that stood here as *not measured*.

#### The same page on a loaded machine

**Measured 2026-08-14** by the same probe's second pass: 32 spinner threads on
16 cores. The profile is on tmpfs and its server is a local socket, so CPU is
all there is to contend for. Six sittings of the build that ships and four of a
control built from `2dd01c4`, which is the commit before #526 and reproduces
the *before* column above to three digits. Medians of nine, and the ranges are
across sittings.

| `load_history` | before, quiet | before, loaded | now, quiet | now, loaded |
|---|---|---|---|---|
| the newest 200, with rows | 2.20–2.25 ms | 3.70–6.97 ms | 0.84–0.87 ms | 1.77–4.71 ms |
| 200 at 1,000 back | 2.25–2.27 ms | 3.88–7.10 ms | 0.82–0.84 ms | 1.77–4.67 ms |
| 200 at 10,000 back | 2.96–3.00 ms | 5.45–11.33 ms | 0.81–0.83 ms | 1.78–4.68 ms |
| 200 at 50,000 back | 7.45–7.48 ms | 28.3–28.8 ms | 0.81–0.83 ms | 1.78–4.61 ms |
| 200 at 90,000 back | 11.5–11.9 ms | 22.3–66.1 ms | 0.82–0.83 ms | 1.78–7.48 ms |
| 10 at 50,000 back | 5.25–5.41 ms | 10.4–22.3 ms | 0.109–0.111 ms | 0.212–0.225 ms |

**The quiet table understates what the fix is worth.** A
page at 90,000 back is 14× faster than it was on an idle machine, and on a
loaded one it is 22.3–66.1 ms against 1.78–7.48 — the two columns do not
overlap at any depth, and the gap between their medians runs from 9× to 37×
depending which sitting is set against which. Contention multiplies work that
is per message and per message skipped along with everything else. 66 ms is
worth naming on its own: one page-back, inside the archive lock a connection
shares, on a machine doing what a machine does.

**What the loaded column is, is a floor and a tail.** Every loaded sitting of
the shipping build has a minimum of 1.73–1.87 ms whatever the depth — 2.2× the
quiet figure, flat, which is what paying for a core rather than finding one free
costs. The medians above that floor are excursions: four of the six sittings had
them, two did not, and the worst round seen was 10.3 ms. So do not read a single
loaded median as a result. The flat part is the reading; the spread is the load.

#### The same page off a cold archive

**Measured 2026-08-14** by `what_a_page_of_history_costs_off_a_cold_archive`,
which drops the page cache between rounds the way `cold_archive.rs` does for the
export, and opens the store again after the drop so that SQLite's own cache is
not what answers. The open is not timed — it faults the header and the schema,
which the client's launch pays for and a page does not. `TMPDIR` on btrfs, NVMe,
medians of nine rounds, four sittings of the shipping build and three of the
control. The eviction left 0 of 12,443 pages resident every time.

| a 200-row page | before | now |
|---|---|---|
| the newest, with rows | 5.01–5.31 ms, 254 pages (1,016 KiB) | 3.15–3.52 ms, 168–190 pages (672–760 KiB) |
| at 10,000 back | 24.1–27.0 ms, 513 pages (2,052 KiB) | 3.62–4.06 ms, 173–191 pages |
| at 50,000 back | 117–119 ms, 1,625 pages (6,500 KiB) | 3.44–3.81 ms, 170–194 pages |

**The messages a page-back skipped were disk, not only CPU.** Before #527, a
page at 50,000 back faulted 1,625 pages in — 6.5 MiB read off the disk to return
about 94 KiB of rows — because walking the distance means faulting every page
the distance is written on. It now faults 170–194 wherever it is read from, and
the reading is 117 ms against 3.4–3.8.

**A cold page costs 3.1–3.9× a warm one, flat with depth.** Before, that
multiple was 1.9× at the head and 12.8× at 50,000 back, which is the same shape
the timings have: what got colder with depth was the distance rather than the
page.

**The warm column of this arm is not the table above.** Read through a
connection opened for the round, over btrfs rather than tmpfs, a warm page is
1.05–1.10 ms against that table's 0.82–0.85 — an empty SQLite cache and a
recompiled statement, paid once per connection rather than once per page.
Compare within a column here, not across the two.

**Not measured:** an archive larger than the machine's memory, which for this
operation is a different question than a cold one — a page-back seeks rather
than scans, so what it faults is not what it would evict. A disk slower than an
NVMe. And a load that contends for the archive rather than for the CPU: nothing
else was reading or writing while the spinners ran, and *What an archive command
costs a search* below is what that distinction is worth.

### What the second search index costs

**Measured 2026-08-03.** #378 gave the archive a second FTS5 index over the
same column, tokenised into three-character runs, so a search can reach inside
a word — the only way to search a language that does not put spaces between
them. Both indexes are kept, because neither answers the other's queries.

Through `Store::append_messages` and `Store::search` on the release profile,
against a file-backed archive. The corpus is 3,006 lines of this repository's
own prose clipped to 90 characters, mean 62 — close to the length of an IRC
message, and real text rather than generated.

| rows | file | `messages_fts` | `messages_substr` | share of the file |
|---|---|---|---|---|
| 3,006 | 1.91 MiB | 152 KiB | 0.64 MiB | 33.5% |
| 100,000 | 52.27 MiB | 3.4 MiB | 17.56 MiB | 33.6% |

**A third of the archive is now the substring index**, at both sizes: 184–224
bytes per message against 35–52 for the whole-word one. That is what the
decision bought, and it is the reason the choice was the owner's.

Query time, best of five, 100,000 rows:

| query | index | |
|---|---|---|
| `deploy` | `messages_fts` | 0.39 ms |
| `落ちた` | `messages_substr` | 0.39 ms |
| `🔥` | neither — scan | 15.3 ms |
| `zq` | neither — scan | 12.6 ms |

**The upgrade is paid once, on the launch that applies the migration**, and it
is not free: building the index over an archive that already exists took 15 ms
for 3,006 rows and 786 ms for 100,000 — linear, about 7.9 ms per thousand
messages. It happens inside `Store::open`, so that launch is slower by that
much and no later one is. A first run has nothing to index and pays nothing.

**The two indexes cost the same to ask.** The scan is 30× either, and is
reached only by a query under three characters that the whole-word index
already answered nothing for — a lone emoji, a single CJK character. `zq` is
the floor case, where nothing matches and the whole table is read.

**Not measured:** an archive of real CJK text, which is who this was built for.
A synthetic upper bound stands in — 3,006 messages of characters drawn at
random from kana and 2,000 kanji, which repeats less than any real conversation
and so indexes worse. Both corpora run through the same SQLite, same options:
the substring index came to 624 KiB against the English corpus's 572 KiB, 9%
more. Nothing here suggests the English figure flatters the result.

## Grouping under crossfire

**Measured 2026-08-03**, `src/components/timeline/groups.crossfire.test.ts`: the
shipped `assignGroups` over generated transcripts, 40 interleavings per row.
Disjoint pairs talking only to each other, interleaved uniformly, every answer
addressed with `nick:`. Uniform interleaving is the arrangement most likely to
make two conversations cross, so each row is a worst case at that density.

Six-message exchanges:

| at once | drawn as one rule | no rule | rules per exchange | in someone else's | refused by reach | by crossing |
|---|---|---|---|---|---|---|
| 1 | 100% | 0% | 1.00 | 0% | 0% | 0% |
| 2 | 20% | 0% | 1.94 | 12% | 4% | 18% |
| 3 | 8% | 0% | 2.34 | 20% | 11% | 24% |
| 4 | 4% | 0% | 2.41 | 22% | 23% | 18% |
| 6 | 3% | 0% | 2.64 | 25% | 36% | 16% |
| 8 | 2% | 0% | 2.58 | 25% | 48% | 12% |

Two-message exchanges — one message and one answer, the shortest there is:

| at once | drawn as one rule | no rule | refused by reach | by crossing |
|---|---|---|---|---|
| 1 | 100% | 0% | 0% | 0% |
| 2 | 74% | 14% | 0% | 13% |
| 4 | 57% | 20% | 14% | 17% |
| 8 | 43% | 25% | 40% | 12% |

**One other conversation is enough.** Going from one to two takes six-message
exchanges from 100% drawn as one rule to 20%, at 1.94 rules each. The second row
is the whole story; the rest of the curve is detail.

**"In someone else's" is the cost nothing had named.** A group's span takes in
everything between the answered message and the answer, so unrelated messages
caught in it are drawn as part of an exchange they were not in — 12% of all
messages at two simultaneous conversations, 25% by six.

**The two refusals swap places**, so neither end of the curve can be read as a
verdict on one rule. Crossing dominates when the channel is barely crowded;
reach dominates once it is, because most answers are out of reach before
crossing is consulted.

**Excludes:** how many conversations a real channel actually runs at once, which
is what would place a real client on these rows. The attempted sample carried 3
messages in 3 minutes across eight Libera channels holding 8,400 people.

## Plugin isolation

Added cost per mechanism, measured exec-to-answer over 200 process launches on
the release profile. The prototype binaries differed only in the plugin backend;
permission enforcement, not startup cost, selected QuickJS.

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

Taken again for #325, running the same harness against the commit before it and
the commit after in one session. The earlier pass read higher in absolute terms
— 61.6 ms at 2,500 where the same code reads 38.2 here — so what the table
claims is the pair of columns, not either figure on its own.

| channel | events | messages | `applyEvents` before | after | `buildRows` | rows drawn |
|---|---|---|---|---|---|---|
| 100 | 400 | 200 | 0.7 ms | 0.6 ms | 0.2 ms | 2 |
| 500 | 2,000 | 1,000 | 5.0 ms | 1.9 ms | 0.9 ms | 2 |
| 1,000 | 4,000 | 2,000 | 13.4 ms | 2.6 ms | 1.4 ms | 2 |
| 2,500 | 10,000 | 5,000 | 38.2 ms | 9.3 ms | 2.9 ms | 2 |

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

| channel | roster events | messages before | messages after |
|---|---|---|---|
| 100 | 0.1 ms | 0.4 ms | 0.2 ms |
| 500 | 0.2 ms | 2.8 ms | 1.0 ms |
| 1,000 | 0.5 ms | 8.0 ms | 2.7 ms |
| 2,500 | 1.8 ms | 35.2 ms | 6.3 ms |

**The roster is linear now** (#321). It was `n²/2` element copies — each
`memberRemoved` filtering the whole list — and the batch holds the roster as a
map of nick to member instead, so five thousand roster events cost 1.8 ms
against the 75 ms they used to. What is left is one rebuild of the list.

**The messages are linear now too** (#325), and the fix is the same shape:
`mergeByTime` built a new list per `messagesAppended` event, so a thousand
messages arriving as a thousand events was a thousand merges over a growing
list, and the batch now extends one list and hands it over once. Five thousand
messages cost 6.3 ms, about 1.3 µs each, against 35.2 ms.

What made it a separate question from the roster is the unread seam, which is
decided against `activeViewId` at the moment each event lands — and a batch can
move that, because closing a channel takes the pane that was reading it. The
seam is still answered per event; only the merge is deferred. `index.test.ts`
asserts the batch agrees with `reduce` over a batch built to make them disagree,
including a channel closing under the pane showing it.

**Covers:** the store reducer and the row builder, in jsdom. **Excludes:**
everything the real client would also be doing — parsing the lines, writing them
to SQLite, and WebKit laying out and painting the result. The figures are the
floor, not the whole cost. How far below the whole cost is the next section.

## The same burst through the real stack

What the section above excludes, measured. `crates/ircx-core/tests/burst.rs`
puts `n` ordinary clients in a channel against a local `ergo` and closes all
their sockets at once, and times what reaches the events the frontend would be
handed: the socket read, the line framing, the parse, the session state and the
archive write. Release profile, loopback, median of three runs, **archive on a
real filesystem** — btrfs on NVMe, which is where a user's is.

| channel | wall, before #328 | after | on cpu, before | after |
|---|---|---|---|---|
| 100 | 26.7 ms | 8.3 ms | 30 ms | 10 ms |
| 500 | 124.9 ms | 28.5 ms | 130 ms | 50 ms |
| 1,000 | 284.7 ms | 72.2 ms | 280 ms | 120 ms |
| 2,500 | 791.3 ms | 241.8 ms | 790 ms | 380 ms |

**The frontend was never where a netsplit costs.** The store reducer and the row
builder together are about 12 ms of the 2,500 row (9.3 and 2.9); the Rust side
was 790 ms before this section was written and is 380 ms now. The two rounds of
work that made the frontend linear were worth doing and they were worth about
three percent of the burst. The section above says its figures are a floor; the
floor is a thirtieth of the building.

**Over half of it was the archive**, for the same reason #324 and #325 were
about: each quit arrives as its own event, so each was its own
`append_messages` and so its own SQLite transaction. Timed directly — 2,500
messages through `Store::append_messages`, one call each against one call with
all of them, fresh database, release profile — that is 444 ms against 80 ms.

#328 holds what arrives and writes it when the incoming lines stop, so a burst
commits once per 500 messages rather than once each. It took 550 ms off the
2,500 row, rather more than the 360 the comparison above predicted: a
transaction costs more than its commit. What is left is about 380 ms of cpu, of
which the batched write is 80 — so the parse, the session state and the event
sends are now the larger half, and nothing has measured them apart.

**Ordinary traffic is written down exactly as promptly as before.** The hold
ends when nothing else is waiting on the socket, which for a line arriving on a
quiet connection is immediately. Only a burst — where every line is followed by
another with no gap — coalesces, and a crash during one loses at most the 500
messages still held. Anything that reaches a row a message already left flushes
first: an echo confirming a delivery, a reaction, a plugin reading the
conversation, an annotator about to run.

**Where the database sits changes that answer**, which is why the row above says
which filesystem. The same comparison under `/tmp` reads 178 ms against 77 ms:
the batched write does not care where it is — 77 against 80 — and the
one-at-a-time write cares a great deal, because a commit on a tmpfs is a memcpy
and a commit on a disk is not. `tempfile::tempdir` lands on a tmpfs on most
Linux now, so a harness that takes the default measures the flattering case.

> The first pass at this section did exactly that, quoted 490 ms, called the
> archive a third of it, and argued against filing on the grounds that a tmpfs
> figure would be overstating a real machine's cost. It was understating it, by
> 3.6 times.

**On cpu exceeds wall clock** wherever the burst is not waiting on a commit —
the work is spread over a tokio runtime, so more than one thread is busy. The
two came out level on a real filesystem before #328, which is what a session
task blocked on `append_messages` looks like. Cpu is what the burst costs a
machine; the wall clock is what one client waits.

**Covers:** ircx's own process — everything from the socket to the events, in
the release profile, with the archive on a real filesystem. **Excludes:**
WebKit, and the frontend stages measured above. Also excludes anything a real
network does to the arrival rate: a loopback server delivers a burst as fast as
the client will take it, which is the worst case rather than the usual one. One
machine, one NVMe; a slower disk moves the archive's share up.

**Two things the harness cannot separate.** The wall clock includes whatever
`ergo` spends fanning the quits out, which is why the join wave the harness also
prints — 3.2 s at 2,500 — is not quoted here: with the crowd still connected the
server is doing `n²` work that no single client's netsplit would cost it. And at
the two larger sizes the archive holds about 200 more rows than the burst sent,
because the server replayed channel history to the client while it ran. That is
ircx's own backfill working, and it is part of what the real stack does.

## What an archive command costs the connection

**Measured 2026-08-05.** `crates/ircx-core/tests/archive_lock.rs`: a scripted
server bursts 900 messages, sends a `PING`, and times the `PONG` — once with the
archive quiet, once while `export_everything` runs over it, once while
`delete_everything` does. 60,000 messages archived, 27 MB on disk, release
profile, median of three runs, **archive on a real filesystem** — btrfs on NVMe,
which the harness does not do by itself; see the last note in this section.

`Store` is one SQLite connection behind a mutex, shared by every network and by
every command the archive sheet can run, and before #412 `Context::write` took
that mutex on the task that reads the socket. WAL is on and buys nothing
against a Rust mutex.

| | before #412 | after |
|---|---|---|
| `PONG`, archive quiet | 500.4 ms | 501.2 ms |
| `PONG` during an export | 500.5 ms | 500.8 ms |
| `PONG` during a delete | 1,050.9 ms | 501.1 ms |
| the export itself | 265.5 ms | 268.6 ms |
| the delete itself | 796.9 ms | 798.2 ms |

**The 500 ms both columns sit at is the flood guard, not the archive.**
`RateLimit::default()` is a bucket of five with a 500 ms interval, and
registration spends the five, so a `PONG` waits one interval however idle
everything else is. It does not move when the burst before it goes from 900
messages to 100, which is what says it is a timer rather than work. #410 was
filed claiming that floor was `ARCHIVE_BATCH` being written inline on the
connection task; moving every write off that task left it exactly where it
stands in both columns above.

> **#437 moved one number in this table and none of the conclusions.**
> Re-measured on 2026-08-07 with reads on their own connections, the three
> `PONG`s still read 501.2, 501.5 and 500.9 ms and the delete still takes about
> 800 ms. The export in this probe now takes 289–349 ms rather than 268.6 ms,
> and the reason is the fix working: the burst it was started alongside is
> archived *during* it now instead of after it, so the two share the disk. The
> export measured on its own is unchanged at 266.2 ms — see *What an archive
> command costs a search*.

**That floor is also this probe's blind spot.** The command starts as the burst
does, so a stall that ends inside the interval the `PONG` spends waiting anyway
is absorbed by it and reads as free. That is the export in the
before column: it takes 265 ms, and the answer was not going out inside 500 ms
regardless. The delete takes 797 ms, outlasts the interval, and costs the answer
550 ms. So the probe answers whether an archive command delays a `PONG` rather
than how long it blocks the connection task — a command shorter than the
interval delays nothing measurable here, and a longer one delays the answer by
less than it blocked.

**The operations did not get faster, and were not meant to.** The export is
268.6 ms after and the delete 798.2 ms. What changed is that every write now
goes to one writer thread per network over a channel, so the work happens beside
the connection task rather than on it.

**The issue's own numbers were debug-profile numbers.** #410 and #411 were
filed on the same harness built without optimisation, where the archive work
takes long enough that both commands outlast the interval:

| debug profile | before #412 | after |
|---|---|---|
| `PONG` during an export | 2,038 ms | 500.4 ms |
| `PONG` during a delete | 1,877 ms | 500.7 ms |
| the export itself | 1,894 ms | 1,901 ms |
| the delete itself | 1,375 ms | 1,351 ms |

The debug export is 7.1× the release one and the debug delete 1.7×. What they
cost the answer is 1,538 ms for the export against nothing measurable, and
1,376 ms for the delete against 550 ms — so the 1.5 s the issue quoted for an
export at this size is a delay no user on a release build could have had. The
fault was real; at 60,000 messages it is the delete that shows it.

**The stall grows faster than the archive does.** The same probe with `ARCHIVED`
raised to 240,000 — 109 MB, four times the size, two runs — puts the export at
1.09 s and the delete at 3.45 s before #412, both about 4.2× their 60,000
figures. What they cost the answer is 0.68 s and 3.58 s, against nothing
measurable and 0.55 s. The commands are linear in the archive and the delay is
not, because the flood guard absorbs a fixed 500 ms of it however large the rest
gets — and at 240,000 the export is no longer free either. After #412 both sit
at 501 ms at that size too. This is why the fix stands on an archive as modest
as 60,000 messages, which is a few months of a few channels.

**Where the database sits changes the delete and not the export.** Under `/tmp`,
a tmpfs, the debug delete is 1,194 ms against 1,375 ms on btrfs and the debug
export 1,898 ms against 1,894 ms: the delete writes and cares where it writes,
the export reads and does not. `tempfile::tempdir` takes the default, which on
this machine is the tmpfs, so every figure above sets `TMPDIR` to a directory on
the disk. Taking the default would understate what the lock cost — the `PONG`
during a debug delete is 1,657 ms there against 1,877 ms here.

**Covers:** one network's connection task against its own archive, with the
commands run from the same process. **Excludes:** any stall under 500 ms, for
the reason above, and a second network writing at the same time. The search the
same mutex serialises is the section below.

## What an archive command costs a search

**Measured 2026-08-07.** `a_search_typed_during_an_export` in
`crates/ircx-core/tests/archive_lock.rs`, added because the section above kept
listing this as untimed. Same archive as that probe — 60,000 messages, 27 MB,
release profile, `TMPDIR` on btrfs — and no connection in it at all: a thread
runs the archive command, and 50 ms later the main thread calls `Store::search`
and times it. Medians of three.

| | quiet | during an export | during a delete |
|---|---|---|---|
| `Store::search`, before #437 | 0.11 ms | 216.2 ms | 700.0 ms |
| `Store::search`, after | 0.12 ms | 0.31 ms | 0.36 ms |
| the archive command itself, before | | 265.5 ms | 749.3 ms |
| the archive command itself, after | | 266.2 ms | 754.8 ms |

**It used to wait out the whole rest of the command.** Issued 50 ms into a
265.5 ms export it took 216.2 ms, and 50 ms into a 749.3 ms delete it took
700.0 ms — the command's own duration less the 50 ms head start, to within a
millisecond across three runs each. `Store` was one `Connection` behind a
`Mutex` and `export_everything` holds the guard across every row, so a search
could not begin until the last one was written.

**Nothing absorbed it.** The section above measures the same lock against a
connection, where a 500 ms flood guard swallows any stall shorter than itself —
which is why the export reads as free there. A person typing a search has no
bucket in front of them, so the delay landed whole: 216 ms was 1,900 times what
the search costs on a quiet archive, and 700 ms was 6,300 times.

**#437 gave reads their own connections** and both figures fall to what a search
costs against a quiet archive. What the commands themselves cost is unchanged —
265.5 to 266.2 ms, 749.3 to 754.8 ms — which is the part worth checking: the
reader is beside them rather than taken from them.

**One search 50 ms in samples one moment**, and for a delete that is the wrong
moment. `delete_everything` is a `DELETE` and then a `VACUUM`, and only the
`VACUUM` takes SQLite's own exclusive lock, which no arrangement of connections
avoids. At 60,000 the `DELETE` is 645 ms and the `VACUUM` 80 ms, so a search
issued at 50 ms is nowhere near it. Asking without pause across the whole of
both commands instead — 2,241 searches during an export, 6,594 during a delete —
the slowest single answer is **0.95 ms** and **0.59 ms**. The `VACUUM` is in
there and it is not worth a figure. Those runs are not where the durations above
come from: an export hammered by 2,241 searches takes 330 ms rather than 266 ms.

**60,000 messages was the modest end of the fault.** The export is linear in the
archive and the delete worse than linear: at 240,000 they are 1.09 s and 3.45 s,
and a search typed then waited about that long. The 100,021-message assembled
app profile above exported in 563 ms.

**What the search itself costs, for scale:** 0.11 ms for a term matching one
row, 14.8 ms for a term every row has, where FTS matches all 60,000 and the
`ORDER BY` sorts them before the `LIMIT` takes 50.

**Covers:** `Store::search` against `export_everything` and `delete_everything`
in one process. **Excludes:** the IPC hop and the frontend either side of it,
which add whatever they add on top; two exports at once, which now have a
connection each; and a search against a write longer than `append_messages`,
which nothing in the client issues.

### What an export costs in memory

**Measured 2026-08-07**, in the assembled release app on `Xvfb`. The section
above times the export from inside the process; this one asks whether the
frontend renders the archive before writing it.

100,021 messages, 56 MB archive, three networks connected. Three runs of `Export
everything` from the sheet, destination and archive both on btrfs. The
destination's size and the app's `VmRSS` sampled every 57 ms.

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| bytes written | 54,127,733 | 54,128,252 | 54,128,252 |
| `File::create` to the last byte | 570 ms | 563 ms | 504 ms |
| RSS the export added | 824 kB | 88 kB | 72 kB |

**52 MB leaves through under a megabyte**, and the file grows about 6.9 MB a
sample in a straight line, at roughly 96 MB/s. `export_everything` walks a
`rusqlite` row iterator into a `BufWriter` and never holds more than a line, and
these are the numbers that say so from outside.

**The excursion is smaller than the app's idle drift.** RSS wandered between
160,788 kB and 171,000 kB across the 693 samples before the first export, with
nothing happening. Do not read the difference between the three runs above as
anything: 824 kB against 72 kB is well inside a 10 MB wander.

The per-conversation scope is the same shape — `export_target` over 33,335
messages wrote 18,039,768 bytes in 230–290 ms with no measurable rise at all.

**Covers:** the click, the save dialog, `export_archive`, `export_everything`
and the `BufWriter`, to the last byte on a real filesystem, on the release
profile. **Excludes:** the operator answering the dialog; a slower destination;
and a colder file than one the machine has just written, along with any archive
past 56 MB — both of which the section below measures.

### What an export costs against a cold archive

**Measured 2026-08-07.** `an_export_of_an_archive_nobody_has_read_yet` in
`crates/ircx-store/tests/cold_archive.rs`. Every export figure above was taken
seconds after the archive was seeded, so the file was entirely in the kernel's
page cache. This probe covers an archive the kernel is not already holding.

The same export runs twice a round: once against a cached file, then again with
`posix_fadvise(POSIX_FADV_DONTNEED)` over the database and its write-ahead log.
`mincore` counts resident pages either side of the drop, so a run where the
cache did not come off — a `TMPDIR` on tmpfs, which *is* the page cache — says
so rather than reporting two warm numbers as a result. The destination is a
counting sink instead of a file, which leaves the read as the only difference
between the two rows.

**"Does not fit in the page cache" is answered by taking the cache away rather
than by overflowing it**, and for this operation those are the same question.
The largest archive here is 447 MiB against 28 GB of memory, so none of them
could overflow anything. `export_everything` is one forward scan that reads
every page once and returns to none, so an archive genuinely larger than memory
has nothing to evict that it was going to want again — every page is cold when
it is reached, which is the state the eviction produces.

Release profile, `TMPDIR` on btrfs, NVMe. Each sitting is a median of three
rounds; the ranges below are across five sittings at 100,000 and two at each of
the other sizes.

| | 100,000 | 500,000 | 1,000,000 |
|---|---|---|---|
| archive on disk | 44.7 MiB | 222.5 MiB | 446.8 MiB |
| bytes exported | 48,877,780 | 245,277,780 | 490,777,780 |
| warm | 431–438 ms | 2.28–2.31 s | 4.56–4.65 s |
| cold | 668–723 ms | 3.10–3.16 s | 6.21–6.51 s |
| **cold ÷ warm** | **1.53–1.66×** | **1.36–1.37×** | **1.36–1.40×** |
| faulted back in | 34.2 MiB | 197.8 MiB | 397.1 MiB |
| at | 126–154 MB/s | 242–252 MB/s | 224–254 MB/s |

**A cold archive costs the export between 1.4× and 1.7×, and the multiple does
not worsen with size — it improves.** Across a tenfold range both rows stay
linear in the archive, 4.3–4.7 µs a message warm and 6.2–7.2 µs cold. So *"a
year of real channels"* is the same shape as a month of them rather than a
cliff: an export that takes half a second against a file the machine has just
written takes about three quarters of one against a file it has not touched
since boot.

**Warm is the stable row and cold is the one that moves.** 431–438 ms across
five sittings at 100,000 against 668–723 ms, which is where the whole spread in
that column's multiple comes from. Do not read 1.53 and 1.66 as two results.

**It is 1.5× rather than tenfold because the export reads sequentially.**
Nothing indexes `(timestamp, id)`, so the plan for `export_everything` is `SCAN
m` and a temp b-tree for the `ORDER BY` — a full table scan the kernel reads
ahead of, not a seek a row. The faults land at 126–254 MB/s, which is readahead
working rather than a disk's random figure, and the smallest archive is the one
that gets least out of it: 34 MiB is not long enough a run to reach the rate the
other two settle at, which is why its multiple is the highest of the three.

**The export reads less than the archive holds.** After a warm export the
resident pages are 8,751 of 13,885 at 100,000 and 101,647 of 126,622 at a
million, because the scan never touches either full-text index. What is left out
is 37% of the file at the first size and 20% at the last — smaller than the
third those indexes come to against real prose (*What the second search index
costs*, above), and smaller the larger this archive gets, because every seeded
line is the same sentence and repetition is what an index does not pay twice
for. The first round of each run is the exception and reads the file whole,
because the fill had just written all of it.

**What it does to the figure above.** The assembled app's 0.5–0.6 s for 100,021
messages is a warm number; multiply by about 1.6 for an archive nobody has read
since the machine booted. Do not read 431 ms against that walk's 563 ms — this is a bare
`Store` writing to a sink, and that is the assembled app with three connections
live putting 54 MB on btrfs. The ratio transfers; the absolute does not.

**Covers:** `export_everything` on the connection `walking()` opens, over a
database and write-ahead log the kernel is holding none of, at three sizes.
**Excludes:** the write side, which the sink takes out; a slower disk than an
NVMe; and a fragmented or aged file, since all three were written in one pass
minutes before they were read. The seeded line is one sentence with its index
appended, which comes to 468 bytes a message on disk against the 560 of the
100,021-message assembled profile — lighter per row, and lighter again in the full-text
indexes, though the scan does not read those.

## The narrowest a settings page can be

**Measured 2026-08-09**, `scripts/run-ircx/driver.mjs --seeded` in
headless Chrome at the app's own 1200x800: open settings beside `#ircx`, then
move the viewport a few pixels at a time and read `clientWidth` and
`scrollWidth` off the scrolling panel. Where `scrollWidth` is the larger, the
page is being asked to lay out in less room than it has, and the overflow is
sideways — the one direction nothing in this app is meant to scroll.

The five sections, at the width each one stops fitting in:

| section | content it will not go under |
|---|---|
| Notifications | 250px |
| Appearance | 242px |
| Plugins | 222px |
| Uploads | 200px |
| Privacy | 190px |

**470px in total, and Notifications sets it.** That is the section list plus
the panel: the list is a fixed 220px column, so the widest section's 250px puts
the floor at 470. Confirmed either side — at 470 the panel is 250px and does not
scroll, at 468 it is 248px and overflows by 2. It was `MIN_SETTINGS_PX`, the
floor for a divider beside the settings pane, while settings was a pane.

**The Appearance page's rail was measuring the wrong box.** Before this it
asked for its 290px rail beside the preview from a *viewport* of 1024px, which
in a window of 1200 is true while the pane holding it is 476 — the row of
accent swatches ran off the edge, and the floor was 576 rather than 470. It is
a container query now, so the page stacks against whatever holds it.

**The dialog is 1024x680**, or 92vw x 84vh where the window is smaller than
that. 470 is what it must clear and it clears it four times over; what actually
sets the width is the rail, which asks its container for 768px before it will
sit beside the preview rather than stack under it. The panel is the container
and the section list takes 220 of the dialog, so 1024 leaves it 804. Below a
window of about 1113px the dialog is 92vw, the panel falls under 768, and the
page stacks — which is the same page, taller.

**Excludes:** height. Nobody has measured the shortest either the dialog or a
pane can be — the gap `MIN_PANE_PX` has too. 680 and 84vh are chosen to leave
the conversation showing above and below, not measured against a page that
stops fitting.

## What the WHO a join sends costs

**Measured 2026-08-28**, `cargo test -p ircx-core --test libera -- --ignored
--nocapture` against `molybdenum.libera.chat`, joining `#libera` on a throwaway
unregistered nick and reading the replies off the wire.

| `#libera` on one join | |
|---|---|
| members | 1449 |
| `353` replies the `NAMES` took | 26 |
| `354` replies the `WHO` took | 1449 |
| already away, and drawn here before this | **476** |
| signed in to an account | 1300 |
| carrying a real name | 1448 |

**One reply per member is the whole cost, and it is charged once per join.**
`NAMES` packs fifty-odd nicks into a line and answers in 26; a `WHO` answers
about one person per line and cannot be packed, so a channel's roster costs
lines in proportion to itself. Both go through the same pacing as every other
line the client sends, and `#libera` is close to the worst case Libera has.

**A third of that channel was away**, and none of the 476 carried a reason: a
`WHO` says whether and never why, so what fills a reason is still an `AWAY`
arriving afterwards. What the number is here for is the other direction —
before #677 every one of those 476 was drawn present, and would have stayed
that way until they came back.

**Covers:** the replies to one `WHO` for one channel, on a server advertising
`WHOX`. **Excludes:** what a reconnect into many channels costs, which is this
per channel and has not been measured together; and the plain `WHO` a server
without `WHOX` answers, whose `352` carries the away flag and the real name and
no account.

## Not measured

- macOS and Windows. Everything here is Linux x86-64.
- **When a restored conversation is on screen.** Startup with a populated
  archive and dialling networks is measured above, up to the frame that puts
  ircx on screen. The later frame that puts the messages there is not
  distinguishable from the compositor's side, so what a person waits for to
  read a restored channel is still unmeasured.
- **A client left open for days.** Ninety minutes of it is measured above and
  the plateau there is flat for the last twenty-five, so what is unmeasured is
  a week rather than a long evening. Nor is a client with several conversations
  at the cap instead of one.
- A netsplit against a real server, end to end, **as a figure**. Both halves are
  measured separately — the frontend stages in jsdom, everything below them
  against a local `ergo` — and neither has WebKit in it. An untimed burst driven
  through a running window established that the fold and archive hold at that
  scale.
- A real netsplit. What the section above measures is a few thousand ordinary
  clients whose sockets close at once, which is the arrival rate without the
  server link, the `*.net *.split` reason or the `NETSPLIT` batch.
