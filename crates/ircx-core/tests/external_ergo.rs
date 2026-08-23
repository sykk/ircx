//! SASL EXTERNAL against a server that checks the certificate, scripted.
//!
//! #401 built client certificates across three PRs, each verified on its own:
//! the transport presents one (`ircx-net/tests/client_certificate.rs`), the
//! config carries one, the form chooses one. None of that watched a server
//! decide. This does, and it is the first SASL mechanism whose *success* path a
//! test can re-run — PLAIN's and SCRAM's need a real account on a real network.
//!
//! What makes it possible is that a certfp server matches a fingerprint rather
//! than building a chain, so a self-signed certificate made in thirty seconds
//! is as good as one from an authority.
//!
//! ```text
//! # a server with a TLS listener, an account, and the fingerprint on it:
//! openssl req -x509 -newkey rsa:2048 -keyout client.key -out client.crt \
//!         -days 30 -nodes -subj "/CN=certwalk"
//! cat client.crt client.key > client.pem
//! openssl x509 -in client.crt -noout -fingerprint -sha256   # to NickServ
//! ergo mkcerts --conf ircd.yaml && ergo run --conf ircd.yaml &
//! /msg NickServ REGISTER correct-horse-battery              # as `certwalk`
//! /msg NickServ CERT ADD <fingerprint>
//!
//! IRCX_CLIENT_CERT=/path/to/client.pem \
//! IRCX_STRANGER_CERT=/path/to/stranger.pem \
//!   cargo test -p ircx-core --test external_ergo -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ircx_core::{spawn_network, SessionConfig};
use ircx_ipc::{ConnectionStatus, IrcxEvent, SaslMechanism, SaslStatus};
use ircx_store::Store;
use tokio::sync::mpsc;
use tokio::time::timeout;
use uuid::Uuid;

const HOST: &str = "127.0.0.1";
/// The TLS listener. EXTERNAL over plaintext is a contradiction — there is no
/// outer layer to take the credentials from — so this probe has no plain port.
const PORT: u16 = 6698;
const ACCOUNT: &str = "certwalk";

struct Walk {
    sasl: Option<SaslStatus>,
    connection: Option<ConnectionStatus>,
    numerics: Vec<String>,
}

/// Without this, a missing server is a timeout and then an assertion about a
/// numeric that never arrived, which reads like the client is broken.
fn require_ergo() {
    if std::net::TcpStream::connect((HOST, PORT)).is_err() {
        panic!(
            "nothing is listening on {HOST}:{PORT} — start ergo with a TLS listener \
             (see the notes at the top of this file)"
        );
    }
}

fn certificate(variable: &str) -> PathBuf {
    let path = std::env::var(variable)
        .unwrap_or_else(|_| panic!("set {variable} to a PEM holding a certificate and its key"));
    let path = PathBuf::from(path);
    assert!(
        path.exists(),
        "{variable} names {path:?}, which is not there"
    );
    path
}

async fn walk(nick: &str, certificate: Option<PathBuf>) -> Walk {
    require_ergo();
    let config = SessionConfig {
        network: Uuid::new_v4().to_string(),
        name: "ergo".into(),
        host: HOST.into(),
        port: PORT,
        tls: true,
        // The listener's certificate is the one `ergo mkcerts` made, which no
        // authority has heard of. What is under test is the other direction.
        tls_verify: false,
        client_certificate: certificate.map(|path| path.display().to_string()),
        nick: nick.into(),
        alt_nicks: Vec::new(),
        username: nick.into(),
        realname: "ircx external probe".into(),
        sasl: Some(ircx_core::SaslCredentials {
            mechanism: SaslMechanism::External,
            account: ACCOUNT.into(),
            password: None,
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
                if line.contains("AUTHENTICATE") {
                    println!("{} {line}", if *outgoing { ">>" } else { "<<" });
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

/// The whole point of #401: a certificate this client presented, matched by a
/// server to an account somebody registered it to.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a local ergo with a TLS listener and the certwalk account"]
async fn external_signs_in_with_a_registered_certificate() {
    let seen = walk("certwalk-ok", Some(certificate("IRCX_CLIENT_CERT"))).await;

    assert!(
        matches!(seen.sasl, Some(SaslStatus::Authenticated { .. })),
        "sasl: {:?}",
        seen.sasl
    );
    assert!(
        seen.numerics.contains(&"903".to_string()),
        "the server said the login worked: {:?}",
        seen.numerics
    );
    assert!(
        seen.numerics.contains(&"001".to_string()),
        "registration completed: {:?}",
        seen.numerics
    );
    assert!(
        matches!(seen.connection, Some(ConnectionStatus::Connected)),
        "connection: {:?}",
        seen.connection
    );
}

/// The control, and the reason the test above means anything: a certificate the
/// account service has never been told about is refused by the server rather
/// than waved through. Without it, a run that authenticated everything with a
/// certificate would look identical to one that checked.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a local ergo with a TLS listener and the certwalk account"]
async fn a_certificate_no_account_claims_is_refused() {
    let seen = walk("certwalk-no", Some(certificate("IRCX_STRANGER_CERT"))).await;

    assert!(
        matches!(seen.sasl, Some(SaslStatus::Failed { .. })),
        "sasl: {:?}",
        seen.sasl
    );
    assert!(
        seen.numerics.contains(&"904".to_string()),
        "the server refused it: {:?}",
        seen.numerics
    );
    assert!(
        !seen.numerics.contains(&"001".to_string()),
        "registration is abandoned rather than carried on as a stranger: {:?}",
        seen.numerics
    );
}

/// The client's own refusal, over TLS this time. `tests/session.rs` pins the
/// sentence against a scripted server; this is the same rule with a real one
/// listening, which is what says the check happens before anything is sent.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a local ergo with a TLS listener"]
async fn external_without_a_certificate_never_reaches_the_server() {
    let seen = walk("certwalk-none", None).await;

    assert!(
        matches!(seen.sasl, Some(SaslStatus::Failed { .. })),
        "sasl: {:?}",
        seen.sasl
    );
    assert!(
        seen.numerics.is_empty() || !seen.numerics.contains(&"904".to_string()),
        "the server was never asked, so it never refused: {:?}",
        seen.numerics
    );
}
