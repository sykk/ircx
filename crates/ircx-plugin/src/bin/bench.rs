//! Every number in `docs/plugin-isolation.md` that is not a file size comes
//! from this binary. Run it from a release build; the debug numbers are off by
//! more than the differences being measured.
//!
//! ```text
//! cargo run --release -p ircx-plugin --bin bench
//! ```
//!
//! What each section covers is stated in its header, because a per-call number
//! without its guest is not comparable to anything.

use std::time::{Duration, Instant};

use ircx_plugin::{Failure, Manifest, Sandbox};

const STARTUP_REPS: usize = 25;
const CALL_REPS: usize = 50_000;
const PROC_CALL_REPS: usize = 20_000;

fn main() {
    println!("# startup");
    println!(
        "Median of {STARTUP_REPS} runs, one fresh sandbox per run. `runtime` is the \
         per-process part (engine, compiler, interpreter);"
    );
    println!("`load` is that plus reading one plugin; `first call` is that plus one round trip.\n");
    println!("| mechanism | runtime | load | first call |");
    println!("|---|---|---|---|");
    #[cfg(feature = "js")]
    js::startup();
    #[cfg(feature = "wasm")]
    wasm::startup();
    #[cfg(feature = "proc")]
    proc::startup();

    println!("\n# per call");
    let arg_len = serde_json::to_string(&ircx_plugin::fixtures::call())
        .expect("call serialises")
        .len();
    println!(
        "One hook call on a warm sandbox: a {arg_len}-byte JSON argument in, a string out. The \
         guest does one concatenation,"
    );
    println!("so this is boundary cost and almost nothing else.\n");
    println!("| mechanism | calls | median | p99 | mean |");
    println!("|---|---|---|---|---|");
    #[cfg(feature = "js")]
    js::per_call();
    #[cfg(feature = "wasm")]
    wasm::per_call();
    #[cfg(feature = "proc")]
    proc::per_call();

    println!("\n# failure modes");
    println!(
        "Deadline is 100 ms, memory limit 8 MiB. `after` is whether the same sandbox answered a \
         later call,"
    );
    println!("and every row was followed by a fresh sandbox answering correctly.\n");
    println!("| mechanism | mode | took | outcome | same sandbox after |");
    println!("|---|---|---|---|---|");
    #[cfg(feature = "js")]
    js::failures();
    #[cfg(feature = "wasm")]
    wasm::failures();
    #[cfg(feature = "proc")]
    proc::failures();

    println!("\n# permissions");
    println!("| mechanism | plugin asked to | manifest granted it | what happened |");
    println!("|---|---|---|---|");
    #[cfg(feature = "js")]
    js::permissions();
    #[cfg(feature = "wasm")]
    wasm::permissions();
    #[cfg(feature = "proc")]
    proc::permissions();
}

fn manifest() -> Manifest {
    Manifest::command_only("spike")
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort_unstable();
    samples[samples.len() / 2]
}

fn quantile(samples: &[Duration], q: f64) -> Duration {
    let mut sorted = samples.to_vec();
    sorted.sort_unstable();
    sorted[((sorted.len() as f64 * q) as usize).min(sorted.len() - 1)]
}

fn show(d: Duration) -> String {
    let ns = d.as_nanos();
    if ns < 10_000 {
        format!("{ns} ns")
    } else if ns < 10_000_000 {
        format!("{:.2} ms", ns as f64 / 1e6)
    } else {
        format!("{:.1} ms", ns as f64 / 1e6)
    }
}

fn outcome(result: &Result<String, Failure>) -> String {
    match result {
        Ok(reply) if reply.is_empty() => "returned normally, empty reply".to_owned(),
        Ok(_) => "returned normally".to_owned(),
        Err(f) => f.to_string(),
    }
}

/// Rows are written the same way for every mechanism so the table can be read
/// down a column.
fn row(mechanism: &str, mode: &str, took: Duration, result: &Result<String, Failure>, after: &str) {
    println!(
        "| {mechanism} | {mode} | {} | {} | {after} |",
        show(took),
        outcome(result)
    );
}

fn timed<T>(f: impl FnOnce() -> T) -> (T, Duration) {
    let at = Instant::now();
    let out = f();
    (out, at.elapsed())
}

#[cfg(feature = "js")]
mod js {
    use super::*;
    use ircx_plugin::js::JsSandbox;
    use ircx_plugin::{fixtures, Permission};

    pub fn startup() {
        let mut runtime = Vec::new();
        let mut load = Vec::new();
        let mut first = Vec::new();
        for _ in 0..STARTUP_REPS {
            let (sandbox, t) = timed(|| JsSandbox::new(manifest()).expect("runtime"));
            runtime.push(t);
            drop(sandbox);

            let at = Instant::now();
            let mut plugin =
                JsSandbox::load(manifest(), fixtures::JS_ECHO.as_bytes()).expect("load");
            load.push(at.elapsed());
            plugin.call_command(&fixtures::call()).expect("call");
            first.push(at.elapsed());
        }
        println!(
            "| QuickJS | {} | {} | {} |",
            show(median(runtime)),
            show(median(load)),
            show(median(first))
        );
    }

    pub fn per_call() {
        let mut plugin = JsSandbox::load(manifest(), fixtures::JS_ECHO.as_bytes()).expect("load");
        let call = fixtures::call();
        for _ in 0..1000 {
            plugin.call_command(&call).expect("warmup");
        }
        let mut samples = Vec::with_capacity(CALL_REPS);
        for _ in 0..CALL_REPS {
            let (out, t) = timed(|| plugin.call_command(&call));
            out.expect("call");
            samples.push(t);
        }
        let total: Duration = samples.iter().sum();
        println!(
            "| QuickJS | {CALL_REPS} | {} | {} | {} |",
            show(median(samples.clone())),
            show(quantile(&samples, 0.99)),
            show(total / CALL_REPS as u32)
        );
    }

    pub fn failures() {
        for (mode, source) in [
            ("panic", fixtures::JS_PANIC),
            ("infinite loop", fixtures::JS_LOOP),
            ("hang", fixtures::JS_HANG),
            ("memory exhaustion", fixtures::JS_MEMORY),
            ("runtime loop (regex)", fixtures::JS_REGEX),
        ] {
            let mut plugin = match JsSandbox::load(manifest(), source.as_bytes()) {
                Ok(p) => p,
                Err(e) => {
                    println!("| QuickJS | {mode} | - | refused at load: {e} | - |");
                    continue;
                }
            };
            let (result, took) = timed(|| plugin.call_command(&fixtures::call()));
            let after = match plugin.call_command(&fixtures::call()) {
                Ok(_) => "answered",
                Err(Failure::Raised(_)) => "raised again",
                Err(_) => "refuses further calls",
            };
            row("QuickJS", mode, took, &result, after);
            drop(plugin);
            let mut fresh =
                JsSandbox::load(manifest(), fixtures::JS_ECHO.as_bytes()).expect("host survived");
            fresh
                .call_command(&fixtures::call())
                .expect("host survived");
        }
    }

    pub fn permissions() {
        let mut granted =
            JsSandbox::load(manifest(), fixtures::JS_SENDER.as_bytes()).expect("load");
        let sent = granted.call_command(&fixtures::call());
        println!(
            "| QuickJS | send a message | yes | {} |",
            match sent {
                Ok(_) => format!("host sent {:?}", granted.outbox()),
                Err(e) => e.to_string(),
            }
        );

        let mut bare = manifest();
        bare.permissions = vec![Permission::AddCommands];
        let mut denied = JsSandbox::load(bare, fixtures::JS_SENDER.as_bytes()).expect("load");
        let blocked = denied.call_command(&fixtures::call());
        println!(
            "| QuickJS | send a message | no | {} |",
            match blocked {
                Ok(_) => format!("sent anyway: {:?}", denied.outbox()),
                Err(e) => format!("call failed: {e}"),
            }
        );
    }
}

#[cfg(feature = "wasm")]
mod wasm {
    use super::*;
    use ircx_plugin::wasm::WasmSandbox;
    use ircx_plugin::{fixtures, Permission};

    pub fn startup() {
        // Three shapes of the same plugin, because most of what wasm costs at
        // load is Cranelift and how much of it you pay depends on what the
        // plugin ships: text, binary wasm, or wasmtime's own compiled form.
        let binary = wat::parse_bytes(fixtures::WASM_ECHO)
            .expect("wat parses")
            .into_owned();
        let compiled = WasmSandbox::precompile(fixtures::WASM_ECHO).expect("precompile");

        let mut runtime = Vec::new();
        let mut from_wat = (Vec::new(), Vec::new());
        let mut from_wasm = (Vec::new(), Vec::new());
        let mut from_compiled = (Vec::new(), Vec::new());
        for _ in 0..STARTUP_REPS {
            let (engine, t) = timed(|| WasmSandbox::engine().expect("engine"));
            runtime.push(t);
            drop(engine);

            for (source, into) in [
                (fixtures::WASM_ECHO, &mut from_wat),
                (binary.as_slice(), &mut from_wasm),
            ] {
                let at = Instant::now();
                let mut plugin = WasmSandbox::load(manifest(), source).expect("load");
                into.0.push(at.elapsed());
                plugin.call_command(&fixtures::call()).expect("call");
                into.1.push(at.elapsed());
            }

            let at = Instant::now();
            // Safe here because `compiled` came from this process's wasmtime.
            let mut plugin =
                unsafe { WasmSandbox::load_precompiled(manifest(), &compiled) }.expect("load");
            from_compiled.0.push(at.elapsed());
            plugin.call_command(&fixtures::call()).expect("call");
            from_compiled.1.push(at.elapsed());
        }
        let runtime = show(median(runtime));
        for (label, samples) in [
            ("wasmtime, plugin ships wat", from_wat),
            ("wasmtime, plugin ships wasm", from_wasm),
            ("wasmtime, precompiled at install", from_compiled),
        ] {
            println!(
                "| {label} | {runtime} | {} | {} |",
                show(median(samples.0)),
                show(median(samples.1))
            );
        }
        println!(
            "| | | | wat {} B, wasm {} B, precompiled {} B |",
            fixtures::WASM_ECHO.len(),
            binary.len(),
            compiled.len()
        );
    }

    pub fn per_call() {
        let mut plugin = WasmSandbox::load(manifest(), fixtures::WASM_ECHO).expect("load");
        let call = fixtures::call();
        for _ in 0..1000 {
            plugin.call_command(&call).expect("warmup");
        }
        let mut samples = Vec::with_capacity(CALL_REPS);
        for _ in 0..CALL_REPS {
            let (out, t) = timed(|| plugin.call_command(&call));
            out.expect("call");
            samples.push(t);
        }
        let total: Duration = samples.iter().sum();
        println!(
            "| wasmtime | {CALL_REPS} | {} | {} | {} |",
            show(median(samples.clone())),
            show(quantile(&samples, 0.99)),
            show(total / CALL_REPS as u32)
        );
    }

    pub fn failures() {
        println!(
            "| wasmtime | hang | - | not expressible: a guest with no imports cannot block | - |"
        );
        println!("| wasmtime | runtime loop | - | not expressible: the runtime runs only guest code | - |");
        for (mode, source) in [
            ("panic", fixtures::WASM_PANIC),
            ("infinite loop", fixtures::WASM_LOOP),
            ("memory exhaustion", fixtures::WASM_MEMORY),
        ] {
            let mut plugin = match WasmSandbox::load(manifest(), source) {
                Ok(p) => p,
                Err(e) => {
                    println!("| wasmtime | {mode} | - | refused at load: {e} | - |");
                    continue;
                }
            };
            let (result, took) = timed(|| plugin.call_command(&fixtures::call()));
            let held = plugin.memory_bytes();
            let after = match plugin.call_command(&fixtures::call()) {
                Ok(_) => "answered",
                Err(Failure::Raised(_)) => "raised again",
                Err(_) => "refuses further calls",
            };
            if mode == "memory exhaustion" {
                println!(
                    "| wasmtime | {mode} | {} | grow refused at {} KiB, guest carried on | {after} |",
                    show(took),
                    held / 1024
                );
            } else {
                row("wasmtime", mode, took, &result, after);
            }
            drop(plugin);
            let mut fresh =
                WasmSandbox::load(manifest(), fixtures::WASM_ECHO).expect("host survived");
            fresh
                .call_command(&fixtures::call())
                .expect("host survived");
        }
    }

    pub fn permissions() {
        let mut granted = WasmSandbox::load(manifest(), fixtures::WASM_SENDER).expect("load");
        let sent = granted.call_command(&fixtures::call());
        println!(
            "| wasmtime | send a message | yes | {} |",
            match sent {
                Ok(_) => format!("host sent {:?}", granted.outbox()),
                Err(e) => e.to_string(),
            }
        );

        let mut bare = manifest();
        bare.permissions = vec![Permission::AddCommands];
        println!(
            "| wasmtime | send a message | no | {} |",
            match WasmSandbox::load(bare, fixtures::WASM_SENDER) {
                Ok(_) => "instantiated anyway".to_owned(),
                Err(e) => format!("refused at load: {e}"),
            }
        );
    }
}

#[cfg(feature = "proc")]
mod proc {
    use super::*;
    use ircx_plugin::proc::ProcSandbox;
    use ircx_plugin::{fixtures, Permission};

    fn exe() -> std::path::PathBuf {
        ProcSandbox::child_exe()
    }

    pub fn startup() {
        let mut spawn = Vec::new();
        let mut first = Vec::new();
        for _ in 0..STARTUP_REPS {
            let at = Instant::now();
            let mut plugin = ProcSandbox::spawn(manifest(), &exe(), "echo").expect("spawn");
            spawn.push(at.elapsed());
            plugin.call_command(&fixtures::call()).expect("call");
            first.push(at.elapsed());
        }
        println!(
            "| process | none | {} | {} |",
            show(median(spawn)),
            show(median(first))
        );
    }

    pub fn per_call() {
        let mut plugin = ProcSandbox::spawn(manifest(), &exe(), "echo").expect("spawn");
        let call = fixtures::call();
        for _ in 0..1000 {
            plugin.call_command(&call).expect("warmup");
        }
        let mut samples = Vec::with_capacity(PROC_CALL_REPS);
        for _ in 0..PROC_CALL_REPS {
            let (out, t) = timed(|| plugin.call_command(&call));
            out.expect("call");
            samples.push(t);
        }
        let total: Duration = samples.iter().sum();
        println!(
            "| process | {PROC_CALL_REPS} | {} | {} | {} |",
            show(median(samples.clone())),
            show(quantile(&samples, 0.99)),
            show(total / PROC_CALL_REPS as u32)
        );
    }

    pub fn failures() {
        for (mode, arg) in [
            ("panic", "panic"),
            ("infinite loop", "loop"),
            ("hang", "hang"),
            ("memory exhaustion", "memory"),
        ] {
            let mut plugin = ProcSandbox::spawn(manifest(), &exe(), arg).expect("spawn");
            let (result, took) = timed(|| plugin.call_command(&fixtures::call()));
            let after = match plugin.call_command(&fixtures::call()) {
                Ok(_) => "answered",
                Err(_) => "refuses further calls",
            };
            row("process", mode, took, &result, after);
            drop(plugin);
            let mut fresh = ProcSandbox::spawn(manifest(), &exe(), "echo").expect("host survived");
            fresh
                .call_command(&fixtures::call())
                .expect("host survived");
        }
        println!("| process | runtime loop | - | not applicable: no runtime is shared with the host | - |");
    }

    pub fn permissions() {
        let mut granted = ProcSandbox::spawn(manifest(), &exe(), "sender").expect("spawn");
        let sent = granted.call_command(&fixtures::call());
        println!(
            "| process | send a message | yes | {} |",
            match sent {
                Ok(_) => format!("host sent {:?}", granted.outbox()),
                Err(e) => e.to_string(),
            }
        );

        let mut bare = manifest();
        bare.permissions = vec![Permission::AddCommands];
        let mut denied = ProcSandbox::spawn(bare.clone(), &exe(), "sender").expect("spawn");
        println!(
            "| process | send a message | no | {} |",
            match denied.call_command(&fixtures::call()) {
                Ok(_) => format!("sent anyway: {:?}", denied.outbox()),
                Err(e) => e.to_string(),
            }
        );

        let mut rogue = ProcSandbox::spawn(bare, &exe(), "rogue").expect("spawn");
        println!(
            "| process | read files and open a socket | no | {} |",
            match rogue.call_command(&fixtures::call()) {
                Ok(reply) => reply,
                Err(e) => e.to_string(),
            }
        );
    }
}
