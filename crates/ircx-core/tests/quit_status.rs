//! A session asked to stop says it stopped. #587.
//!
//! `/quit` left the window on `Connected`: the task returned
//! before `on_disconnected`, so nothing published the status the sidebar and
//! the status bar read, and only the composer — which asks the backend rather
//! than the store — knew the socket was gone.
//!
//! The server here is a listener that accepts, reads and **holds the socket
//! open**. That is the control rather than a convenience: a fake that hangs up
//! would produce a `Disconnected` from the transport dying, which is the path
//! that was never broken, and the test would pass against the defect.

use std::sync::Arc;
use std::time::Duration;

use ircx_core::{spawn_network, SessionCommand, SessionConfig};
use ircx_ipc::{ConnectionStatus, IrcxEvent};
use ircx_store::Store;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;

const PATIENCE: Duration = Duration::from_secs(5);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_session_asked_to_stop_says_it_stopped() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback port");
    let port = listener.local_addr().expect("the bound address").port();

    // Accepts, drains whatever the client writes, and keeps the connection for
    // as long as the test holds this task.
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("a client");
        let mut sink = [0_u8; 4096];
        while let Ok(read) = socket.read(&mut sink).await {
            if read == 0 {
                break;
            }
        }
    });

    let room = tempfile::tempdir().expect("a temporary directory");
    let store = Arc::new(Store::open(&room.path().join("ircx.sqlite3")).expect("an archive"));
    let (events, mut incoming) = mpsc::channel(256);
    let handle = spawn_network(config(port), store, events);

    // The socket is up before the ask, so what follows is about the ask.
    expect_status(&mut incoming, "connected", |status| {
        matches!(
            status,
            ConnectionStatus::Connected | ConnectionStatus::Registering
        )
    })
    .await;

    handle
        .commands()
        .send(SessionCommand::Disconnect { reason: None })
        .await
        .expect("the session takes commands");

    expect_status(&mut incoming, "disconnected", |status| {
        matches!(status, ConnectionStatus::Disconnected)
    })
    .await;

    server.abort();
}

/// The next `ConnectionChanged` that answers `wanted`, or a failure naming what
/// arrived instead. Statuses that are on the way — `Connecting` before
/// `Registering` — are passed over rather than failed on.
async fn expect_status(
    incoming: &mut mpsc::Receiver<IrcxEvent>,
    what: &str,
    wanted: impl Fn(&ConnectionStatus) -> bool,
) {
    let mut seen = Vec::new();
    let found = timeout(PATIENCE, async {
        while let Some(event) = incoming.recv().await {
            if let IrcxEvent::ConnectionChanged { status, .. } = event {
                if wanted(&status) {
                    return true;
                }
                seen.push(format!("{status:?}"));
            }
        }
        false
    })
    .await;

    assert!(
        matches!(found, Ok(true)),
        "no {what} status inside {PATIENCE:?}; the statuses that did arrive were {seen:?}"
    );
}

fn config(port: u16) -> SessionConfig {
    SessionConfig {
        network: "quit-status".into(),
        name: "the listener".into(),
        host: "127.0.0.1".into(),
        port,
        tls: false,
        tls_verify: false,
        socks5_proxy: None,
        client_certificate: None,
        nick: "quitter".into(),
        alt_nicks: Vec::new(),
        username: "quitter".into(),
        realname: "ircx #587".into(),
        sasl: None,
        connect_commands: Vec::new(),
        autojoin: Vec::new(),
        quit_message: None,
        part_message: None,
        away_message: None,
    }
}
