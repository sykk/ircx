//! The permissions `ircclient.md` names, one section each, and the eighth
//! that `docs/plugins.md` adds for the annotator.
//!
//! A permission is only real if the mechanism can refuse the capability when
//! the grant is withheld, so every one of these grants it, withholds it, and
//! asserts both answers. `docs/plugin-isolation.md` is the write-up that says
//! why a subprocess could only do two of them.

use std::path::Path;

use ircx_plugin::{
    net, ContextMessage, Failure, Fetcher, Grants, Limits, Outgoing, Permission, PluginRuntime,
    Sandbox,
};

mod common;
use common::{arrivals, author, call, grants, in_channels, on_hosts, Requests, TARGET};

fn load(directory: &Path, source: &str, grants: &Grants) -> Sandbox {
    with_host(directory, source, grants, net::refuses())
}

fn with_host(directory: &Path, source: &str, grants: &Grants, fetch: Fetcher) -> Sandbox {
    Sandbox::load(
        grants,
        Limits::default(),
        fetch,
        source,
        directory.join("data.json"),
    )
    .expect("the fixture loads")
}

fn shows() -> Grants {
    grants(&[Permission::AddCommands, Permission::RenderContent])
}

/// Withholding `add-commands` does not make the command fail, it makes it not
/// exist: nothing routes to a plugin that was not allowed to add one.
#[test]
fn a_command_belongs_to_a_plugin_only_while_the_grant_does() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = PluginRuntime::open(
        root.path().join("plugins"),
        Limits::default(),
        net::refuses(),
    )
    .expect("open the library");
    let source = author(
        root.path(),
        "echo",
        include_str!("plugins/echo.js"),
        shows(),
    );
    runtime.install(&source).expect("install");

    assert!(
        runtime.route("echo").is_none(),
        "installing grants nothing, so nothing is routed yet"
    );

    runtime.set_grants("echo", shows()).expect("grant");
    let route = runtime.route("echo").expect("now it owns /echo");
    let reply = runtime.run(&route, call("echo", "hello")).expect("answers");
    assert_eq!(reply.content.as_deref(), Some("pong: hello"));

    runtime
        .set_grants("echo", Grants::default())
        .expect("revoke everything");
    assert!(
        runtime.route("echo").is_none(),
        "revoking takes the command back out of the client"
    );
}

#[test]
fn sending_needs_the_grant() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let allowed = in_channels(
        grants(&[
            Permission::AddCommands,
            Permission::SendMessages,
            Permission::RenderContent,
        ]),
        &[TARGET],
    );
    let mut granted = load(
        directory.path(),
        include_str!("plugins/sender.js"),
        &allowed,
    );
    let reply = granted.call(&call("sender", "hello")).expect("sends");
    assert_eq!(
        reply.sends,
        vec![Outgoing {
            target: TARGET.into(),
            text: "hello".into(),
        }]
    );

    let mut denied = load(
        directory.path(),
        include_str!("plugins/sender.js"),
        &shows(),
    );
    assert_eq!(
        denied.call(&call("sender", "hello")),
        Err(Failure::Denied(Permission::SendMessages))
    );
}

/// A refusal is thrown into the plugin rather than returned, so a plugin can
/// catch it and do less — the same way the client degrades when a server is
/// missing an IRCv3 capability.
///
/// It is an `Error`, and this asserts the shape the plugin receives rather than
/// only that it received something. A bare string is catchable too, but then
/// `refused.message` is `undefined` and a plugin that degrades correctly cannot
/// say why it did.
#[test]
fn a_refusal_can_be_caught_and_worked_around() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let mut plugin = load(
        directory.path(),
        include_str!("plugins/degrader.js"),
        &shows(),
    );
    let reply = plugin.call(&call("degrader", "hello")).expect("carries on");
    assert_eq!(
        reply.content.as_deref(),
        Some("carried on without sending: ircx: send-messages was not granted")
    );
    assert!(reply.sends.is_empty());
}

#[test]
fn sending_is_refused_outside_the_channels_that_were_selected() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let elsewhere = in_channels(
        grants(&[
            Permission::AddCommands,
            Permission::SendMessages,
            Permission::RenderContent,
        ]),
        &["#somewhere-else"],
    );
    let mut plugin = load(
        directory.path(),
        include_str!("plugins/sender.js"),
        &elsewhere,
    );
    assert_eq!(
        plugin.call(&call("sender", "hello")),
        Err(Failure::Denied(Permission::AccessChannels))
    );
}

/// Every conversation is a choice the user makes explicitly, and it is the
/// only way a plugin reaches one it was not named in.
#[test]
fn every_channel_is_a_grant_of_its_own() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let everywhere = in_channels(
        grants(&[
            Permission::AddCommands,
            Permission::SendMessages,
            Permission::RenderContent,
        ]),
        &["*"],
    );
    let mut plugin = load(
        directory.path(),
        include_str!("plugins/sender.js"),
        &everywhere,
    );
    let reply = plugin.call(&call("sender", "hello")).expect("sends");
    assert_eq!(reply.sends.len(), 1);
}

fn said(nick: &str, text: &str) -> ContextMessage {
    ContextMessage {
        nick: nick.into(),
        text: text.into(),
        time: "2026-07-30T12:00:00Z".into(),
    }
}

#[test]
fn reading_the_conversation_needs_the_grant() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let mut request = call("reader", "");
    request.messages = vec![said("sykk", "the first thing"), said("ana", "the second")];

    let allowed = in_channels(
        grants(&[
            Permission::AddCommands,
            Permission::ReadMessages,
            Permission::RenderContent,
        ]),
        &[TARGET],
    );
    let mut granted = load(
        directory.path(),
        include_str!("plugins/reader.js"),
        &allowed,
    );
    assert_eq!(
        granted.call(&request).expect("reads").content.as_deref(),
        Some("sykk: the first thing\nana: the second")
    );

    // Handed the same messages without the grant, the sandbox drops them
    // before the plugin runs rather than trusting the caller to have.
    let mut denied = load(
        directory.path(),
        include_str!("plugins/reader.js"),
        &shows(),
    );
    assert_eq!(
        denied.call(&request).expect("runs").content.as_deref(),
        Some("nothing to read")
    );
}

#[test]
fn reading_is_scoped_to_the_channels_that_were_selected() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let mut request = call("reader", "");
    request.messages = vec![said("sykk", "the first thing")];

    let elsewhere = in_channels(
        grants(&[
            Permission::AddCommands,
            Permission::ReadMessages,
            Permission::RenderContent,
        ]),
        &["#somewhere-else"],
    );
    let mut plugin = load(
        directory.path(),
        include_str!("plugins/reader.js"),
        &elsewhere,
    );
    assert_eq!(
        plugin.call(&request).expect("runs").content.as_deref(),
        Some("nothing to read")
    );
}

#[test]
fn storing_data_needs_the_grant_and_outlives_the_runtime() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let allowed = grants(&[
        Permission::AddCommands,
        Permission::StoreLocalData,
        Permission::RenderContent,
    ]);

    let mut plugin = load(
        directory.path(),
        include_str!("plugins/storer.js"),
        &allowed,
    );
    assert_eq!(
        plugin.call(&call("storer", "")).expect("stores").content,
        Some("1 seen".into())
    );
    drop(plugin);

    // A new runtime over the same storage: what the plugin kept is still there.
    let mut again = load(
        directory.path(),
        include_str!("plugins/storer.js"),
        &allowed,
    );
    assert_eq!(
        again.call(&call("storer", "")).expect("stores").content,
        Some("2 seen".into())
    );

    let mut denied = load(
        directory.path(),
        include_str!("plugins/storer.js"),
        &shows(),
    );
    assert_eq!(
        denied.call(&call("storer", "")),
        Err(Failure::Denied(Permission::StoreLocalData))
    );
}

#[test]
fn fetching_needs_the_grant_and_the_host() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let url = "https://api.example.test/thing";
    let host = Requests::default();

    let allowed = on_hosts(shows(), &["api.example.test"]);
    let mut granted = with_host(
        directory.path(),
        include_str!("plugins/fetcher.js"),
        &allowed,
        host.fetcher("it worked"),
    );
    assert_eq!(
        granted
            .call(&call("fetcher", url))
            .expect("fetches")
            .content,
        Some("200 it worked".into())
    );
    let seen = host.seen();
    assert_eq!(seen.len(), 1, "one request reached the host");
    assert_eq!(seen[0].0, url);
    assert!(
        seen[0].1 > std::time::Duration::ZERO && seen[0].1 <= Limits::default().call,
        "a request is given what is left of the deadline, not more: {:?}",
        seen[0].1
    );

    let elsewhere = on_hosts(shows(), &["other.example.test"]);
    let host = Requests::default();
    let mut wrong_host = with_host(
        directory.path(),
        include_str!("plugins/fetcher.js"),
        &elsewhere,
        host.fetcher("it worked"),
    );
    assert_eq!(
        wrong_host.call(&call("fetcher", url)),
        Err(Failure::Denied(Permission::NetworkRequests)),
        "a granted host is the only host"
    );

    let host = Requests::default();
    let mut denied = with_host(
        directory.path(),
        include_str!("plugins/fetcher.js"),
        &shows(),
        host.fetcher("it worked"),
    );
    assert_eq!(
        denied.call(&call("fetcher", url)),
        Err(Failure::Denied(Permission::NetworkRequests))
    );
    assert!(
        host.seen().is_empty(),
        "an ungranted plugin never reaches the host that would make the request"
    );
}

/// The grant is a list of hosts, so what counts as a host is part of the
/// enforcement: an address that is not http cannot be one, and neither can one
/// carrying credentials that read like the granted name.
#[test]
fn only_a_web_address_can_be_fetched() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let allowed = on_hosts(shows(), &["api.example.test"]);
    let host = Requests::default();
    let mut plugin = with_host(
        directory.path(),
        include_str!("plugins/fetcher.js"),
        &allowed,
        host.fetcher("it worked"),
    );

    for url in [
        "file:///etc/passwd",
        "ftp://api.example.test/thing",
        "http://api.example.test@evil.example/thing",
    ] {
        let failure = plugin
            .call(&call("fetcher", url))
            .expect_err("not something a plugin may reach");
        assert!(
            matches!(&failure, Failure::Raised(message) if message.contains("not a URL"))
                || failure == Failure::Denied(Permission::NetworkRequests),
            "{url}: {failure}"
        );
    }
    assert!(host.seen().is_empty(), "none of them reached the host");
}

#[test]
fn showing_text_in_the_conversation_needs_the_grant() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let mut denied = load(
        directory.path(),
        include_str!("plugins/echo.js"),
        &grants(&[Permission::AddCommands]),
    );
    assert_eq!(
        denied.call(&call("echo", "hello")),
        Err(Failure::Denied(Permission::RenderContent))
    );
}

/// Sanitising is the host's job under every isolation mechanism: what comes
/// back is a value the client puts on screen, and nothing about a sandbox
/// makes that value safe.
#[test]
fn what_a_plugin_returns_is_cut_down_to_what_a_message_may_be() {
    const NOISY: &str = r#"ircx.command("noisy", () => "a\u0007b c" + "\nline".repeat(400));"#;
    let directory = tempfile::tempdir().expect("a temporary directory");
    let mut plugin = load(directory.path(), NOISY, &shows());
    let content = plugin
        .call(&call("noisy", ""))
        .expect("answers")
        .content
        .expect("some content");

    assert!(
        content.starts_with("ab c"),
        "control characters do not survive: {content:?}"
    );
    assert!(
        content.lines().count() <= 40,
        "{} lines is more than one command may say",
        content.lines().count()
    );
}

/// The permission table rests on this: QuickJS hands a plugin no way to reach
/// the network or the disk, so those permissions mean something. If this starts
/// failing, the runtime grew an intrinsic and the table is wrong.
#[test]
fn a_plugin_finds_no_network_or_filesystem_global() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let mut plugin = load(directory.path(), include_str!("plugins/reach.js"), &shows());
    let answer = plugin.call(&call("reach", "")).expect("answers");
    let found: serde_json::Value =
        serde_json::from_str(&answer.content.unwrap_or_default()).expect("reach answers json");

    let reachable = found["reachable"].as_array().expect("a list");
    assert!(reachable.is_empty(), "a plugin reached {reachable:?}");

    let globals = found["globals"].as_array().expect("a list");
    assert!(
        globals.iter().any(|name| name == "ircx"),
        "the host surface is there"
    );
}

/// The eighth permission, and the second extension point. `docs/plugins.md`
/// designs it; these are the refusals that make the design real.
mod annotating {
    use super::*;

    const UNITS: &str = r#"
        ircx.annotate((message) => {
          const found = /(-?\d+)F\b/.exec(message.text);
          if (!found) return;
          return String(Math.round((Number(found[1]) - 32) * 5 / 9)) + " C";
        });
    "#;

    fn annotates() -> Grants {
        in_channels(grants(&[Permission::AnnotateMessages]), &[TARGET])
    }

    #[test]
    fn a_note_names_the_message_it_is_about() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let mut plugin = load(root.path(), UNITS, &annotates());

        let reply = plugin
            .annotate(&arrivals(&[
                ("m1", "sable", "it is 72F outside"),
                ("m2", "nyx", "nothing numeric here"),
            ]))
            .expect("the batch is annotated");

        assert_eq!(reply.notes.len(), 1, "the second message was passed over");
        assert_eq!(reply.notes[0].message, "m1");
        assert_eq!(reply.notes[0].text, "22 C");
    }

    #[test]
    fn without_the_grant_it_is_refused() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let mut plugin = load(
            root.path(),
            UNITS,
            &in_channels(Grants::default(), &[TARGET]),
        );

        assert_eq!(
            plugin.annotate(&arrivals(&[("m1", "sable", "it is 72F outside")])),
            Err(Failure::Denied(Permission::AnnotateMessages))
        );
    }

    /// Scoped by `access-channels`, the way sending and reading are. A grant
    /// that names one channel does not reach another.
    #[test]
    fn it_reaches_only_the_channels_the_grant_names() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let mut plugin = load(root.path(), UNITS, &annotates());

        let mut elsewhere = arrivals(&[("m1", "sable", "it is 72F outside")]);
        elsewhere.target = "#somewhere-else".into();

        assert_eq!(
            plugin.annotate(&elsewhere),
            Err(Failure::Denied(Permission::AccessChannels))
        );
    }

    /// The bound that makes a plugin's sends safe is the keystroke: `MAX_SENDS`
    /// is eight a command because a command is one thing a person asked for. A
    /// send caused by an arrival has no such unit, so the door is shut rather
    /// than counted.
    #[test]
    fn it_cannot_send_however_it_is_granted() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let everything = in_channels(
            grants(&[
                Permission::AnnotateMessages,
                Permission::SendMessages,
                Permission::AddCommands,
                Permission::RenderContent,
            ]),
            &[TARGET],
        );
        let mut plugin = load(
            root.path(),
            r##"ircx.annotate(() => { ircx.send("#ircx", "hello"); return "sent"; });"##,
            &everything,
        );

        let failure = plugin
            .annotate(&arrivals(&[("m1", "sable", "anything")]))
            .expect_err("sending from an annotator is refused");
        assert!(
            matches!(&failure, Failure::Raised(why) if why.contains("ircx.send")),
            "expected the refusal to name what it refused, got {failure:?}"
        );
    }

    /// A fetch per arriving message is the client reaching a remote URL on its
    /// own, which is the one exclusion this milestone made deliberately.
    #[test]
    fn it_cannot_fetch_however_it_is_granted() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let everything = on_hosts(
            in_channels(grants(&[Permission::AnnotateMessages]), &[TARGET]),
            &["example.com"],
        );
        let requests = Requests::default();
        let mut plugin = with_host(
            root.path(),
            r#"ircx.annotate(() => ircx.fetch("https://example.com/x"));"#,
            &everything,
            requests.fetcher("{}"),
        );

        let failure = plugin
            .annotate(&arrivals(&[("m1", "sable", "anything")]))
            .expect_err("fetching from an annotator is refused");
        assert!(
            matches!(&failure, Failure::Raised(why) if why.contains("ircx.fetch")),
            "expected the refusal to name what it refused, got {failure:?}"
        );
        assert!(
            requests.seen().is_empty(),
            "the refusal happens before anything reaches the network"
        );
    }

    /// The one host function an annotator keeps, and the only way it remembers
    /// anything between messages.
    #[test]
    fn it_can_still_store_data() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let mut plugin = load(
            root.path(),
            r#"
              ircx.annotate((message) => {
                const seen = ircx.store.get("seen") || 0;
                ircx.store.set("seen", String(Number(seen) + 1));
                return "seen " + ircx.store.get("seen");
              });
            "#,
            &in_channels(
                grants(&[Permission::AnnotateMessages, Permission::StoreLocalData]),
                &[TARGET],
            ),
        );

        let reply = plugin
            .annotate(&arrivals(&[("m1", "sable", "one"), ("m2", "nyx", "two")]))
            .expect("the batch is annotated");
        assert_eq!(
            reply
                .notes
                .iter()
                .map(|n| n.text.as_str())
                .collect::<Vec<_>>(),
            ["seen 1", "seen 2"]
        );
    }

    /// The handler is handed the message and answers with its own text. Nothing
    /// in the surface takes a message and returns a different one, which is the
    /// standing constraint holding as a type rather than as a convention.
    #[test]
    fn a_note_cannot_replace_what_somebody_said() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let mut plugin = load(
            root.path(),
            r#"
              ircx.annotate((message) => {
                message.text = "something else entirely";
                message.nick = "somebody else";
                return "note";
              });
            "#,
            &annotates(),
        );

        let batch = arrivals(&[("m1", "sable", "what was actually said")]);
        let reply = plugin.annotate(&batch).expect("the batch is annotated");

        assert_eq!(reply.notes[0].text, "note");
        assert_eq!(
            batch.messages[0].text, "what was actually said",
            "the handler was handed a copy across the boundary, not the message"
        );
    }

    #[test]
    fn a_note_is_stripped_of_control_characters_and_cut_to_length() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let mut plugin = load(
            root.path(),
            r#"ircx.annotate(() => "a\nbc" + "x".repeat(400));"#,
            &annotates(),
        );

        let reply = plugin
            .annotate(&arrivals(&[("m1", "sable", "anything")]))
            .expect("the batch is annotated");
        let note = &reply.notes[0].text;
        assert!(note.starts_with("abc"), "control characters go: {note:?}");
        assert_eq!(note.chars().count(), 200);
    }

    /// Hooks are synchronous, for the reason a command's are: a promise would
    /// be answered by the job queue rather than by anything the deadline can
    /// interrupt.
    #[test]
    fn a_promise_is_refused_rather_than_drawn() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let mut plugin = load(
            root.path(),
            r#"ircx.annotate(async () => "later");"#,
            &annotates(),
        );

        let failure = plugin
            .annotate(&arrivals(&[("m1", "sable", "anything")]))
            .expect_err("a promise is not an annotation");
        assert!(matches!(failure, Failure::Raised(_)), "got {failure:?}");
    }

    #[test]
    fn declaring_it_and_registering_nothing_is_the_plugins_fault_not_a_silent_pass() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let mut plugin = load(root.path(), "ircx.command('x', () => 'y');", &annotates());

        assert!(matches!(
            plugin.annotate(&arrivals(&[("m1", "sable", "anything")])),
            Err(Failure::Raised(_))
        ));
    }
}
