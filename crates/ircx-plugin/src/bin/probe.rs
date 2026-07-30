//! One binary per mechanism, for the two numbers that only a whole binary can
//! answer: how much it adds to the executable, and how much of the startup
//! budget it spends.
//!
//! Built four ways — no backend, then each backend alone — so the size of the
//! backend is the difference between two binaries that are otherwise the same
//! code. Every build does the same work: load the echo plugin and call it once.
//!
//! ```text
//! cargo build --release -p ircx-plugin --no-default-features --bin probe
//! cargo build --release -p ircx-plugin --no-default-features --features js --bin probe
//! ```
//!
//! Prints `phase<TAB>nanoseconds` on stdout and the reply on stderr, so a
//! caller timing the whole process sees nothing but the process.

use std::time::Instant;

#[allow(unused_imports)]
use ircx_plugin::{fixtures, CommandCall, Manifest, Sandbox};

fn main() {
    let started = Instant::now();
    let mut phases: Vec<(&str, u128)> = Vec::new();

    #[allow(unused_mut)]
    let mut replies: Vec<String> = Vec::new();

    #[cfg(feature = "js")]
    {
        use ircx_plugin::js::JsSandbox;
        let manifest = Manifest::command_only("probe");
        let sandbox = JsSandbox::new(manifest.clone()).expect("runtime");
        phases.push(("runtime-ready", started.elapsed().as_nanos()));
        drop(sandbox);
        let mut plugin =
            JsSandbox::load(manifest, fixtures::JS_ECHO.as_bytes()).expect("load echo.js");
        phases.push(("plugin-loaded", started.elapsed().as_nanos()));
        replies.push(plugin.call_command(&fixtures::call()).expect("first call"));
        phases.push(("first-call", started.elapsed().as_nanos()));
    }

    #[cfg(feature = "wasm")]
    {
        use ircx_plugin::wasm::WasmSandbox;
        let manifest = Manifest::command_only("probe");
        let engine = WasmSandbox::engine().expect("engine");
        phases.push(("runtime-ready", started.elapsed().as_nanos()));
        drop(engine);
        let mut plugin = WasmSandbox::load(manifest, fixtures::WASM_ECHO).expect("load echo.wat");
        phases.push(("plugin-loaded", started.elapsed().as_nanos()));
        replies.push(plugin.call_command(&fixtures::call()).expect("first call"));
        phases.push(("first-call", started.elapsed().as_nanos()));
    }

    #[cfg(feature = "proc")]
    {
        use ircx_plugin::proc::ProcSandbox;
        let manifest = Manifest::command_only("probe");
        let exe = ProcSandbox::child_exe();
        phases.push(("runtime-ready", started.elapsed().as_nanos()));
        let mut plugin = ProcSandbox::spawn(manifest, &exe, "echo").expect("spawn plugin-child");
        phases.push(("plugin-loaded", started.elapsed().as_nanos()));
        replies.push(plugin.call_command(&fixtures::call()).expect("first call"));
        phases.push(("first-call", started.elapsed().as_nanos()));
    }

    phases.push(("main-returns", started.elapsed().as_nanos()));
    for (name, ns) in &phases {
        println!("{name}\t{ns}");
    }
    for reply in &replies {
        eprintln!("{reply}");
    }
}
