//! What a long archive operation costs a live connection.
//!
//! `Store` is one `Connection` behind a `Mutex`, shared by every network's
//! archive writer thread and by every command the window can run — search,
//! export, delete. Since #410 the connection task hands its writes to the
//! writer rather than taking that mutex itself, so what this measures now is
//! what the handover left behind.
//!
//! So the question is not whether SQLite can do two things at once. It is
//! whether a `PING` is answered while somebody is exporting their archive. WAL
//! does not help: the contention is the Rust mutex, and one connection
//! serialises everything anyway.
//!
//! The measurement is the round trip of a `PING` the scripted server sends,
//! taken against a quiet archive and then while `export_everything` and
//! `delete_everything` run over a large one.
//!
//! **The quiet number is not zero and has nothing to do with the archive.**
//! `RateLimit::default()` is a bucket of five with a 500ms interval, and
//! registration spends the five, so a `PONG` waits one interval however idle
//! everything else is. It stays at 500ms whether the burst before it is 900
//! messages or 100, which is what says it is a timer rather than work. #410 was
//! filed claiming that floor was the connection task writing its own burst
//! inline; it was not, and the writer moving off the task left it exactly where
//! it was.
//!
//! **A stall that ends inside that interval does not show here at all**, because
//! the answer was not going out inside it regardless. That is enough to miss a
//! command outright: at `ARCHIVED` the release-profile export takes 265ms and
//! reads as free even before the writer existed, and at four times the archive
//! the same export costs the answer 0.68s. So this measures whether a command
//! delays a `PONG`, not how long it blocked the connection task.
//!
//! ```text
//! TMPDIR=/some/path/on/a/disk \
//!   cargo test --release -p ircx-core --test archive_lock -- --ignored --nocapture
//! ```
//!
//! Both of those matter to the numbers. `tempfile::tempdir` follows `TMPDIR`,
//! which is a tmpfs on most Linux, and a delete on a tmpfs is faster than one
//! on the disk a user's archive sits on. The debug profile takes 7.1× as long
//! over the export as the release profile does, and #410 and #411 were filed on
//! the debug one.
//!
//! It prints and asserts nothing about the timings, like `burst.rs`: a
//! measurement that fails the build on a slow machine is one nobody runs.
//! `docs/measurements.md` has both profiles, both filesystems, and what each
//! one is worth.

use std::sync::Arc;
use std::time::{Duration, Instant};

use ircx_core::{spawn_network, SessionConfig};
use ircx_ipc::{ChatMessage, Delivery, EncryptionState, MessageKind, MessageSource, Sender};
use ircx_store::Store;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};

const CHANNEL: &str = "#load";
/// Enough that an export takes long enough to see. A real archive of a year's
/// reading is larger than this.
const ARCHIVED: usize = 60_000;
/// Enough that the writer is still working through the burst when the export
/// takes the lock away from it.
const BURST: usize = 900;

fn config(port: u16) -> SessionConfig {
    SessionConfig {
        network: "scripted".into(),
        name: "scripted".into(),
        host: "127.0.0.1".into(),
        port,
        tls: false,
        tls_verify: false,
        client_certificate: None,
        nick: "reader".into(),
        alt_nicks: Vec::new(),
        username: "reader".into(),
        realname: "archive lock probe".into(),
        sasl: None,
        connect_commands: Vec::new(),
        autojoin: vec![CHANNEL.into()],
    }
}

fn archived(index: usize) -> ChatMessage {
    ChatMessage {
        id: format!("old-{index}"),
        network: "scripted".into(),
        target: CHANNEL.into(),
        kind: MessageKind::Privmsg,
        sender: Sender {
            nick: "talker".into(),
            user: None,
            host: None,
            account: None,
            is_self: false,
        },
        timestamp: format!("2026-01-01T00:00:{:02}Z", index % 60),
        timestamp_is_local: false,
        text: format!("something said a while ago, number {index}"),
        tags: Vec::new(),
        reply_to: None,
        batch: None,
        delivery: Delivery::Delivered,
        attachments: Vec::new(),
        encryption: EncryptionState::Plaintext,
        raw: String::new(),
        source: MessageSource::Live,
        via: None,
        id_is_local: false,
        reactions: Vec::new(),
        annotations: Vec::new(),
        raised_by: Vec::new(),
    }
}

/// The round trip of one `PING`, which is the number a server's timeout is set
/// against.
async fn ping_round_trip(
    listener: TcpListener,
    started: oneshot::Sender<()>,
    answered: oneshot::Sender<Duration>,
) {
    let (socket, _) = listener.accept().await.expect("the client connects");
    let (reader, mut writer) = socket.into_split();
    let mut lines = BufReader::new(reader).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.starts_with("USER") {
            writer
                .write_all(b":scripted 001 reader :Welcome\r\n")
                .await
                .expect("welcome");
        }
        if line.starts_with("JOIN") {
            writer
                .write_all(format!(":reader!r@h JOIN {CHANNEL}\r\n").as_bytes())
                .await
                .expect("join");
            break;
        }
    }

    // Enough messages to make the connection task take the archive lock.
    let mut burst = String::new();
    for i in 0..BURST {
        burst.push_str(&format!(":talker!t@h PRIVMSG {CHANNEL} :line {i}\r\n"));
    }
    let _ = started.send(());
    writer.write_all(burst.as_bytes()).await.expect("the burst");

    let sent = Instant::now();
    writer
        .write_all(b"PING :are-you-there\r\n")
        .await
        .expect("ping");
    while let Ok(Some(line)) = lines.next_line().await {
        if line.starts_with("PONG") {
            let _ = answered.send(sent.elapsed());
            break;
        }
    }
    tokio::time::sleep(Duration::from_secs(60)).await;
}

/// What the window can be doing to the archive while somebody is in a channel.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Meanwhile {
    Nothing,
    Exporting,
    /// The other button on the same sheet, and the slower one: a delete is a
    /// transaction and then a `VACUUM`, because the words have to leave the
    /// file rather than only the table.
    Deleting,
}

/// Runs the burst and the ping, optionally while something else holds the
/// archive, and answers with how long the `PONG` took.
async fn round_trip(store: Arc<Store>, meanwhile: Meanwhile) -> Duration {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let (started_tx, started_rx) = oneshot::channel();
    let (answered_tx, answered_rx) = oneshot::channel();
    tokio::spawn(ping_round_trip(listener, started_tx, answered_tx));

    let (tx, mut rx) = mpsc::channel(8192);
    let handle = spawn_network(config(port), Arc::clone(&store), tx);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    started_rx.await.expect("the burst starts");
    let busywork = (meanwhile != Meanwhile::Nothing).then(|| {
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            let began = Instant::now();
            match meanwhile {
                Meanwhile::Exporting => {
                    let mut out = std::io::sink();
                    store.export_everything(&mut out).expect("the export runs");
                }
                Meanwhile::Deleting => store.delete_everything().expect("the delete runs"),
                Meanwhile::Nothing => {}
            }
            began.elapsed()
        })
    });

    let took = answered_rx.await.expect("a pong");
    if let Some(busywork) = busywork {
        let spent = busywork.join().expect("the archive thread");
        println!("  the archive work itself took {spent:?}");
    }
    handle.shutdown(Some("probe done".into())).await;
    took
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "writes a large archive to a temp file and times a connection against it"]
async fn a_ping_answered_while_the_archive_is_being_exported() {
    let room = tempfile::tempdir().expect("a temp directory");
    let store = Arc::new(Store::open(&room.path().join("ircx.sqlite3")).expect("an archive"));

    let filling = Instant::now();
    for chunk in 0..(ARCHIVED / 1_000) {
        let messages: Vec<ChatMessage> = (0..1_000).map(|i| archived(chunk * 1_000 + i)).collect();
        store.append_messages(&messages).expect("fill the archive");
    }
    println!();
    println!(
        "  archived {ARCHIVED} messages in {:?}, {} on disk",
        filling.elapsed(),
        store.archive_size().expect("a size").bytes
    );

    let quiet = round_trip(Arc::clone(&store), Meanwhile::Nothing).await;
    println!("  pong with nothing else running   {quiet:?}");

    let exporting = round_trip(Arc::clone(&store), Meanwhile::Exporting).await;
    println!("  pong during an export            {exporting:?}");

    // Last, because it empties the archive the others were measured against.
    let deleting = round_trip(Arc::clone(&store), Meanwhile::Deleting).await;
    println!("  pong during a delete             {deleting:?}");

    println!();
    println!(
        "  an export cost the answer {:?}, a delete {:?}",
        exporting.saturating_sub(quiet),
        deleting.saturating_sub(quiet)
    );
}
