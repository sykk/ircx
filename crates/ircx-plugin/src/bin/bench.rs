//! What the plugin system costs, in the shapes that decide anything.
//!
//! The load-bearing row is the first: a user with no plugins installed pays one
//! directory listing and nothing else, because no QuickJS runtime is built and
//! no thread is spawned until a plugin's command is actually run.
//!
//! `cargo run --release -p ircx-plugin --bin bench`. Debug numbers differ by
//! more than the gaps being measured, so release is the only meaningful build.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ircx_plugin::{
    net, AnnotateRequest, ArrivedMessage, CommandRequest, CommandSpec, Grants, Limits, Manifest,
    Permission, PluginRuntime, Sandbox,
};

const ECHO: &str = r#"ircx.command("echo", (call) => "pong: " + call.args);"#;

/// The example in `docs/plugins.md`, which is the shape an annotator is
/// expected to be: one regex against the text, and silence for most messages.
const UNITS: &str = r#"
ircx.annotate((message) => {
  const found = /(-?\d+(?:\.\d+)?)\s?F\b/.exec(message.text);
  if (!found) return;
  return String(Math.round(((Number(found[1]) - 32) * 5) / 9)) + " C";
});
"#;

const CHANNEL: &str = "#ircx";

fn main() {
    let root = std::env::temp_dir().join(format!("ircx-bench-{}", std::process::id()));
    let empty = root.join("no-plugins");
    let library = root.join("plugins");
    let source = author(&root);

    println!("| what | runs | median | mean |");
    println!("|---|---|---|---|");

    report("open the library, no plugins installed", 200, || {
        let at = Instant::now();
        let runtime =
            PluginRuntime::open(empty.clone(), Limits::default(), net::refuses()).expect("open");
        let took = at.elapsed();
        drop(runtime);
        took
    });

    let runtime =
        PluginRuntime::open(empty.clone(), Limits::default(), net::refuses()).expect("open");
    report("look a command up, nothing installed", 10_000, || {
        let at = Instant::now();
        let route = runtime.route("echo");
        let took = at.elapsed();
        assert!(route.is_none(), "nothing is installed");
        took
    });
    drop(runtime);

    report("install one plugin", 50, || {
        let _ = fs::remove_dir_all(&library);
        let runtime =
            PluginRuntime::open(library.clone(), Limits::default(), net::refuses()).expect("open");
        let at = Instant::now();
        runtime.install(&source).expect("install");
        at.elapsed()
    });

    // The first call reads the code, builds the runtime and spawns the thread.
    // It happens the first time the user types the command, not at launch.
    report("first call, cold plugin", 50, || {
        let runtime =
            PluginRuntime::open(library.clone(), Limits::default(), net::refuses()).expect("open");
        runtime.set_grants("echo", granted()).expect("grant");
        let route = runtime.route("echo").expect("routed");
        let at = Instant::now();
        runtime.run(&route, call()).expect("answers");
        at.elapsed()
    });

    let runtime =
        PluginRuntime::open(library.clone(), Limits::default(), net::refuses()).expect("open");
    runtime.set_grants("echo", granted()).expect("grant");
    let route = runtime.route("echo").expect("routed");
    runtime.run(&route, call()).expect("answers");
    report("call, warm plugin", 5_000, || {
        let at = Instant::now();
        runtime.run(&route, call()).expect("answers");
        at.elapsed()
    });

    let data = library.join("echo/data.json");
    report("build a runtime and load one plugin", 200, || {
        let at = Instant::now();
        let sandbox = Sandbox::load(
            &granted(),
            Limits::default(),
            net::refuses(),
            ECHO,
            data.clone(),
        )
        .expect("the fixture loads");
        let took = at.elapsed();
        drop(sandbox);
        took
    });

    // Annotators. The load-bearing row here is the first: it is what every
    // conversation pays on every batch of arrivals, whether or not anything
    // annotates.
    let notes = root.join("annotators");
    let annotator_source = author_annotator(&root);
    let runtime =
        PluginRuntime::open(notes.clone(), Limits::default(), net::refuses()).expect("open");
    report("look for annotators, none installed", 10_000, || {
        let at = Instant::now();
        let found = runtime.annotators(CHANNEL);
        let took = at.elapsed();
        assert!(found.is_empty(), "nothing annotates");
        took
    });

    runtime.install(&annotator_source).expect("install");
    runtime.set_grants("units", annotates()).expect("grant");
    report("look for annotators, one installed", 10_000, || {
        let at = Instant::now();
        let found = runtime.annotators(CHANNEL);
        let took = at.elapsed();
        assert_eq!(found.len(), 1, "one annotates");
        took
    });

    let annotator = runtime.annotators(CHANNEL).remove(0);
    runtime
        .annotate(&annotator, batch(1))
        .expect("the batch is annotated");
    report("annotate a batch of 1, warm plugin", 5_000, || {
        let at = Instant::now();
        runtime.annotate(&annotator, batch(1)).expect("annotates");
        at.elapsed()
    });
    report("annotate a batch of 50, warm plugin", 500, || {
        let at = Instant::now();
        runtime.annotate(&annotator, batch(50)).expect("annotates");
        at.elapsed()
    });
    drop(runtime);

    let _ = fs::remove_dir_all(&root);
}

fn annotates() -> Grants {
    Grants {
        permissions: [Permission::AnnotateMessages, Permission::AccessChannels]
            .into_iter()
            .collect(),
        channels: vec![CHANNEL.into()],
        hosts: Vec::new(),
    }
}

/// A batch as a channel produces one: mostly messages with nothing to annotate,
/// because that is what a conversation is. Every fifth carries a temperature.
fn batch(messages: usize) -> AnnotateRequest {
    AnnotateRequest {
        target: CHANNEL.into(),
        messages: (0..messages)
            .map(|n| ArrivedMessage {
                id: format!("m{n}"),
                nick: "sable".into(),
                text: match n % 5 {
                    0 => format!("it is {}F outside", 60 + n),
                    _ => "nothing worth a note in this one".into(),
                },
                time: "2026-07-31T00:00:00Z".into(),
            })
            .collect(),
    }
}

fn author_annotator(root: &Path) -> PathBuf {
    let directory = root.join("annotator-source");
    fs::create_dir_all(&directory).expect("write a plugin to measure");
    let manifest = Manifest {
        id: "units".into(),
        name: "Units".into(),
        version: "1.0.0".into(),
        description: "Reads Fahrenheit in Celsius".into(),
        entry: "main.js".into(),
        annotates: true,
        commands: Vec::new(),
        requests: annotates(),
    };
    let json = serde_json::to_vec_pretty(&manifest).expect("a manifest serialises");
    fs::write(directory.join("plugin.json"), json).expect("write the manifest");
    fs::write(directory.join("main.js"), UNITS).expect("write the code");
    directory
}

fn report(what: &str, runs: usize, mut once: impl FnMut() -> Duration) {
    let mut taken: Vec<Duration> = (0..runs).map(|_| once()).collect();
    taken.sort_unstable();
    let median = taken[taken.len() / 2];
    let mean = taken.iter().sum::<Duration>() / taken.len() as u32;
    println!("| {what} | {runs} | {} | {} |", show(median), show(mean));
}

fn show(duration: Duration) -> String {
    format!("{:.4} ms", duration.as_secs_f64() * 1_000.0)
}

fn granted() -> Grants {
    Grants {
        permissions: [Permission::AddCommands, Permission::RenderContent]
            .into_iter()
            .collect(),
        channels: Vec::new(),
        hosts: Vec::new(),
    }
}

fn call() -> CommandRequest {
    CommandRequest {
        command: "echo".into(),
        args: "hello from the composer".into(),
        target: "#ircx".into(),
        nick: "sykk".into(),
        messages: Vec::new(),
    }
}

fn author(root: &Path) -> PathBuf {
    let directory = root.join("source");
    fs::create_dir_all(&directory).expect("write a plugin to measure");
    let manifest = Manifest {
        id: "echo".into(),
        name: "Echo".into(),
        version: "1.0.0".into(),
        description: "One command, one answer".into(),
        entry: "main.js".into(),
        annotates: false,
        commands: vec![CommandSpec {
            name: "echo".into(),
            summary: "say it back".into(),
        }],
        requests: granted(),
    };
    let json = serde_json::to_vec_pretty(&manifest).expect("a manifest serialises");
    fs::write(directory.join("plugin.json"), json).expect("write the manifest");
    fs::write(directory.join("main.js"), ECHO).expect("write the code");
    directory
}
