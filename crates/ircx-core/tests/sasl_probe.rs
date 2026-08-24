//! One connection to Libera with SASL PLAIN for an account that does not exist,
//! to settle whether a 904 abandons registration or leaves the user connected
//! and unauthenticated. A nonexistent account produces the same 904 a wrong
//! password does, so this needs nobody's credentials.
//!
//! cargo test -p ircx-core --test sasl_probe -- --ignored --nocapture

use std::sync::Arc;
use std::time::Duration;

use ircx_core::{spawn_network, SessionConfig};
use ircx_ipc::{IrcxEvent, SaslMechanism};
use ircx_store::Store;
use tokio::sync::mpsc;
use tokio::time::timeout;
use uuid::Uuid;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "opens a real connection to irc.libera.chat"]
async fn a_rejected_sasl_does_not_leave_us_connected() {
    let network = Uuid::new_v4().to_string();
    let nick = format!("ircx-p{:05}", std::process::id() % 100000);
    let config = SessionConfig {
        network: network.clone(),
        name: "Libera".into(),
        host: "irc.libera.chat".into(),
        port: 6697,
        tls: true,
        tls_verify: true,
        socks5_proxy: None,
        client_certificate: None,
        nick: nick.clone(),
        alt_nicks: Vec::new(),
        username: "ircxprobe".into(),
        realname: "ircx sasl probe".into(),
        sasl: Some(ircx_core::SaslCredentials {
            mechanism: SaslMechanism::Plain,
            // An account nobody has registered. Same 904 as a bad password.
            account: format!("ircx-no-such-{}", &network[..8]),
            password: Some("not-a-real-password".into()),
        }),
        connect_commands: Vec::new(),
        autojoin: Vec::new(),
    };

    let store = Arc::new(Store::open_in_memory().expect("store"));
    let (tx, mut rx) = mpsc::channel(4096);
    let handle = spawn_network(config, store, tx);

    let mut registered = false;
    let mut saw_904 = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    while let Ok(Some(event)) = timeout(deadline - tokio::time::Instant::now(), rx.recv()).await {
        match &event {
            IrcxEvent::RawLine { line, outgoing, .. } => {
                let dir = if *outgoing { ">>" } else { "<<" };
                if line.contains("AUTHENTICATE")
                    || line.contains(" 90")
                    || line.contains("CAP ")
                    || line.contains(" 001 ")
                {
                    let shown = if line.contains("AUTHENTICATE") && *outgoing && line.len() > 20 {
                        "AUTHENTICATE <redacted>".to_string()
                    } else {
                        line.clone()
                    };
                    println!("{dir} {shown}");
                }
                if line.contains(" 904 ") {
                    saw_904 = true;
                }
                if line.contains(" 001 ") {
                    registered = true;
                }
            }
            IrcxEvent::ConnectionChanged { status, .. } => println!("   status: {status:?}"),
            IrcxEvent::SaslChanged { status, .. } => println!("   sasl:   {status:?}"),
            _ => {}
        }
    }

    println!("\n=== saw 904: {saw_904} | reached 001 (registered): {registered} ===");
    handle.shutdown(Some("probe done".into())).await;
    assert!(saw_904, "server did not answer 904 — probe inconclusive");
    assert!(
        !registered,
        "BUG: registration completed despite a rejected SASL"
    );
}
