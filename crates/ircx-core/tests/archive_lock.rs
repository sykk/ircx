//! What a long archive operation costs a live connection.
//!
//! `Store`'s writer is one `Connection` behind a `Mutex`, shared by every
//! network's archive writer thread and by the delete the window can run. Since
//! #410 the connection task hands its writes to the writer rather than taking
//! that mutex itself, so what this measures is what the handover left behind.
//!
//! So the question is not whether SQLite can do two things at once. It is
//! whether a `PING` is answered while somebody is emptying their archive. WAL
//! did not help while there was one connection: the contention was the Rust
//! mutex, and one connection serialises everything regardless. Since #437 the
//! exports read on connections of their own, so the writer this probe contends
//! with is held by the delete and no longer by the export.
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
//! `a_search_typed_during_an_export` asks the other half, which the flood guard
//! hides here and which nothing had timed: what the same lock costs the person
//! at the keyboard. A search has no bucket in front of it, so a stall of any
//! size lands whole on whoever typed it.
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
use ircx_ipc::{
    ChatMessage, Delivery, EncryptionState, MessageKind, MessageSource, SearchRequest, Sender,
};
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

/// An archive with enough in it that reading all of it takes long enough to
/// measure something against.
fn fill(store: &Store) {
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

    fill(&store);

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

/// A term that appears in exactly one archived line, so what the clock shows is
/// the wait rather than the search. Every seeded line ends in its own index.
fn rare(index: usize) -> SearchRequest {
    SearchRequest {
        query: format!("{index}"),
        network: None,
        target: None,
        limit: 50,
    }
}

/// A term every archived line has, which is the other end of the range: FTS
/// matches all `ARCHIVED` of them and the `ORDER BY` sorts the lot before the
/// `LIMIT` takes 50.
fn common() -> SearchRequest {
    SearchRequest {
        query: "something".into(),
        network: None,
        target: None,
        limit: 50,
    }
}

/// The middle of three, so one slow run cannot carry the figure.
fn median(mut taken: Vec<Duration>) -> Duration {
    taken.sort();
    taken[taken.len() / 2]
}

fn timed(store: &Store, req: &SearchRequest) -> (Duration, usize) {
    let began = Instant::now();
    let hits = store.search(req).expect("the search runs");
    (began.elapsed(), hits.len())
}

/// What somebody who types a search while their archive is exporting waits for.
///
/// The probe above measures the same lock against a connection, where a 500ms
/// flood guard absorbs anything shorter than itself. Nothing absorbs this one:
/// `Store::search` takes the same mutex `export_everything` is holding, and it
/// cannot start until the export has walked every row and put the guard down.
///
/// So the number to read is not what the search costs. It is how much of the
/// export the search had left to wait out, which is why the export's own
/// duration and the moment the search was issued are both printed.
#[test]
#[ignore = "writes a large archive to a temp file and times a search against it"]
fn a_search_typed_during_an_export() {
    let room = tempfile::tempdir().expect("a temp directory");
    let store = Arc::new(Store::open(&room.path().join("ircx.sqlite3")).expect("an archive"));
    fill(&store);

    // What each search costs with nobody else holding the archive, which is what
    // the contended figures have to be read against.
    let (_, hits) = timed(&store, &rare(ARCHIVED - 1));
    let quiet_rare = median(
        (0..3)
            .map(|_| timed(&store, &rare(ARCHIVED - 1)).0)
            .collect(),
    );
    let (_, all) = timed(&store, &common());
    let quiet_common = median((0..3).map(|_| timed(&store, &common()).0).collect());
    println!("  a search nothing is competing with");
    println!("    one hit of {ARCHIVED}     {quiet_rare:?} ({hits} found)");
    println!("    a term every line has  {quiet_common:?} ({all} found, capped at 50)");

    // Long enough that the export has certainly taken the mutex, short enough
    // that it is still holding it. Both are checked below rather than assumed:
    // a run where the export finished first measures nothing and says so.
    const INTO: Duration = Duration::from_millis(50);

    let exporting = {
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            let began = Instant::now();
            store
                .export_everything(&mut std::io::sink())
                .expect("the export runs");
            began.elapsed()
        })
    };

    std::thread::sleep(INTO);
    let issued = Instant::now();
    let (waited, found) = timed(&store, &rare(ARCHIVED - 1));
    let worst_export = worst_until(&store, &exporting);
    let export = exporting.join().expect("the export thread");

    println!();
    println!("  the export took                {export:?}");
    println!("  a search issued {INTO:?} into it  {waited:?} ({found} found)");
    if issued.elapsed() < export {
        println!("    it was still exporting when the search was issued");
        println!(
            "    the search waited out {:?} of export and then cost {quiet_rare:?} of its own",
            waited.saturating_sub(quiet_rare)
        );
    } else {
        // `io::sink()` makes the export as fast as the machine can read the
        // archive, so a fast enough disk can finish inside INTO and leave
        // nothing to contend with.
        println!("    the export had already finished — this run measured nothing");
    }
    println!(
        "    worst of {} searches across the rest of it  {:?}",
        worst_export.0, worst_export.1
    );

    // Last, because it empties the archive everything above was measured
    // against. It is the other button on the same sheet and the slower one, so
    // it is the worst wait the sheet can hand somebody.
    let deleting = {
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            let began = Instant::now();
            store.delete_everything().expect("the delete runs");
            began.elapsed()
        })
    };

    std::thread::sleep(INTO);
    let (waited, _) = timed(&store, &rare(ARCHIVED - 1));
    let worst_delete = worst_until(&store, &deleting);
    let delete = deleting.join().expect("the delete thread");

    println!();
    println!("  the delete took                {delete:?}");
    println!("  a search issued {INTO:?} into it  {waited:?} (0 found, the archive is empty)");
    println!(
        "    worst of {} searches across the rest of it  {:?}",
        worst_delete.0, worst_delete.1
    );
}

/// The slowest search of as many as fit in what is left of the archive command,
/// and how many that was.
///
/// One search 50ms in answers what somebody typing at that moment waits for,
/// and it can only ever sample one moment. `delete_everything` is a `DELETE`
/// and then a `VACUUM`, and the two do not block a reader the same way: at
/// `ARCHIVED` the `DELETE` is 645ms and the `VACUUM` 80ms, so a search issued
/// 50ms in is nowhere near the part that takes SQLite's exclusive lock. This
/// keeps asking until the command is done, so the `VACUUM` is inside the window
/// rather than beyond it.
fn worst_until<T>(store: &Store, running: &std::thread::JoinHandle<T>) -> (usize, Duration) {
    let mut worst = Duration::ZERO;
    let mut asked = 0;
    while !running.is_finished() {
        let (took, _) = timed(store, &rare(ARCHIVED - 1));
        worst = worst.max(took);
        asked += 1;
    }
    (asked, worst)
}
