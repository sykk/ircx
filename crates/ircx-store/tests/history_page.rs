//! What a page of history costs to read.
//!
//! `docs/end-to-end-run-17.md` argued that the archive read is what a loaded
//! machine stretches, and named the shape of it: `load_history` reads the page
//! and then fills it in with `attach_reactions`, `attach_annotations` and
//! `attach_raised`, "each of those runs **one statement per message** — six
//! hundred executions behind a Tauri command". That was the mechanism behind a
//! race the run spent eighty walks on, and nothing has ever timed it.
//!
//! `docs/measurements.md` had no figure for a history page at all. This is
//! that figure, and the arms are what separate the two costs it turned out to
//! be:
//!
//! - **At the head**, where nothing has to be skipped to reach the page, a full
//!   page against a twentieth of one says how much of it follows the page's
//!   size. That is #526, the three passes that fill a page in — they ran per
//!   message, so they cost the same whether or not anything hangs off it, and
//!   the newest page is the arm where they have rows to return.
//! - **Down the archive**, where the page is the same size and the only thing
//!   changing is how far back the reader has paged. That is #527: ten rows deep
//!   in a conversation cost more than two hundred at its head, because the
//!   page-back filter could not be served by the index and every page walked
//!   the whole distance again. Both filters' plans are printed rather than
//!   argued, so the arm says why it costs what it does and not only what.
//!
//! Both of those were taken on an idle machine over a file the kernel held
//! entirely, which is the best case and neither of the two the argument was
//! about. Two more arms are what the first figure's *Not measured* named:
//!
//! - **Under load**, because that is what run 17 claimed the read was
//!   sensitive to. Its walks contended for CPU and nothing else — the profile
//!   is on tmpfs and the server is a local socket — so the arm leaves twice the
//!   cores spinning and reads the same pages again.
//! - **Off a cold archive**, because every figure here was taken seconds after
//!   the fill wrote the file. `page_cache` takes the cache off it between
//!   rounds, the same way `cold_archive.rs` does for the export, and the page
//!   is read through a connection opened after the drop so that SQLite's own
//!   cache is not what answers.
//!
//! ```text
//! cargo test --release -p ircx-store --test history_page -- --ignored --nocapture
//!
//! TMPDIR=/some/path/on/a/disk \
//!   cargo test --release -p ircx-store --test history_page -- --ignored --nocapture cold
//! ```
//!
//! The cold arm needs that `TMPDIR`: a tmpfs *is* the page cache and cannot be
//! taken off it, and the arm says so rather than reporting two warm numbers.
//!
//! The *before* columns in `docs/measurements.md` are this probe against the
//! commit before #526, which is how a build that has neither fix is read on the
//! same machine in the same sitting:
//!
//! ```text
//! git checkout 2dd01c4 -- crates/ircx-store/src/lib.rs crates/ircx-store/src/message.rs
//! # build, run the arms above, then
//! git checkout HEAD -- crates/ircx-store/src/lib.rs crates/ircx-store/src/message.rs
//! ```
//!
//! Its quiet figures are what say the control is the build it claims to be:
//! they land on the ones the *before* column was first taken with, to three
//! digits.
//!
//! It prints and asserts nothing about the timings, like `cold_archive.rs`: a
//! measurement that fails the build on a busy machine is one nobody runs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{available_parallelism, JoinHandle};
use std::time::{Duration, Instant};

use ircx_ipc::{
    ChatMessage, Delivery, EncryptionState, HistoryRequest, MessageKind, MessageSource, Sender,
};
use ircx_store::Store;

mod page_cache;

use page_cache::{evict_archive, eviction_failed, held, page_size};

/// Enough rounds that one run of a busy machine cannot carry a figure.
const ROUNDS: usize = 9;

const NETWORK: &str = "scripted";
const TARGET: &str = "#measure";

/// What the frontend asks for. `Timeline.tsx` pages back in 200s, so this is
/// the size every figure here is really about; the smaller arm exists only to
/// say whether the cost follows it.
const PAGE: u32 = 200;

/// One message in twenty on the newest page carries a reaction, a note and a
/// raised row. A real channel is nearer none than that — the arm is here to
/// bound what the rows cost, not to be typical.
const FURNISHED_EVERY: usize = 20;

/// How many messages to archive. The default is the profile `measurements.md`
/// times startup and search against, so this figure lands beside numbers taken
/// over the same archive.
fn archived_count() -> usize {
    std::env::var("IRCX_ARCHIVED")
        .ok()
        .and_then(|said| said.parse().ok())
        .unwrap_or(100_000)
}

/// Fixed-width and ordered, which is what the `timestamp < ?` in `load_history`
/// compares. One second apart, so the archive spans a day per 86,400 messages.
fn stamp(index: usize) -> String {
    let day = 1 + index / 86_400;
    let rest = index % 86_400;
    format!(
        "2026-01-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60
    )
}

fn archived(index: usize) -> ChatMessage {
    ChatMessage {
        id: format!("old-{index}"),
        network: NETWORK.into(),
        target: TARGET.into(),
        kind: MessageKind::Privmsg,
        sender: Sender {
            nick: "talker".into(),
            user: None,
            host: None,
            account: None,
            is_self: false,
        },
        timestamp: stamp(index),
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

fn fill(store: &Store, count: usize) {
    let filling = Instant::now();
    for chunk in 0..count.div_ceil(1_000) {
        let messages: Vec<ChatMessage> = (0..1_000)
            .map(|i| chunk * 1_000 + i)
            .take_while(|index| *index < count)
            .map(archived)
            .collect();
        store.append_messages(&messages).expect("fill the archive");
    }
    println!(
        "  archived {count} messages in {:?}, {} bytes on disk",
        filling.elapsed(),
        store.archive_size().expect("a size").bytes
    );
}

/// Reactions, notes and raised rows over the newest page, so one arm of the
/// measurement has something for the three passes to return.
fn furnish(store: &Store, count: usize) {
    let newest = count.saturating_sub(PAGE as usize);
    for index in (newest..count).step_by(FURNISHED_EVERY) {
        let msgid = format!("old-{index}");
        store
            .set_reaction(NETWORK, &msgid, "reader", "👍", true)
            .expect("a reaction");
        store
            .set_reaction(NETWORK, &msgid, "another", "👍", true)
            .expect("a second reaction");
        store
            .set_annotation(NETWORK, &msgid, "notes", "something a plugin said")
            .expect("a note");
        store
            .set_raised(NETWORK, &msgid, "rules")
            .expect("a raised row");
    }
}

fn page(store: &Store, before: Option<String>, limit: u32) -> (Duration, usize) {
    let req = HistoryRequest {
        network: NETWORK.into(),
        target: TARGET.into(),
        before,
        limit,
    };
    let began = Instant::now();
    let read = store.load_history(&req).expect("a page of history");
    (began.elapsed(), read.len())
}

/// The middle of the rounds, so one run of a busy machine cannot carry a figure.
fn median(mut taken: Vec<Duration>) -> Duration {
    taken.sort();
    taken[taken.len() / 2]
}

fn timed(store: &Store, what: &str, before: Option<String>, limit: u32) {
    // One call before the rounds: the first page a connection reads prepares
    // statements the rest reuse, and that is a launch cost rather than a page's.
    let (_, rows) = page(store, before.clone(), limit);
    let taken: Vec<Duration> = (0..ROUNDS)
        .map(|_| page(store, before.clone(), limit).0)
        .collect();
    let middle = median(taken.clone());
    let low = taken.iter().min().expect("a round");
    let high = taken.iter().max().expect("a round");
    println!(
        "  {what:<34} {rows:>4} rows  median {:>7.3} ms   ({:.3}–{:.3})",
        middle.as_secs_f64() * 1_000.0,
        low.as_secs_f64() * 1_000.0,
        high.as_secs_f64() * 1_000.0,
    );
}

fn cores() -> usize {
    available_parallelism()
        .map(|cores| cores.get())
        .unwrap_or(1)
}

/// How many threads to leave spinning for the loaded arm.
///
/// Twice the cores, which is what the walks behind run 17's argument ran under:
/// enough that every reader waits for a core rather than finding one free, and
/// not so many that the machine is only measuring its own scheduler.
fn spinners() -> usize {
    std::env::var("IRCX_SPINNERS")
        .ok()
        .and_then(|said| said.parse().ok())
        .unwrap_or_else(|| cores() * 2)
}

/// Threads that do nothing but hold a core, until this is dropped.
struct Contention {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Contention {
    fn of(count: usize) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let threads = (0..count)
            .map(|_| {
                let stop = Arc::clone(&stop);
                std::thread::spawn(move || {
                    let mut burning = 0u64;
                    while !stop.load(Ordering::Relaxed) {
                        // Arithmetic the optimiser is not allowed to fold away,
                        // and nothing the archive's pages or locks can see.
                        burning = std::hint::black_box(
                            burning
                                .wrapping_mul(6_364_136_223_846_793_005)
                                .wrapping_add(1),
                        );
                    }
                })
            })
            .collect();
        Self { stop, threads }
    }
}

impl Drop for Contention {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for thread in self.threads.drain(..) {
            thread.join().expect("a spinner stops");
        }
    }
}

/// Every arm of the reading, so that a pass under load reads the same pages in
/// the same order as the quiet one it is set against.
fn arms(store: &Store, count: usize) {
    // At the head, where the three passes have rows to return and where the
    // pair of limits says whether what a page costs follows its size.
    timed(store, "newest page, with rows", None, PAGE);
    timed(store, "a twentieth of it, with rows", None, PAGE / 20);

    // And down the archive, where nothing carries a row and the only thing
    // changing is how far back the reader has paged.
    for depth in [1_000, 10_000, 50_000, 90_000] {
        if depth >= count {
            continue;
        }
        let before = Some(stamp(count - depth));
        timed(
            store,
            &format!("{depth} back, no rows"),
            before.clone(),
            PAGE,
        );
        if depth == 50_000 {
            timed(store, "  a twentieth of it, no rows", before, PAGE / 20);
        }
    }
}

/// What SQLite says it will do with the page-back, which is where a cost that
/// follows the depth rather than the page size has to be read.
///
/// `m.*` stands in for the column list `load_history` selects, which is
/// `message::COLUMNS` and not reachable from a test. What matters is that it
/// is more than the timeline index holds, so the plan is the one the client
/// gets rather than a covering read the column list rules out.
fn plan(archive: &std::path::Path, filter: &str) {
    let conn = rusqlite::Connection::open(archive).expect("the archive opens for reading");
    let sql = format!(
        "SELECT m.* FROM messages m
         WHERE m.network = ?1 AND m.target = ?2 COLLATE NOCASE
           AND {filter}
         ORDER BY m.timestamp DESC, m.id DESC
         LIMIT ?4"
    );
    let mut stmt = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .expect("a plan");
    let rows = stmt
        .query_map(rusqlite::params![NETWORK, TARGET, stamp(0), PAGE], |row| {
            row.get::<_, String>(3)
        })
        .expect("the plan reads");
    println!("  for {filter}");
    for step in rows {
        println!("    {}", step.expect("a step"));
    }
    println!();
}

#[test]
#[ignore = "writes a large archive to a temp file and reads pages back off it"]
fn what_a_page_of_history_costs() {
    let count = archived_count();
    let home = tempfile::tempdir().expect("a directory to archive into");
    let archive = home.path().join("ircx.sqlite3");
    let store = Store::open_without_keyring(&archive).expect("the archive opens");

    fill(&store, count);
    furnish(&store, count);
    println!(
        "  reactions, notes and raised rows on every {FURNISHED_EVERY}th of the newest {PAGE}\n"
    );
    plan(&archive, "(?3 IS NULL OR m.timestamp < ?3)");
    plan(&archive, "m.timestamp < ?3");

    println!("  on a quiet machine:");
    arms(&store, count);

    let spinning = spinners();
    println!("\n  under {spinning} spinners on {} cores:", cores());
    let contention = Contention::of(spinning);
    arms(&store, count);
    drop(contention);
}

/// The same pages, read off an archive the kernel is holding none of.
///
/// A round drops the cache and then opens the store again, because the
/// connection that read the last round has SQLite's own page cache behind it
/// and would answer from there. The open is not timed; it faults in the header
/// and the schema, which is what the client's own launch pays for and not what
/// a page costs. What each round counts instead is the pages the read itself
/// brings in.
///
/// Warm is taken in the same round, through a connection opened the same way
/// over the pages the cold read just faulted in, so the pair differs by the
/// cache and by nothing else.
#[test]
#[ignore = "writes a large archive to a temp file and reads pages off it with the page cache dropped"]
fn what_a_page_of_history_costs_off_a_cold_archive() {
    let count = archived_count();
    let home = tempfile::tempdir().expect("a directory to archive into");
    let archive = home.path().join("ircx.sqlite3");
    {
        let store = Store::open_without_keyring(&archive).expect("the archive opens");
        fill(&store, count);
        furnish(&store, count);
        println!(
            "  reactions, notes and raised rows on every {FURNISHED_EVERY}th of the newest {PAGE}"
        );
    }

    evict_archive(&archive);
    let after = held(&archive);
    if eviction_failed(after) {
        println!(
            "\n  the eviction left {} of {} pages resident — this run measured nothing.",
            after.0, after.1
        );
        println!("  TMPDIR is a tmpfs, which is the page cache and cannot be taken off it.");
        return;
    }
    println!(
        "  the archive is {} pages, of which the eviction left {}\n",
        after.1, after.0
    );

    let mut reading = vec![("newest page, with rows".to_string(), None)];
    for depth in [10_000, 50_000] {
        if depth < count {
            reading.push((format!("{depth} back, no rows"), Some(stamp(count - depth))));
        }
    }

    for (what, before) in reading {
        let mut cold = Vec::new();
        let mut warm = Vec::new();
        let mut faulted = Vec::new();
        let mut rows = 0;

        for _ in 0..ROUNDS {
            evict_archive(&archive);
            let store = Store::open_without_keyring(&archive).expect("the archive opens");
            let opened = held(&archive).0;
            let (took, read) = page(&store, before.clone(), PAGE);
            faulted.push(held(&archive).0.saturating_sub(opened));
            cold.push(took);
            rows = read;
            drop(store);

            let store = Store::open_without_keyring(&archive).expect("the archive opens");
            warm.push(page(&store, before.clone(), PAGE).0);
        }

        faulted.sort();
        let pages = faulted[faulted.len() / 2];
        let spread = |taken: &[Duration]| {
            let low = taken.iter().min().expect("a round").as_secs_f64() * 1_000.0;
            let high = taken.iter().max().expect("a round").as_secs_f64() * 1_000.0;
            format!("({low:.3}–{high:.3})")
        };
        let (spreads, warms) = (spread(&cold), spread(&warm));
        let (cold, warm) = (median(cold), median(warm));
        println!(
            "  {what:<24} {rows:>4} rows  cold {:>6.3} ms {spreads:<17} \
             warm {:>6.3} ms {warms:<17} {:>4.1}x, faulting {pages} pages ({} KiB)",
            cold.as_secs_f64() * 1_000.0,
            warm.as_secs_f64() * 1_000.0,
            cold.as_secs_f64() / warm.as_secs_f64(),
            pages * page_size() / 1_024,
        );
    }
}
