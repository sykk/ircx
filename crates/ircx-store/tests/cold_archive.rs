//! What an export costs when the archive is not already in the page cache.
//!
//! Earlier export figures used a 56 MB archive seconds after seeding it, which
//! is the best case the machine can give and not the one a person opening the
//! app in the morning gets.
//!
//! So the same export is run twice a round: once against a file the kernel has
//! entirely in cache, and once with that cache taken off it. Nothing else
//! differs — same archive, same connection code, same rows.
//!
//! The destination is a counting sink rather than a file, so what separates the
//! two numbers is the read. An assembled-app export also includes writing the
//! destination and is not comparable; warm against cold here is.
//!
//! **The measurement only exists on a filesystem that has a page cache to
//! take off.** `tempfile::tempdir` follows `TMPDIR`, which is a tmpfs on most
//! Linux, and a tmpfs *is* the page cache — `POSIX_FADV_DONTNEED` does nothing
//! there and the cold run is a second warm one. The probe counts resident pages
//! either side of the eviction and says so rather than reporting the two as a
//! result.
//!
//! ```text
//! TMPDIR=/some/path/on/a/disk \
//!   cargo test --release -p ircx-store --test cold_archive -- --ignored --nocapture
//! ```
//!
//! Linux only: `posix_fadvise` and `mincore` are how the cache is dropped and
//! how the drop is checked. It prints and asserts nothing about the timings,
//! like `archive_lock.rs`: a measurement that fails the build on a slow machine
//! is one nobody runs. `docs/measurements.md` has the numbers and what they are
//! worth.

#![cfg(target_os = "linux")]

use std::io::{self, Write};
use std::time::{Duration, Instant};

use ircx_ipc::{ChatMessage, Delivery, EncryptionState, MessageKind, MessageSource, Sender};
use ircx_store::Store;

mod page_cache;

use page_cache::{evict_archive, eviction_failed, held, page_size};

/// Enough rounds that one run of a busy machine cannot carry either figure.
const ROUNDS: usize = 3;

/// How many messages to archive. The default is the profile
/// `docs/measurements.md` times startup against, so the figure lands beside
/// numbers taken over the same archive.
///
/// It is a knob because one size cannot answer the question. *"A year of real
/// channels"* is the case the gap names, and whether a cold archive costs a
/// fixed multiple or a worsening one only shows across sizes.
fn archived_count() -> usize {
    std::env::var("IRCX_ARCHIVED")
        .ok()
        .and_then(|said| said.parse().ok())
        .unwrap_or(100_000)
}

fn archived(index: usize) -> ChatMessage {
    ChatMessage {
        id: format!("old-{index}"),
        network: "scripted".into(),
        target: "#measure".into(),
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
        redacted_by: None,
    }
}

/// An archive with enough in it that reading all of it has to touch the disk
/// rather than a corner of it the kernel would keep anyway.
fn fill(store: &Store, count: usize) {
    let filling = Instant::now();
    for chunk in 0..(count / 1_000) {
        let messages: Vec<ChatMessage> = (0..1_000).map(|i| archived(chunk * 1_000 + i)).collect();
        store.append_messages(&messages).expect("fill the archive");
    }
    println!(
        "  archived {count} messages in {:?}, {} bytes on disk",
        filling.elapsed(),
        store.archive_size().expect("a size").bytes
    );
}

/// `io::sink()` that remembers how much went into it.
///
/// Where the export goes is not what this is about, and a real destination
/// would put the write back into a number meant to be about the read. The count
/// is only what turns a duration into a rate.
#[derive(Default)]
struct Counting(u64);

impl Write for Counting {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn export(store: &Store) -> (Duration, u64) {
    let mut out = Counting::default();
    let began = Instant::now();
    store.export_everything(&mut out).expect("the export runs");
    (began.elapsed(), out.0)
}

/// The middle of the rounds, so one run of a busy machine cannot carry a figure.
fn median(mut taken: Vec<Duration>) -> Duration {
    taken.sort();
    taken[taken.len() / 2]
}

/// Decimal megabytes, which is what every other rate in `docs/measurements.md`
/// is in. Sizes there are in `MiB` and rates in `MB/s`; mixing the two units
/// under one name is how a figure stops being comparable to the one above it.
fn megabytes_a_second(bytes: u64, took: Duration) -> f64 {
    bytes as f64 / took.as_secs_f64() / 1_000_000.0
}

/// What the same export costs against a cached archive and against a cold one.
#[test]
#[ignore = "writes a large archive to a temp file and reads it back with the page cache dropped"]
fn an_export_of_an_archive_nobody_has_read_yet() {
    let room = tempfile::tempdir().expect("a temp directory");
    let archive = room.path().join("ircx.sqlite3");
    let store = Store::open(&archive).expect("an archive");
    println!();
    fill(&store, archived_count());

    let mut warm = Vec::new();
    let mut cold = Vec::new();
    let mut written = 0;
    let mut working_set = 0;
    let mut evicted_to = (0, 0);

    for round in 1..=ROUNDS {
        // Warm first, which both takes the reading and leaves in cache exactly
        // the pages the export reads — which is what the eviction below then
        // takes off, and is less than the archive.
        let (took, bytes) = export(&store);
        warm.push(took);
        written = bytes;
        let before = held(&archive);
        working_set = before.0;

        evict_archive(&archive);
        evicted_to = held(&archive);

        let (took, _) = export(&store);
        cold.push(took);

        println!(
            "  round {round}: warm {:?}, {} of {} pages held dropped to {} — cold {took:?}",
            warm[round - 1],
            before.0,
            before.1,
            evicted_to.0,
        );
    }

    println!();
    if eviction_failed(evicted_to) {
        println!(
            "  the eviction left {} of {} pages resident — this run measured nothing.",
            evicted_to.0, evicted_to.1
        );
        println!("  TMPDIR is a tmpfs, which is the page cache and cannot be taken off it.");
        return;
    }

    // What one export leaves resident, taken from the last round. Round 1's
    // figure is the whole archive instead, because the fill had just written
    // all of it; every round after is the export's own working set, which is
    // smaller than the file because the scan never reads the full-text indexes.
    let faulted = working_set * page_size();
    let (warm, cold) = (median(warm), median(cold));
    println!("  {written} bytes exported, medians of {ROUNDS}");
    println!(
        "    warm  {warm:?}  ({:.0} MB/s of output)",
        megabytes_a_second(written, warm)
    );
    println!(
        "    cold  {cold:?}  ({:.0} MB/s of output)",
        megabytes_a_second(written, cold)
    );
    println!(
        "  a cold archive costs the export {:?}, which is {:.2}x",
        cold.saturating_sub(warm),
        cold.as_secs_f64() / warm.as_secs_f64()
    );
    println!(
        "  it faulted in {working_set} pages, {:.1} MiB, at {:.0} MB/s of the difference",
        faulted as f64 / 1_048_576.0,
        megabytes_a_second(faulted as u64, cold.saturating_sub(warm)),
    );
}
