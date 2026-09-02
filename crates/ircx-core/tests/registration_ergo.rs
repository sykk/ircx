//! Account registration and message redaction against a real server.
//!
//! Both were added against a server this project wrote the other half of, which
//! proves nothing about either: `tests/session.rs` scripts what ergo is
//! supposed to say and then checks the client against that script. What it
//! cannot check is whether the script is right — whether a real service accepts
//! `REGISTER` as this client sends it, and whether the row this client blanks
//! is the one the server actually withdrew.
//!
//! `crates/ircx-core/tests/hexchat_dcc.rs` makes the same argument for DCC and
//! is the reason this file exists.
//!
//! Ignored by default so `cargo test --workspace` never dials anything. The
//! server, its two settings and the run are `scripts/registration-rig.sh`:
//!
//! ```text
//! scripts/registration-rig.sh test
//! ```
//!
//! Neither capability is on in a stock ergo, so a run against one started any
//! other way measures the client declining to do anything — which is a
//! different test, and one `tests/session.rs` already covers.
//!
//! ## What this does not reach
//!
//! `REGISTER VERIFICATION_REQUIRED` and the `/verify` that answers it. Ergo
//! sends the code by email, which needs an MTA the rig would have to stand up
//! and read mail out of. The capability's value here is `before-connect` alone
//! — no `email-required` — so the server takes a registration with `*` for an
//! address and answers `SUCCESS` directly. The verification path stays covered
//! by the scripted test and by `docs/manual-verification.md`.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ircx_core::{spawn_network, SessionCommand, SessionConfig};
use ircx_ipc::{HistoryRequest, IrcxEvent, SaslMechanism, SaslStatus, SearchRequest};
use ircx_store::Store;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use uuid::Uuid;

const HOST: &str = "127.0.0.1";
const CHANNEL: &str = "#regwalk";
const PASSWORD: &str = "correct-horse-battery-staple";
/// Said in the channel and then withdrawn. Distinctive enough that a search
/// finding it is finding this message and not the furniture around it.
const WITHDRAWN: &str = "quinoxal telemetry sequence";
/// Long enough for a loopback server, short enough that a server which is not
/// running fails the run rather than hanging it.
const PATIENCE: Duration = Duration::from_secs(15);

fn port() -> u16 {
    std::env::var("IRCX_REG_PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(6694)
}

/// Ergo keeps accounts in `ircd.db`, which outlives the server. A fixed name
/// would meet `ACCOUNT_EXISTS` on the second run and the probe would measure
/// the refusal rather than the registration, so each run brings its own — and
/// `registration-rig.sh reset` is there for when that is not enough.
fn fresh_nick() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or_default();
    format!("regwalk{}", seconds % 1_000_000)
}

/// Without this, a missing server is a long timeout and then an assertion about
/// an event that never arrived, which reads as though the client is broken.
fn require_ergo() {
    let port = port();
    if std::net::TcpStream::connect((HOST, port)).is_err() {
        panic!("nothing is listening on {HOST}:{port} — run scripts/registration-rig.sh up first");
    }
}

fn config(network: &str, nick: &str, account: Option<&str>) -> SessionConfig {
    SessionConfig {
        network: network.into(),
        name: "ergo".into(),
        host: HOST.into(),
        port: port(),
        tls: false,
        tls_verify: false,
        socks5_proxy: None,
        client_certificate: None,
        nick: nick.into(),
        alt_nicks: Vec::new(),
        username: nick.into(),
        realname: "ircx registration probe".into(),
        sasl: account.map(|account| ircx_core::SaslCredentials {
            mechanism: SaslMechanism::Plain,
            account: account.into(),
            password: Some(PASSWORD.into()),
        }),
        connect_commands: Vec::new(),
        autojoin: Vec::new(),
        quit_message: None,
        part_message: None,
        away_message: None,
    }
}

/// Every outgoing line the run has seen. `until` fills it as it goes, so an
/// assertion about what went out needs no second reader racing the first for
/// the same channel.
#[derive(Default)]
struct Sent(std::sync::Mutex<Vec<String>>);

impl Sent {
    fn carries(&self, needle: &str) -> Option<String> {
        let held = self.0.lock().expect("no panic holds this lock");
        held.iter().find(|line| line.contains(needle)).cloned()
    }
}

/// Reads events until `pick` matches, printing the lines that go past so a
/// failed run says what the server was doing at the time.
async fn until<T>(
    rx: &mut mpsc::Receiver<IrcxEvent>,
    sent: &Sent,
    mut pick: impl FnMut(&IrcxEvent) -> Option<T>,
) -> Option<T> {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return None;
        }
        let event = match timeout(left, rx.recv()).await {
            Ok(Some(event)) => event,
            _ => return None,
        };
        if let IrcxEvent::RawLine { line, outgoing, .. } = &event {
            let arrow = if *outgoing { ">>" } else { "<<" };
            println!("{arrow} {line}");
            if *outgoing {
                sent.0
                    .lock()
                    .expect("no panic holds this lock")
                    .push(line.clone());
            }
        }
        if let Some(found) = pick(&event) {
            return Some(found);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the server scripts/registration-rig.sh stands up"]
async fn an_account_is_registered_and_a_message_withdrawn() {
    require_ergo();
    let nick = fresh_nick();
    let sent = Sent::default();
    // Two connections, so two ids. The archive is read under the second, which
    // is the one that said the thing being withdrawn.
    let registering = Uuid::new_v4().to_string();
    let network = Uuid::new_v4().to_string();
    let room = tempfile::tempdir().expect("a temporary directory");
    let store = Arc::new(Store::open(&room.path().join("ircx.sqlite3")).expect("a store"));

    // ---- registering ----------------------------------------------------
    let (tx, mut rx) = mpsc::channel(4096);
    let handle = spawn_network(config(&registering, &nick, None), store.clone(), tx);
    let commands = handle.commands();

    until(&mut rx, &sent, |event| match event {
        IrcxEvent::ConnectionChanged { status, .. } => {
            matches!(status, ircx_ipc::ConnectionStatus::Connected).then_some(())
        }
        _ => None,
    })
    .await
    .expect("the server never finished registering the connection");

    let (reply, answer) = oneshot::channel();
    commands
        .send(SessionCommand::RegisterAccount {
            account: nick.clone(),
            password: PASSWORD.into(),
            // The capability here does not carry `email-required`, so this is
            // the `*` path — the one branch a scripted test cannot confirm a
            // real service accepts.
            email: String::new(),
            reply,
        })
        .await
        .expect("the session is listening");
    answer
        .await
        .expect("the session answered")
        .expect("the registration was refused before it went out");

    let answered = until(&mut rx, &sent, |event| match event {
        IrcxEvent::RawLine {
            line,
            outgoing: false,
            ..
        } if line.contains("REGISTER") => Some(line.clone()),
        _ => None,
    })
    .await
    .expect("the server never answered the REGISTER");
    assert!(
        answered.contains("SUCCESS"),
        "the server refused the registration: {answered}"
    );

    // The password is a positional argument, so this is the one place a real
    // exchange can show that `redact` holds on the way out.
    let logged = sent
        .carries("REGISTER")
        .expect("no REGISTER reached the raw log at all");
    assert_eq!(
        logged, "REGISTER <credentials>",
        "the raw log carried the registration's arguments"
    );

    handle.shutdown(Some("registered".into())).await;

    // ---- signing in with it ---------------------------------------------
    // The account existing is the only thing that proves the registration was
    // more than a line the server acknowledged and dropped.
    let (tx, mut rx) = mpsc::channel(4096);
    let handle = spawn_network(config(&network, &nick, Some(&nick)), store.clone(), tx);
    let commands = handle.commands();
    let writes = handle.writes();

    let status = until(&mut rx, &sent, |event| match event {
        IrcxEvent::SaslChanged { status, .. } => match status {
            SaslStatus::Authenticated { .. } | SaslStatus::Failed { .. } => Some(status.clone()),
            _ => None,
        },
        _ => None,
    })
    .await
    .expect("SASL never settled");
    match &status {
        SaslStatus::Authenticated { account, .. } => assert_eq!(account, &nick),
        other => panic!("the account this client just registered would not sign in: {other:?}"),
    }

    // ---- withdrawing a message ------------------------------------------
    commands
        .send(SessionCommand::Join {
            channel: CHANNEL.into(),
            key: None,
        })
        .await
        .expect("the session is listening");
    until(&mut rx, &sent, |event| match event {
        IrcxEvent::ChannelUpdated { channel } if channel.name == CHANNEL && channel.joined => {
            Some(())
        }
        _ => None,
    })
    .await
    .expect("never joined the channel");

    let (reply, _) = oneshot::channel();
    commands
        .send(SessionCommand::Submit {
            target: CHANNEL.into(),
            input: WITHDRAWN.into(),
            reply_to: None,
            reply,
        })
        .await
        .expect("the session is listening");

    // The server's own msgid, which is what `REDACT` names. A local id would
    // name nothing the server holds.
    // A message of this client's own keeps the local id the row was drawn
    // under, and the server's arrives beside it in the `msgid` tag when the
    // echo lands. `serverMsgid` in the store is the same two cases, and this is
    // the one `REDACT` has to name — the local id names nothing the server
    // holds.
    let msgid = until(&mut rx, &sent, |event| {
        let carries = |message: &ircx_ipc::ChatMessage| {
            if message.text != WITHDRAWN {
                return None;
            }
            if !message.id_is_local {
                return Some(message.id.clone());
            }
            message
                .tags
                .iter()
                .find(|(name, _)| name == "msgid")
                .and_then(|(_, value)| value.clone())
        };
        match event {
            IrcxEvent::MessagesAppended { messages, .. } => messages.iter().find_map(carries),
            IrcxEvent::MessageUpdated { message } => carries(message),
            _ => None,
        }
    })
    .await
    .expect("the message never came back with a server msgid");
    println!("   msgid: {msgid}");

    let (reply, _) = oneshot::channel();
    commands
        .send(SessionCommand::Submit {
            target: CHANNEL.into(),
            input: format!("/redact {msgid}"),
            reply_to: None,
            reply,
        })
        .await
        .expect("the session is listening");

    let withdrawn = until(&mut rx, &sent, |event| match event {
        IrcxEvent::MessageRedacted { message, by, .. } if message == &msgid => Some(by.clone()),
        _ => None,
    })
    .await;
    assert_eq!(
        withdrawn.as_deref(),
        Some(nick.as_str()),
        "the server did not relay the redaction back, or named somebody else"
    );

    // ---- and in the archive ---------------------------------------------
    // The event is the client's own reading of the line. This is the other
    // end: what a relaunch would find, through the writer's queue and SQLite.
    writes.drained().await;
    handle.shutdown(Some("probe done".into())).await;
    writes.drained().await;

    let held = store
        .load_history(&HistoryRequest {
            network: network.clone(),
            target: CHANNEL.into(),
            before: None,
            before_id: None,
            limit: 50,
        })
        .expect("the archive is readable");
    // Not by id: a message of this client's own is keyed in the archive by the
    // local id it was drawn under, and `msgid` above is the server's. What the
    // row is, rather than what it is called, is the thing being asserted
    // anyway.
    assert!(
        !held.iter().any(|message| message.text.contains("quinoxal")),
        "the archive still holds the words: {:?}",
        held.iter().map(|m| &m.text).collect::<Vec<_>>()
    );
    let withdrawn: Vec<_> = held
        .iter()
        .filter(|message| message.redacted_by.is_some())
        .collect();
    assert_eq!(
        withdrawn.len(),
        1,
        "expected exactly one withdrawn row, found {}",
        withdrawn.len()
    );
    assert_eq!(withdrawn[0].text, "", "the row kept its words");
    assert_eq!(
        withdrawn[0].redacted_by.as_deref(),
        Some(nick.as_str()),
        "the archive does not say who withdrew it"
    );

    let hits = store
        .search(&SearchRequest {
            query: "quinoxal".into(),
            network: None,
            target: None,
            sender: None,
            after: None,
            limit: 10,
        })
        .expect("the index is readable");
    assert!(
        hits.is_empty(),
        "a search still answers with the withdrawn message: {hits:?}"
    );

    println!("\nregistered {nick}, signed in as it, and withdrew {msgid}");
}
