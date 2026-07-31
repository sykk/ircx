//! The plugins under `examples/plugins`, installed and run the way a user
//! would install them.
//!
//! An example is a promise: somebody reads it, trusts it, and writes their own
//! against it. One that quietly stopped working is worse than none, so the
//! shipped file is what runs here — not a copy of it in a string.

use std::path::PathBuf;

use ircx_plugin::{
    net, AnnotateRequest, ArrivedMessage, Grants, Limits, Permission, PluginRuntime,
};

const CHANNEL: &str = "#ircx";

fn example(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/plugins")
        .join(name)
}

fn arrivals(texts: &[&str]) -> AnnotateRequest {
    AnnotateRequest {
        target: CHANNEL.into(),
        messages: texts
            .iter()
            .enumerate()
            .map(|(n, text)| ArrivedMessage {
                id: format!("m{n}"),
                nick: "sable".into(),
                text: (*text).to_owned(),
                time: "2026-07-31T00:00:00Z".into(),
            })
            .collect(),
    }
}

/// Installs the example, grants it what its manifest asks for, and reads the
/// notes back. The grant is written here rather than taken from the manifest
/// wholesale because `*` is a choice the user makes, and this is that choice.
fn install(name: &str) -> (PluginRuntime, tempfile::TempDir) {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = PluginRuntime::open(
        root.path().join("plugins"),
        Limits::default(),
        net::refuses(),
    )
    .expect("open the library");
    runtime
        .install(&example(name))
        .expect("the example installs");
    runtime
        .set_grants(
            name,
            Grants {
                permissions: [Permission::AnnotateMessages, Permission::AccessChannels]
                    .into_iter()
                    .collect(),
                channels: vec![CHANNEL.into()],
                hosts: Vec::new(),
            },
        )
        .expect("grant what it asked for");
    (runtime, root)
}

#[test]
fn units_reads_fahrenheit_in_celsius() {
    let (runtime, _root) = install("units");
    let annotator = runtime.annotators(CHANNEL).remove(0);

    let reply = runtime
        .annotate(
            &annotator,
            arrivals(&["it is 72F outside", "72 °F here", "-40F", "and 98.6F"]),
        )
        .expect("the batch is annotated");

    assert_eq!(
        reply
            .notes
            .iter()
            .map(|note| note.text.as_str())
            .collect::<Vec<_>>(),
        ["22 °C", "22 °C", "-40 °C", "37 °C"]
    );
}

/// The half of an annotator that is easy to get wrong: most messages are not
/// about anything it knows, and it has to say nothing about those rather than
/// something empty.
#[test]
fn units_says_nothing_about_a_message_with_no_temperature() {
    let (runtime, _root) = install("units");
    let annotator = runtime.annotators(CHANNEL).remove(0);

    let reply = runtime
        .annotate(
            &annotator,
            arrivals(&[
                "nothing numeric here",
                "he scored 72 points",
                "the F key is stuck",
                "72",
            ]),
        )
        .expect("the batch is annotated");

    assert!(
        reply.notes.is_empty(),
        "expected silence, got {:?}",
        reply.notes
    );
}
