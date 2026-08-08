# Which isolation mechanism for plugins

Design spike for #13. Three candidates — QuickJS, WebAssembly via wasmtime, and
a child process — were built behind one trait in `crates/ircx-plugin` and put
through the same plugin and the same failure modes. This is the write-up: the
numbers, the recommendation, and what the recommendation costs.

Nothing here was wired into the app when it was written, and the code it
measured is gone: the two mechanisms this document rules out were deleted when
#13 was built on its recommendation. The numbers stand as taken. See
[what happened next](#what-happened-next), and `docs/plugins.md` for what
shipped.

## Recommendation

**QuickJS**, if and when the extension system is built. Three reasons, in the
order they mattered:

1. It is one of two candidates that can enforce all seven permissions the spec
   names. The child process can enforce two of them.
2. It costs 793 KiB of binary against wasmtime's 7.02 MiB, for the same
   enforcement and near-identical per-call cost.
3. The spec asks for user scripts *and* plugins as separate features. One
   QuickJS runtime serves both, because a user script is a JavaScript file.

**Startup did not decide anything, and the premise that it would is wrong by two
orders of magnitude.** The worry going in was a mechanism spending a third of a
665 ms cold-start budget. The most expensive of the three adds 2.5 ms to an
exec-to-answer measurement, and with no plugins installed all three add under
0.35 ms. Whichever way this goes, the user does not feel it.

The corollary is that this decision is cheap and reversible. All three sit
behind one trait; swapping mechanisms is a module, not a redesign. The
expensive part of #13 was never the mechanism — it is the grant UI, revocation,
the manifest and install flow, channel scoping, and the five extension points,
none of which is mechanism-specific.

## How everything here was measured

AMD Ryzen 7 5800H, 8 cores / 16 threads, 28 GiB, Fedora on Linux 7.1.5,
rustc 1.97.1, machine otherwise idle. Every timing is a median unless it says
otherwise.

Everything is a **release build under the workspace profile** — `lto = true`,
`opt-level = "s"`, `codegen-units = 1`, `strip = true` — which is the profile
users get. Debug numbers were not used anywhere; on this crate they differ by
more than the gaps being measured.

Two harnesses produce the numbers:

- `crates/ircx-plugin/src/bin/bench.rs`, run as
  `cargo run --release -p ircx-plugin --bin bench`. Everything that can be
  measured inside one process: sandbox construction, per-call cost, failure
  modes, permission checks.
- `crates/ircx-plugin/measure.sh`, which builds `probe` four times — no backend,
  then each backend alone — and times each whole process from `exec` to exit.
  The size of a mechanism is the difference between two binaries that are
  otherwise identical code.

Everything is **Linux x86-64 only**. See [what is not measured](#what-is-not-measured).

The 665 ms cold start this is all weighed against was not re-measured here and
could not be found in the document it was attributed to, which is why it is used
below only to establish an order of magnitude. The number itself is sound — PR
#48, and `docs/measurements.md` has it with its method — and the same run puts
webview content at 722–819 ms, so the order of magnitude is the one these
conclusions assumed.

## Startup

### Cost with a plugin installed: exec to answer

Whole process, `exec` to exit, 200 runs. The process loads one plugin and calls
it once.

**Includes** fork, exec, the dynamic linker, Rust runtime startup, building the
runtime, loading one plugin, one round trip, and process teardown — because a
launching app pays all of those. **Excludes** anything the app would do with the
answer, and any second plugin.

| build | min | median | added over baseline |
|---|---|---|---|
| probe, no backend | 0.70 ms | 0.87 ms | — |
| probe, QuickJS | 1.31 ms | 1.53 ms | +0.66 ms |
| probe, wasmtime | 3.04 ms | 3.34 ms | +2.47 ms |
| probe, child process | 1.44 ms | 1.66 ms | +0.79 ms |

Against a 665 ms cold start the worst case is 0.37%.

### Cost with no plugins installed

What a user who never installs a plugin pays for the mechanism being in the
binary. Phase medians over 51 runs; the probe prints nanoseconds since the top
of `main`, and the whole-process figure is wall clock around the same 51 runs.

| build | runtime ready | plugin loaded | first call | main returns | whole process |
|---|---|---|---|---|---|
| probe, no backend | — | — | — | 0.001 ms | 0.839 ms |
| probe, QuickJS | 0.252 ms | 0.455 ms | 0.465 ms | 0.517 ms | 1.464 ms |
| probe, wasmtime | 0.079 ms | 2.048 ms | 2.067 ms | 2.108 ms | 3.298 ms |
| probe, child process | 0.016 ms | 0.349 ms | 0.693 ms | 0.806 ms | 1.657 ms |

`runtime ready` is the per-process part: the QuickJS interpreter, the wasmtime
engine, or in the process case only computing a path. `plugin loaded` is that
plus reading one plugin. For wasmtime the jump from 0.079 to 2.048 ms is
Cranelift compiling the module, and it is the whole story of wasm's load cost.

Subtracting `main returns` from `whole process` estimates the part of the run
that is not plugin work — exec, the linker, Rust startup, teardown — which is
what a launch with zero plugins and a lazily built runtime would cost:

| build | outside main | added over baseline |
|---|---|---|
| probe, no backend | 0.838 ms | — |
| probe, QuickJS | 0.947 ms | +0.11 ms |
| probe, wasmtime | 1.190 ms | +0.35 ms |
| probe, child process | 0.851 ms | +0.01 ms |

This is an estimate, not a measurement: it subtracts one median from another
rather than taking the median of paired differences, and the two clocks differ.
Read it as an order of magnitude. The point survives the imprecision — 7 MiB of
extra text costs a third of a millisecond at exec, because the pages are
demand-paged and never touched.

So the runtime should be built lazily, on first plugin load. That is worth
0.25 ms for QuickJS, which is another way of saying it barely matters either.

### Startup inside one process

Median of 25 runs, one fresh sandbox per run, in an already-running process. No
exec, no linker. This isolates the mechanism from process startup.

| mechanism | runtime | load | first call |
|---|---|---|---|
| QuickJS | 0.11 ms | 0.12 ms | 0.12 ms |
| wasmtime, plugin ships wat | 5.2 µs | 1.49 ms | 1.51 ms |
| wasmtime, plugin ships wasm | 5.2 µs | 1.47 ms | 1.48 ms |
| wasmtime, precompiled at install | 5.2 µs | 0.09 ms | 0.10 ms |
| child process | none | 0.40 ms | 0.77 ms |

The three wasm rows are the same plugin in three shapes: 436 bytes of `wat`,
115 bytes of binary wasm, 17,984 bytes of wasmtime's own compiled form. Text
versus binary makes no difference, because parsing is not the cost. Compiling
is, and precompiling at install removes it — at the price of a compiled artifact
that is 156 times the size of the wasm it came from and is valid only for one
wasmtime version on one machine.

## Size

Stripped release binaries. The size of a mechanism is the difference between two
`probe` builds that differ only in which backend feature is on.

| build | bytes | added |
|---|---|---|
| probe, no backend | 302,416 | — |
| probe, QuickJS | 1,114,000 | +811,584 (+793 KiB) |
| probe, wasmtime | 7,667,784 | +7,365,368 (+7.02 MiB) |
| probe, child process | 428,192 | +125,776 (+123 KiB) |
| `plugin-child`, the process mechanism's plugin | 320,080 | ships separately |

For scale, the release `ircx` binary built from this branch is 9,631,576 bytes
(9.19 MiB). QuickJS would add 8.4% to it, the child process 1.3%, and wasmtime
76%.

Most of wasmtime's 7.02 MiB is Cranelift, its compiler, not its runtime. A
runtime-only link — enough to run modules compiled elsewhere, but not to compile
one — was measured separately in a scratch crate outside this branch: a binary
depending on `wasmtime` with `default-features = false, features = ["runtime",
"std"]`, calling `Engine::new`, `Module::deserialize`, `Linker::instantiate` and
`TypedFunc::call`, against the same binary with the dependency off, under the
same release profile.

| link | bytes | added |
|---|---|---|
| bare | 292,400 | — |
| wasmtime runtime, no Cranelift | 812,104 | +519,704 (+508 KiB) |

So wasm's runtime is smaller than QuickJS, and the 7 MiB is a compiler. Getting
rid of it is harder than it looks: a `.cwasm` is tied to the exact wasmtime
version, the CPU, and the engine config, so a plugin author cannot ship one. The
compiling has to happen on the user's machine, which means either the app
carries Cranelift anyway, or it fetches a version-matched compiler on first
plugin install and re-runs it on every app update. The second is a workable
design and it is a whole distribution mechanism to save 6.5 MiB.

## Memory

Peak resident set of the same probes, minimum over 15 runs. Minimum rather than
median because peak RSS only moves up with noise.

| build | peak RSS | added |
|---|---|---|
| probe, no backend | 1,780 KiB | — |
| probe, QuickJS | 2,988 KiB | +1,208 KiB |
| probe, wasmtime | 8,040 KiB | +6,260 KiB |
| probe, child process | 2,136 KiB | +356 KiB |
| `plugin-child` alone | 1,956 KiB | per plugin process |

wasmtime's 6.1 MiB is Cranelift's working set while compiling, not steady state;
a precompiled module would hold far less, and that was not measured.

The process row understates the mechanism. GNU `time`'s `%M` may or may not fold
in a reaped child's peak, so read +356 KiB as the parent's own cost, and add
roughly 1.9 MiB per live plugin — a whole process image each, scaling linearly.
Low memory use is one of the three product goals in the same sentence as fast
startup, and this is the row that argues against the process mechanism on it.

## Per call

One hook call on a warm sandbox: a 70-byte JSON argument in, a string out. The
guest does one string concatenation.

| mechanism | calls | median | p99 | mean |
|---|---|---|---|---|
| QuickJS | 50,000 | 3,352 ns | 3,842 ns | 3,339 ns |
| wasmtime | 50,000 | 3,353 ns | 4,820 ns | 3,459 ns |
| child process | 20,000 | ~20 µs | ~30 µs | ~20 µs |

**Includes** serialising the argument to JSON, looking the hook up by name in
the guest, the call, and converting the reply back. A production host would
hoist the name lookup out of the call path, so all three figures are ceilings on
boundary cost rather than measurements of it. **Excludes** anything the guest
does with the argument, which for a real plugin is most of the cost.

The QuickJS and wasmtime medians matching to a nanosecond is a coincidence of
this guest, not a finding. The scale is the finding. At 20 µs, the worst of the
three, a thousand hook calls a second costs 2% of one core, and ten thousand
costs 20%. A hook that runs once per received message would have to face a
channel busier than any this client has been pointed at to reach the first
figure. **Per-call cost does not decide anything either.**

## Failure modes, observed

Deadline 100 ms, memory limit 8 MiB. Every row was followed by loading a fresh
plugin in the same process and getting a correct answer, so every row is also
evidence the host survived. `after` is whether the same sandbox answered a later
call.

| mechanism | mode | took | outcome | after |
|---|---|---|---|---|
| QuickJS | panic | 0.01 ms | `Error: boom` with a stack | raises again |
| QuickJS | infinite loop | 100.0 ms | terminated on the deadline | refuses further calls |
| QuickJS | hang, unresolved promise | 6.7 µs | type error, not a hang — see below | raises again |
| QuickJS | memory exhaustion | 7.7 ms | out of memory, from QuickJS's allocator | refuses further calls |
| QuickJS | runtime loop, catastrophic regex | 100.1 ms | terminated on the deadline | refuses further calls |
| QuickJS | blocking wait, `Atomics.wait` | 0.01 ms | `cannot block in this thread` | raises again |
| wasmtime | panic | 0.03 ms | `wasm trap: unreachable` | raises again |
| wasmtime | infinite loop | 100.1 ms | terminated on the deadline | refuses further calls |
| wasmtime | memory exhaustion | 0.04 ms | grow refused at 7,232 KiB, guest carried on | **answers** |
| wasmtime | hang | — | not expressible | — |
| wasmtime | runtime loop | — | not expressible | — |
| child process | panic | 0.63 ms | exit status 101, seen as EOF on the pipe | refuses further calls |
| child process | infinite loop | 100.3 ms | killed on the deadline | refuses further calls |
| child process | hang | 100.5 ms | killed on the deadline | refuses further calls |
| child process | memory exhaustion | 71.0 ms | `SIGABRT` under `RLIMIT_DATA` | refuses further calls |
| child process | runtime loop | — | not applicable, no shared runtime | — |

Four results are worth more than the table row.

**The QuickJS runtime-loop worry was unfounded.** The interrupt handler runs
between bytecodes, so the open question was whether a loop inside QuickJS's own
C — the regex engine, via catastrophic backtracking — would be invisible to it.
It is not: `/^(a+)+$/` against 40 `a`s and a `b` was terminated at 100.1 ms like
any other loop. This build of quickjs-ng calls the handler from the regex engine.
`js::a_plugin_looping_inside_the_regex_engine_is_also_terminated` guards it,
because it is a property of the QuickJS build and a version bump could regress
it silently.

**Neither in-process mechanism can hang, but for different reasons, and both are
conditional.** A wasm guest can only block by calling a host import that blocks,
and the host defines exactly the imports the manifest grants — all of which
return promptly. QuickJS has one way to park in C where the deadline cannot see
it, `Atomics.wait` on a `SharedArrayBuffer`, and this build refuses it outright
with `cannot block in this thread`. Both immunities are properties of the host's
function surface rather than of the mechanism. **If a future host function ever
blocks — a synchronous network call for the `network requests` permission is the
obvious candidate — hang becomes expressible in both, and only the deadline
saves you.** That is a standing constraint on the plugin API, not a property
already banked.

**The QuickJS `hang` row is an artifact of the hook's shape, not a result.** The
plugin returns an unresolved promise, and the host, which declared the hook
returns a string synchronously, gets a type error in 6.7 µs. It never waited.
Make the hook `async` and this stops working: the interrupt handler only fires
while bytecode is running, and a promise nobody will ever settle leaves the job
queue empty with no JavaScript executing, so nothing trips the deadline. The
host would have to time out the pump itself. Read the row as "synchronous hooks
cannot hang", and keep them synchronous.

**wasm's memory exhaustion needs no termination at all.** `memory.grow` returns
-1 at the cap and the guest carries on with what it has, so the plugin is still
answering afterwards — the only cell in the table where a misbehaving plugin
stays alive and correct. QuickJS reports out of memory and poisons the runtime;
the child process is aborted by the kernel after 71 ms, the slowest failure
detection measured.

Every mechanism meets the hard requirement in #13: a broken plugin is terminated
and reported, and the host keeps running. That requirement does not
discriminate. Twenty tests in `crates/ircx-plugin/tests/failure_modes.rs` assert
it rather than describing it.

## Permissions: what each mechanism can actually enforce

This is what decided it.

A permission is only real if the mechanism can refuse the capability when the
manifest withholds it. The seven the spec names split into two kinds. Four are
*the host gives you something*: read messages, add commands, access selected
channels, render message content. The host enforces those by not handing the
thing over, whatever the mechanism. Three are *the plugin reaches the outside
world*: send messages, store local data, make external network requests. Those
need the mechanism to deny an alternate route.

| permission | QuickJS | wasmtime | child process |
|---|---|---|---|
| read messages | yes | yes | **no** |
| send messages | yes | yes | **no** |
| add commands | yes | yes | yes |
| store local data | yes | yes | **no** |
| access selected channels | yes | yes | **no** |
| make external network requests | yes | yes | **no** |
| render message content | yes | yes | yes |

### Why the in-process mechanisms hold all seven

Neither runtime gives a guest anything the host did not hand it, and this was
checked rather than assumed.

A QuickJS plugin starts with 72 globals. Every one is an ECMAScript builtin plus
`host`, the object the sandbox installs. Nothing named `fetch`,
`XMLHttpRequest`, `WebSocket`, `require`, `process`, `std`, `os`, or `readFile`
exists. There is no filesystem and no socket to deny access to, so denying
access is not a check that can be got past. `plugins/js/reach.js` enumerates it
and `js::a_plugin_finds_no_network_or_filesystem_global` asserts the empty
result.

A wasm module is stronger still: its import list *is* its capability list,
declared in the file and checkable before an instruction runs. A module asking
for `host::send` without the grant does not fail a check, it fails to
instantiate — the function is not there. Same for a module importing
`wasi_snapshot_preview1::fd_write`. Both are asserted.

Two things the table does not cover. `performance` is among the QuickJS globals,
so a plugin has a high-resolution clock; that is a timing-side-channel surface,
not a capability, and it matters only if a plugin is ever given shared memory or
a thread. And `render message content` returns a value the host puts into the
WebView, which makes host-side sanitisation a requirement under every mechanism
— nothing about isolation helps there.

### Why the child process holds two

A native child process has every privilege the user has, and the parent can
withhold exactly one thing without help from the kernel: its own environment.
The `rogue` fixture runs under a manifest granting nothing but `add commands`,
and:

```
read /etc/passwd, 2947 bytes; socket to 127.0.0.1:9 said connection refused
```

Arbitrary file read and an outbound socket, neither granted. "Connection
refused" is the far end declining, not the sandbox — `socket()` and `connect()`
both succeeded. `proc::nothing_stops_a_plugin_process_reading_files_it_was_never_granted`
asserts the hole so that it breaks loudly if anyone ever plugs it.

That one result takes out five of seven permissions:

- **network requests**: proven reachable.
- **store local data**: the same privileges write files as read them.
- **read messages** and **access selected channels**: the archive is a SQLite
  file the user can read, so a plugin denied messages can open
  `ircx.sqlite3` and read every message on every channel.
- **send messages**: the parent will not relay an ungranted `Send`, and that
  much works. But a plugin that can read the config and open a socket can
  connect to the network itself and send as the user by its own route.

Only `add commands` and `render message content` survive, and they survive
because they are host-side routing decisions rather than capabilities.

The process mechanism could be fixed, with OS sandboxing: seccomp and Landlock
on Linux, `sandbox_init` on macOS, AppContainer on Windows. That is three
separate implementations, none of them prototyped here, each one a project. Ship
it without them and the permission list in the install dialogue is a promise the
software does not keep, which is worse than not offering it.

## What choosing QuickJS costs

- **793 KiB of binary and about 1.2 MiB of RSS for the first plugin.** The
  marginal cost of the second was not measured.
- **Hooks stay synchronous.** Measured above: an unresolved promise is a type
  error today only because the hook returns a string. Going async means putting
  a deadline around the microtask pump.
- **No host function may block.** The hang immunity is a property of the host
  surface. A synchronous host call implementing `network requests` would give it
  away.
- **A terminated plugin is dead for the session.** After a timeout or an
  out-of-memory the runtime is in a state QuickJS makes no promises about, so
  the sandbox refuses further calls. Reloading costs 0.12 ms, so reloading
  automatically and telling the user is affordable; #13's "terminated and
  reported" needs a reload path to mean anything.
- **One runtime per plugin, not one context per plugin.** Separate contexts on
  a shared runtime would keep globals apart, but they share an allocator and an
  interrupt handler, so one plugin's memory limit and one plugin's deadline
  would apply to whichever plugin happened to be running. The spike gives each
  plugin its own runtime, and that is what the per-plugin RSS above buys.
- **The interrupt handler is the entire termination story.** It held for the
  regex case, which was the doubt. It is a property of the QuickJS build, and
  the regex and `Atomics` tests exist to catch a regression on a version bump.
- **A denied capability throws into the plugin**, so a plugin can catch it and
  degrade rather than die. That matches how the rest of the client handles a
  missing capability.

## What is not measured

- **macOS and Windows.** Everything here is Linux x86-64. The process mechanism
  does not build on Windows at all as written — it uses
  `std::os::unix::process::CommandExt`, `RLIMIT_DATA` and `RLIMIT_CPU`. macOS
  exec is slower and code signing adds to launch; the cold-start figures would
  need redoing there.
- ~~**The 665 ms baseline itself.**~~ **Settled.** It was quoted to this spike
  as coming from `docs/end-to-end-run-2.md`, does not appear in that document,
  and this section concluded it might therefore be wrong by a factor of several.
  The citation was wrong and the number was not: it comes from PR #48, a release
  build against an empty profile, timed off the compositor via `WAYLAND_DEBUG`
  over three runs, and it is in `docs/measurements.md` with its method.

  Worth reading that row before reusing this one. The same run measured **722–819
  ms** to webview content — the window is up at 665 ms with nothing on it — so a
  percentage weighed against 665 ms is weighed against the smaller of the two
  numbers a person could mean by "cold start".
- **More than one plugin.** Every figure is one plugin. Marginal cost per
  additional plugin is unknown for all three, and it is the number that matters
  if the answer is ever "users install five".
- **wasmtime precompiled, from a cold process.** `bench` measures it warm at
  0.09 ms. The `probe` binaries only exercise the compile-at-load path, so the
  3.34 ms exec-to-answer figure for wasm is its worst case, not its shipping
  case.
- **Steady-state memory for a precompiled wasm module.** The 8 MiB peak is
  Cranelift compiling.
- **A child process under OS sandboxing.** No seccomp, Landlock, `sandbox_init`
  or AppContainer prototype exists, so the claim that they would restore the
  permission list is reasoning, not evidence.
- **Concurrency.** Every call here is blocking and single-threaded. A real host
  would run hooks off the connection task, and the interaction between a
  100 ms deadline and the event pump is unexplored.
- **The other four extension points.** Only custom slash commands are
  implemented. Message renderers, link and attachment providers, notification
  rules and protocol capability adapters have the same shape — host hands over a
  value, plugin returns one, host applies a deadline — so per-call cost should
  carry, but nobody has checked.

## What happened next

#13 was implemented on this recommendation. `js.rs` became `sandbox.rs` with the
permission checks filled in; `wasm.rs`, `proc.rs`, the `Sandbox` trait and their
fixtures were deleted, because an application with one mechanism does not need
three behind an interface. The failure-mode measurements above were taken with
the prototypes and the tests that replaced them assert the same properties
against the real runtime.

Two findings in this document became constraints on that work rather than
history:

- The `network requests` permission is a host function that waits, so "hang is
  not expressible" is now bounded by a timeout rather than by construction. It
  is given what is left of the call's deadline. `docs/plugins.md` says what that
  costs.
- `render message content` returns a value the host puts on screen, so the host
  sanitises it whatever the mechanism. It does.

`docs/plugins.md` is what a plugin is and what each permission means;
`docs/measurements.md` holds what the runtime costs.
