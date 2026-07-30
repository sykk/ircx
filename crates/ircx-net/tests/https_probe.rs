//! The preview fetch against real servers, because `http_loopback.rs` drives
//! everything else over plaintext: TLS there would need a certificate fixture,
//! so nothing in the suite has watched this code complete a handshake. It also
//! sets `alpn_protocols` where the IRC transport does not, and that is a
//! property of the connection rather than of the framing above it.
//!
//! Ignored by default, like `sasl_probe.rs`, and for the same reason: it opens
//! connections to somebody else's machines.
//!
//! cargo test -p ircx-net --test https_probe -- --ignored --nocapture

use std::time::Duration;

use ircx_net::http::{fetch, FetchPolicy, HttpError};

fn policy() -> FetchPolicy {
    FetchPolicy {
        max_bytes: 512 * 1024,
        timeout: Duration::from_secs(20),
        accept: "image/*, text/*;q=0.9, */*;q=0.5".into(),
        ..FetchPolicy::default()
    }
}

/// The handshake, the request and a body, over TLS to a host that is not ours.
///
/// `example.com` because it answers 200 without redirecting. A host that
/// redirects proves the handshake too — you cannot read a 301 without one —
/// but it stops before the body, and the body is half of what this is for.
#[tokio::test]
#[ignore = "fetches https://example.com over the real network"]
async fn a_fetch_completes_a_real_tls_handshake() {
    let fetched = fetch("https://example.com/", &policy())
        .await
        .expect("the handshake and the request both complete");

    println!(
        "fetched {} — {} bytes, content-type {:?}",
        fetched.url,
        fetched.body.len(),
        fetched.content_type
    );
    assert!(!fetched.body.is_empty(), "a body came back");
    assert!(fetched.url.starts_with("https://"), "{}", fetched.url);
}

/// The URL that found #106: `www.rust-lang.org` answers by redirecting to its
/// apex, which used to be refused as crossing hosts. It is the same site, and
/// this is the shape most of the web takes.
#[tokio::test]
#[ignore = "fetches https://www.rust-lang.org over the real network"]
async fn a_redirect_that_only_drops_www_is_followed() {
    let fetched = fetch("https://www.rust-lang.org/", &policy())
        .await
        .expect("www redirecting to the apex is the same site");

    println!("followed to {} — {} bytes", fetched.url, fetched.body.len());
    assert!(!fetched.body.is_empty());
}

/// Whatever a real server does today, the request must not end up on a site
/// the user did not choose.
///
/// The deterministic version of this lives in `http_loopback.rs`, against a
/// server the test controls. This one cannot make a stranger redirect on
/// demand, so it asserts the invariant rather than the path: if a cross-site
/// redirect happens it is refused, and if none happens the body came from the
/// site that was asked.
#[tokio::test]
#[ignore = "follows real redirects on http://google.com"]
async fn a_request_never_lands_on_a_site_that_was_not_asked_for() {
    let asked = "google.com";
    match fetch("http://google.com/", &policy()).await {
        Err(HttpError::CrossHostRedirect { url, target }) => {
            println!("refused: {url} would have gone to {target}");
        }
        Err(other) => println!("no cross-site redirect today: {other}"),
        Ok(fetched) => {
            let host = fetched
                .url
                .split("://")
                .nth(1)
                .and_then(|rest| rest.split('/').next())
                .unwrap_or_default()
                .trim_start_matches("www.")
                .to_owned();
            println!("answered from {host}");
            assert_eq!(
                host, asked,
                "the body came from {host}, which was not asked for"
            );
        }
    }
}

/// The size cap holds against a server that declares a large body, which is
/// what stops a link in a channel pulling down a film.
#[tokio::test]
#[ignore = "fetches a large object over the real network"]
async fn a_body_past_the_cap_is_refused_before_it_is_read() {
    let tight = FetchPolicy {
        max_bytes: 64,
        ..policy()
    };
    // The same host the test above reads whole, so a refusal here is the cap
    // and not a redirect, a local address or a host that would not answer.
    let outcome = fetch("https://example.com/", &tight).await;

    match outcome {
        Err(HttpError::TooLarge { .. }) => {
            println!("refused by the cap, which is what this asks")
        }
        Err(other) => panic!("refused, but not by the cap: {other}"),
        Ok(fetched) => panic!(
            "read {} bytes past a 64 byte cap from {}",
            fetched.body.len(),
            fetched.url
        ),
    }
}
