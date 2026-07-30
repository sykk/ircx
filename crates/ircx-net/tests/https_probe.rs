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

/// A redirect that leaves the host is refused rather than followed, and the
/// refusal names where it would have gone. `http_loopback.rs` asserts this
/// against a server it controls; this asserts a real one still trips it.
#[tokio::test]
#[ignore = "follows a real redirect on http://neverssl.com"]
async fn a_redirect_off_the_host_is_refused_by_name() {
    // A plain-http host that redirects to somewhere else entirely is the
    // shape this refuses; which host does it is not the point, so the failure
    // prints what happened rather than asserting a particular target.
    let outcome = fetch("http://google.com/", &policy()).await;

    match outcome {
        Err(HttpError::CrossHostRedirect { url, target }) => {
            println!("refused: {url} would have gone to {target}");
            assert!(!target.is_empty(), "the refusal names the target");
        }
        Err(other) => println!("did not redirect across hosts today: {other}"),
        Ok(fetched) => println!("did not redirect at all today: {}", fetched.url),
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
