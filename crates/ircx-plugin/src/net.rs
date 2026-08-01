//! `make external network requests`: the one host function that waits for
//! something outside the process.
//!
//! No socket is opened here. `ircx-net` is the only crate that opens an
//! outbound one, so the runtime is handed the ability as a [`Fetcher`] and
//! spends it inside the permission checks rather than owning a client of its
//! own.
//!
//! This is where the spike's "a QuickJS plugin can spin but cannot hang" stops
//! being a property of the mechanism: the interrupt handler cannot see a thread
//! waiting on a socket. What holds instead is a budget — the request is given
//! what is left of the call's deadline and no more — so a call still ends when
//! the limits said it would, as long as whoever supplies the fetcher honours
//! the budget. `docs/plugins.md` says what that costs.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

/// One request a plugin asked for, already checked against its grants.
#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub url: String,
    /// What is left of the plugin's call deadline. A fetcher that takes longer
    /// than this has taken the deadline away from the host.
    pub budget: Duration,
}

/// What the host sends back. `Display` on the error is shown to the plugin, so
/// it is a sentence rather than a code. No status field: the host's fetch
/// fails on anything but success, so a status could only ever say 200.
#[derive(Debug, Clone, Serialize)]
pub struct Fetched {
    pub body: String,
}

/// How the host makes a request for a plugin. Called on the plugin's own
/// thread, so it blocks rather than awaits.
pub type Fetcher = Arc<dyn Fn(FetchRequest) -> Result<Fetched, String> + Send + Sync>;

/// The fetcher for a host that does not make requests for plugins. Granting
/// `network-requests` against this still refuses, and says so plainly.
pub fn refuses() -> Fetcher {
    Arc::new(|_| Err("this client is not set up to fetch anything for a plugin".into()))
}

/// The host in an `http` or `https` URL, and nothing else: a plugin granted
/// `example.com` cannot reach a file or a socket by dressing it up as a URL.
pub(crate) fn host_of(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    // Credentials in the authority would let `granted.example@evil.test` read
    // as the granted host to anything matching loosely.
    if authority.contains('@') {
        return None;
    }
    let host = authority.split(':').next().unwrap_or_default();
    match host.is_empty() {
        true => None,
        false => Some(host.to_ascii_lowercase()),
    }
}
