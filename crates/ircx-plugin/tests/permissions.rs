//! The seven permissions `ircclient.md` names, one section each.
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
use common::{author, call, grants, in_channels, on_hosts, Requests, TARGET};

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
