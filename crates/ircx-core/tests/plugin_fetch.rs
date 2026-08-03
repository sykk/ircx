//! `ircx.fetch` with a real socket under it.
//!
//! `crates/ircx-plugin/tests/permissions.rs` covers the grant, the host list and
//! the budget against a fetcher that answers without a network, and
//! `crates/ircx-net` covers the socket against its own loopback server. Nothing
//! ran the two together, which is what `docs/manual-verification.md` records as
//! the last gap in the plugin section: the seam is `network_for_plugins`, which
//! turns a plugin's request into a `FetchPolicy` and hands it to `ircx-net`.
//!
//! The seam carries one thing neither side can be asked about alone. A plugin's
//! policy is `FetchPolicy::default()` with the budget written over it, and that
//! default refuses loopback and private addresses — so a plugin granted
//! `network-requests` for `127.0.0.1` still cannot reach the machine it is
//! running on. That is a security property with nothing behind it but a struct
//! literal, and the test below is the first thing to hold it to a live socket.

use std::net::TcpListener;
use std::sync::Arc;

use ircx_core::{network_for_plugins, Grants, Permission, PluginLimits};
use ircx_plugin::{CommandRequest, Sandbox};

/// The plugin from `ircx-plugin`'s own fixtures, written out again rather than
/// reached across a crate boundary: this crate is above that one, and a test
/// that reads its neighbour's fixtures breaks when the neighbour tidies.
const FETCHER: &str = r#"
ircx.command("fetcher", (call) => {
  const response = ircx.fetch(call.args);
  return response.body;
});
"#;

fn granted(hosts: &[&str]) -> Grants {
    Grants {
        permissions: [
            Permission::AddCommands,
            Permission::RenderContent,
            Permission::NetworkRequests,
        ]
        .into_iter()
        .collect(),
        channels: Vec::new(),
        hosts: hosts.iter().map(|host| (*host).to_owned()).collect(),
    }
}

fn asking_for(url: &str) -> CommandRequest {
    CommandRequest {
        command: "fetcher".into(),
        args: url.into(),
        target: "#plugins".into(),
        nick: "sykk".into(),
        messages: Vec::new(),
    }
}

/// Runs the call the way the app does: on a thread of its own, because
/// `network_for_plugins` blocks on the runtime and a plugin's call arrives on a
/// thread that knows nothing about one.
async fn fetch_through_a_plugin(url: &str, hosts: &[&str]) -> Result<Option<String>, String> {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let data_file = directory.path().join("data.json");
    let grants = granted(hosts);
    let fetcher = network_for_plugins(tokio::runtime::Handle::current());
    let url = url.to_owned();

    tokio::task::spawn_blocking(move || {
        let mut sandbox = Sandbox::load(
            &grants,
            PluginLimits::default(),
            fetcher,
            FETCHER,
            data_file,
        )
        .expect("the plugin loads");
        sandbox
            .call(&asking_for(&url))
            .map(|reply| reply.content)
            .map_err(|failure| failure.to_string())
    })
    .await
    .expect("the plugin thread finishes")
}

/// The one this was written for. Something really is listening, the host is
/// granted by name, and it is still refused — the address is the reason rather
/// than the grant.
#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_cannot_reach_the_machine_it_runs_on() {
    // Bound rather than assumed: a refusal against a dead port would pass this
    // test for the wrong reason.
    let listener = TcpListener::bind("127.0.0.1:0").expect("a port to listen on");
    let port = listener.local_addr().expect("an address").port();
    let _accepting = std::thread::spawn(move || while listener.accept().is_ok() {});

    let answer = fetch_through_a_plugin(&format!("http://127.0.0.1:{port}/"), &["127.0.0.1"]).await;

    let refusal = answer.expect_err("a plugin must not reach loopback");
    assert!(
        refusal.contains("your own machine or local network"),
        "the refusal should say why, and it said: {refusal}"
    );
}

/// The same for a private address, which is the neighbour's printer rather than
/// this process. No socket is opened: the guard is on the address, so nothing
/// has to be listening for the answer to mean something.
#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_cannot_reach_the_network_the_user_is_on() {
    let answer = fetch_through_a_plugin("http://192.168.0.1/admin", &["192.168.0.1"]).await;

    let refusal = answer.expect_err("a plugin must not reach a private address");
    assert!(
        refusal.contains("your own machine or local network"),
        "the refusal should say why, and it said: {refusal}"
    );
}

/// A host the grant does not name is refused before any of that, which is
/// `ircx-plugin`'s half — repeated here only to show the two halves are in the
/// same order once the real fetcher is underneath.
#[tokio::test(flavor = "multi_thread")]
async fn a_host_outside_the_grant_never_reaches_the_socket() {
    let answer = fetch_through_a_plugin("http://127.0.0.1:9/", &["example.com"]).await;

    let refusal = answer.expect_err("a host outside the grant is refused");
    assert!(
        !refusal.contains("your own machine"),
        "the grant should refuse this before the address guard sees it: {refusal}"
    );
}

/// The success half, which needs somewhere real to fetch from. Ignored for the
/// reason `libera.rs` and `sasl_probe.rs` are: `cargo test --workspace` dials
/// nothing.
///
/// ```text
/// cargo test -p ircx-core --test plugin_fetch -- --ignored --nocapture
/// ```
#[tokio::test(flavor = "multi_thread")]
#[ignore = "opens a real connection to example.com"]
async fn a_granted_host_comes_back_through_the_sandbox() {
    let answer = fetch_through_a_plugin("https://example.com/", &["example.com"])
        .await
        .expect("example.com answers");

    let body = answer.expect("the plugin returns the body it was given");
    assert!(
        body.contains("Example Domain"),
        "the body should be the page's own, and it was {} bytes starting {:?}",
        body.len(),
        body.chars().take(60).collect::<String>()
    );
}

/* There is no test here for the budget against a slow socket, and the reason is
 * the guard above. A plugin's policy refuses every address a test could stand a
 * server on, so a server that accepts and then says nothing is refused before it
 * can say nothing — the elapsed time measures the guard rather than the
 * deadline. A first draft of this file asserted it anyway and passed in ten
 * milliseconds, which is the shape of a test that proves the opposite of what it
 * claims. What covers the budget instead is
 * `ircx-plugin/tests/permissions.rs`, against a fetcher it can make slow. */

/// Not a test of anything the app does, but of the fixture above: a fetcher
/// that answers instantly proves the plugin, the command and the reply path are
/// wired, so a refusal elsewhere is the guard rather than a broken fixture.
#[tokio::test(flavor = "multi_thread")]
async fn the_fixture_itself_carries_a_body_back() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let data_file = directory.path().join("data.json");
    let grants = granted(&["example.com"]);
    let fetcher = Arc::new(|_request| {
        Ok(ircx_plugin::Fetched {
            body: "it worked".into(),
        })
    });

    let content = tokio::task::spawn_blocking(move || {
        let mut sandbox = Sandbox::load(
            &grants,
            PluginLimits::default(),
            fetcher,
            FETCHER,
            data_file,
        )
        .expect("the plugin loads");
        sandbox
            .call(&asking_for("https://example.com/thing"))
            .expect("the fetch succeeds")
            .content
    })
    .await
    .expect("the plugin thread finishes");

    assert_eq!(content, Some("it worked".into()));
}
