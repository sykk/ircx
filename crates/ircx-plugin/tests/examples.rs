//! The plugins under `examples/plugins`, installed and run the way a user
//! would install them.
//!
//! The shipped file is what runs here rather than a copy of it in a string, so
//! an example that stopped working fails the build rather than the person who
//! trusted it.

use std::path::PathBuf;

use ircx_plugin::{
    net, AnnotateRequest, ArrivedMessage, Grants, Limits, NotifyRequest, Permission, PluginRuntime,
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

/// The same batch on its way to a notification rule, one nick per message
/// because who said it is half of what a rule decides on.
fn said(lines: &[(&str, &str)]) -> NotifyRequest {
    NotifyRequest {
        target: CHANNEL.into(),
        messages: lines
            .iter()
            .enumerate()
            .map(|(n, (nick, text))| ArrivedMessage {
                id: format!("m{n}"),
                nick: (*nick).to_owned(),
                text: (*text).to_owned(),
                time: "2026-07-31T00:00:00Z".into(),
            })
            .collect(),
    }
}

/// Installs the example, grants it what its manifest asks for, and reads the
/// answers back. The grant is written here rather than taken from the manifest
/// wholesale because `*` is a choice the user makes, and this is that choice.
fn install(name: &str, hook: Permission) -> (PluginRuntime, tempfile::TempDir) {
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
                permissions: [hook, Permission::AccessChannels].into_iter().collect(),
                channels: vec![CHANNEL.into()],
                hosts: Vec::new(),
            },
        )
        .expect("grant what it asked for");
    (runtime, root)
}

#[test]
fn units_reads_fahrenheit_in_celsius() {
    let (runtime, _root) = install("units", Permission::AnnotateMessages);
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
    let (runtime, _root) = install("units", Permission::AnnotateMessages);
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

/// The third extension point's example. A rule answers whether a message is
/// worth interrupting you for; what it cannot do is make one quiet.
#[test]
fn deploys_raises_a_build_bot_saying_something_failed() {
    let (runtime, _root) = install("deploys", Permission::RaiseNotifications);
    let rule = runtime.notifiers(CHANNEL).remove(0);

    let reply = runtime
        .notify(
            &rule,
            said(&[
                ("buildbot", "deploy failed on main"),
                ("CI", "the nightly broke"),
                ("drone", "build is failing again"),
            ]),
        )
        .expect("the batch is read");

    assert_eq!(reply.raised, ["m0", "m1", "m2"]);
}

/// The half a rule is easy to get wrong: most of a channel is not worth
/// interrupting anybody for, and a rule that raises everything is a rule the
/// user turns off.
#[test]
fn deploys_leaves_the_rest_of_the_channel_alone() {
    let (runtime, _root) = install("deploys", Permission::RaiseNotifications);
    let rule = runtime.notifiers(CHANNEL).remove(0);

    let reply = runtime
        .notify(
            &rule,
            said(&[
                ("buildbot", "deploy finished on main"),
                ("sable", "my deploy failed earlier"),
                ("nyx", "morning"),
                ("buildbot", "starting a build"),
            ]),
        )
        .expect("the batch is read");

    assert!(
        reply.raised.is_empty(),
        "a person saying it failed is not the bot saying so: {:?}",
        reply.raised
    );
}
