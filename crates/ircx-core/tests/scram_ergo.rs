//! The SCRAM walks in `docs/manual-verification.md`, scripted.
//!
//! That file's **SCRAM** section already records all of this, walked by hand:
//! SHA-256 against `ergo` on 2026-07-31, SHA-512 against Libera over TLS 1.3
//! and both failure paths on 2026-08-01, and a proxy that replaces the server's
//! `v=` with zeroes to see the client walk away. Nothing here is a discovery.
//!
//! What it is instead is repeatable. `src/scram.rs` is otherwise covered by the
//! RFC 7677 vectors and a scripted exchange in `tests/session.rs`, both of which
//! supply the server's half — a reused nonce, a salt decoded wrong or a proof
//! over the wrong bytes passes every one of them. So the only thing standing
//! between a change to that file and a wrong answer nobody notices is a manual
//! walk, and a manual walk is what gets skipped. Ergo advertises
//! `sasl=PLAIN,EXTERNAL,SCRAM-SHA-256` with `advertise-scram: true`, the
//! default, and registers an account with one line.
//!
//! ```text
//! ergo run --conf ircd.yaml &
//! # once, to create the account these tests log in as:
//! /msg NickServ REGISTER correct-horse-battery   # as nick `scramwalk`
//! cargo test -p ircx-core --test scram_ergo -- --ignored --nocapture
//! ```

use std::sync::Arc;
use std::time::Duration;

use ircx_core::{spawn_network, SessionConfig};
use ircx_ipc::{ConnectionStatus, IrcxEvent, SaslMechanism, SaslStatus};
use ircx_store::Store;
use tokio::sync::mpsc;
use tokio::time::timeout;
use uuid::Uuid;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 6667;
const ACCOUNT: &str = "scramwalk";
const PASSWORD: &str = "correct-horse-battery";

/// What the run saw, in the terms the assertions are written in.
struct Walk {
    sasl: Option<SaslStatus>,
    connection: Option<ConnectionStatus>,
    numerics: Vec<String>,
}

async fn walk(nick: &str, password: &str) -> Walk {
    walk_with(nick, password, SaslMechanism::ScramSha256).await
}

/// Without this, a missing server is a 30-second timeout and then an assertion
/// about a numeric that never arrived, which reads like the client is broken.
fn require_ergo() {
    if std::net::TcpStream::connect((HOST, PORT)).is_err() {
        panic!("nothing is listening on {HOST}:{PORT} — start ergo first (see the notes at the top of this file)");
    }
}

async fn walk_with(nick: &str, password: &str, mechanism: SaslMechanism) -> Walk {
    require_ergo();
    let network = Uuid::new_v4().to_string();
    let config = SessionConfig {
        network,
        name: "ergo".into(),
        host: HOST.into(),
        port: PORT,
        tls: false,
        tls_verify: false,
        client_certificate: None,
        nick: nick.into(),
        alt_nicks: Vec::new(),
        username: nick.into(),
        realname: "ircx scram probe".into(),
        sasl: Some(ircx_core::SaslCredentials {
            mechanism,
            account: ACCOUNT.into(),
            password: Some(password.into()),
        }),
        connect_commands: Vec::new(),
        autojoin: Vec::new(),
    };

    let store = Arc::new(Store::open_in_memory().expect("store"));
    let (tx, mut rx) = mpsc::channel(4096);
    let handle = spawn_network(config, store, tx);

    let mut walk = Walk {
        sasl: None,
        connection: None,
        numerics: Vec::new(),
    };
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    while let Ok(Some(event)) = timeout(deadline - tokio::time::Instant::now(), rx.recv()).await {
        match &event {
            IrcxEvent::RawLine { line, outgoing, .. } => {
                // The client's payloads carry the proof and the server's carry
                // the salt, so neither is printed whole.
                if line.contains("AUTHENTICATE") {
                    let dir = if *outgoing { ">>" } else { "<<" };
                    let head = line
                        .split_whitespace()
                        .take(2)
                        .collect::<Vec<_>>()
                        .join(" ");
                    println!("{dir} {head} <{}b>", line.len());
                }
                for numeric in [" 900 ", " 903 ", " 904 ", " 905 ", " 001 "] {
                    if line.contains(numeric) {
                        println!("<< {line}");
                        walk.numerics.push(numeric.trim().to_string());
                    }
                }
            }
            IrcxEvent::SaslChanged { status, .. } => {
                println!("   sasl:   {status:?}");
                walk.sasl = Some(status.clone());
            }
            IrcxEvent::ConnectionChanged { status, .. } => {
                println!("   status: {status:?}");
                walk.connection = Some(status.clone());
                // Nothing further to learn once it has settled either way.
                if matches!(
                    status,
                    ConnectionStatus::Connected | ConnectionStatus::Failed { .. }
                ) {
                    break;
                }
            }
            _ => {}
        }
    }

    handle.shutdown(Some("probe done".into())).await;
    walk
}

/// The whole four-message exchange, answered by a server that checks the proof.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a local ergo on 127.0.0.1:6667 with the scramwalk account"]
async fn scram_sha_256_signs_in_against_ergo() {
    let seen = walk("scramwalk-ok", PASSWORD).await;

    assert!(
        seen.numerics.iter().any(|n| n == "903"),
        "no 903 — the server did not accept the proof; saw {:?}",
        seen.numerics
    );
    assert!(
        seen.numerics.iter().any(|n| n == "001"),
        "authenticated but never registered; saw {:?}",
        seen.numerics
    );
    match seen.sasl {
        Some(SaslStatus::Authenticated { account, .. }) => assert_eq!(account, ACCOUNT),
        other => panic!("expected Authenticated, got {other:?}"),
    }
    assert!(
        matches!(seen.connection, Some(ConnectionStatus::Connected)),
        "expected Connected, got {:?}",
        seen.connection
    );
}

/// A wrong password fails at the proof rather than at the greeting, which is
/// the half of SCRAM a scripted exchange cannot check: the client computes
/// something, and the server is the one that says it is wrong.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a local ergo on 127.0.0.1:6667 with the scramwalk account"]
async fn a_wrong_password_is_refused_and_registration_is_abandoned() {
    let seen = walk("scramwalk-bad", "not-the-password").await;

    assert!(
        seen.numerics.iter().any(|n| n == "904"),
        "no 904 — probe inconclusive; saw {:?}",
        seen.numerics
    );
    assert!(
        !seen.numerics.iter().any(|n| n == "001"),
        "BUG: registration completed despite a rejected SASL"
    );
    assert!(
        matches!(seen.sasl, Some(SaslStatus::Failed { .. })),
        "expected Failed, got {:?}",
        seen.sasl
    );
}

/// A mechanism the server never offered, against a real advertisement rather
/// than a line a test wrote. Ergo lists `SCRAM-SHA-256` and not `-512`.
///
/// This connects, and the difference from the test above is the whole point.
/// A 904 means the server read the credentials and refused them, so carrying on
/// would put somebody in the channel as a stranger under a nick they may not
/// own — registration is abandoned. A mechanism that was never offered was
/// never tried, which is a capability shortfall, and those degrade to plain IRC
/// rather than becoming errors. What the user gets instead is the status bar
/// saying `not signed in` — which is `StatusBar.tsx`'s reason for existing in
/// that shape, after a mechanism a server never offered was read as a
/// successful login twice in one afternoon.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a local ergo on 127.0.0.1:6667"]
async fn a_mechanism_ergo_does_not_offer_degrades_rather_than_failing() {
    let seen = walk_with("scramwalk-512", PASSWORD, SaslMechanism::ScramSha512).await;

    match seen.sasl {
        Some(SaslStatus::Failed { message }) => assert!(
            message.contains("SCRAM-SHA-512"),
            "the message should name the mechanism: {message}"
        ),
        other => panic!("expected Failed, got {other:?}"),
    }
    assert!(
        !seen.numerics.iter().any(|n| n.starts_with("90")),
        "nothing should have been sent to be judged; saw {:?}",
        seen.numerics
    );
    assert!(
        matches!(seen.connection, Some(ConnectionStatus::Connected)),
        "a mechanism that was never offered should still connect, got {:?}",
        seen.connection
    );
}
