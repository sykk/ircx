//! What an export costs when the archive is not already in the page cache.
//!
//! `docs/end-to-end-run-11.md` walked `Export everything` over 100,021 messages
//! and 56 MB and got 0.5–0.6 s, and listed what it had not reached: *"An
//! archive that does not fit in the page cache. 56 MB is read back at 96 MB/s
//! from a file the machine had just written. A year of real channels is the
//! same code path against a colder file."* Every figure this project has for
//! the export was taken seconds after seeding it, which is the best case the
//! machine can give and not the one a person opening the app in the morning
//! gets.
//!
//! So the same export is run twice a round: once against a file the kernel has
//! entirely in cache, and once with that cache taken off it. Nothing else
//! differs — same archive, same connection code, same rows.
//!
//! The destination is a counting sink rather than a file, so what separates the
//! two numbers is the read. Run 11's 563 ms includes writing 54 MB to btrfs and
//! is not comparable to either; what is comparable is warm against cold here.
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

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ircx_ipc::{ChatMessage, Delivery, EncryptionState, MessageKind, MessageSource, Sender};
use ircx_store::Store;

/// Enough rounds that one run of a busy machine cannot carry either figure.
const ROUNDS: usize = 3;

/// How many messages to archive. The default is the profile run 11 walked and
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

fn page_size() -> usize {
    // SAFETY: `sysconf` takes a constant and answers with a long.
    unsafe { libc::sysconf(libc::_SC_PAGESIZE) as usize }
}

/// How many of `path`'s pages the kernel is holding, and how many it has.
///
/// `mincore` over a read-only mapping, which is what `fincore(1)` does. The
/// mapping is the cheapest way to ask; it reads none of the file and so warms
/// nothing by asking.
fn resident(path: &Path) -> io::Result<(usize, usize)> {
    let file = File::open(path)?;
    let len = file.metadata()?.len() as usize;
    if len == 0 {
        return Ok((0, 0));
    }
    let pages = len.div_ceil(page_size());
    // SAFETY: the mapping is `len` bytes of a file open for reading, `mincore`
    // is given a vector of exactly one byte per page of it, and both the
    // mapping and the file are gone before this returns.
    unsafe {
        let base = libc::mmap(
            std::ptr::null_mut(),
            len,
            libc::PROT_READ,
            libc::MAP_SHARED,
            file.as_raw_fd(),
            0,
        );
        if base == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        let mut held = vec![0u8; pages];
        let asked = libc::mincore(base, len, held.as_mut_ptr());
        libc::munmap(base, len);
        if asked != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((held.iter().filter(|page| *page & 1 == 1).count(), pages))
    }
}

/// Takes `path` out of the page cache.
///
/// `POSIX_FADV_DONTNEED` drops clean pages and leaves dirty ones, and the store
/// runs `synchronous = NORMAL`, which does not fsync the database on a commit.
/// So the file is synced first — otherwise what stays behind is exactly the
/// part the fill has most recently written.
fn evict(path: &Path) -> io::Result<()> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    file.sync_all()?;
    // SAFETY: an open file descriptor, and a length of 0 meaning to the end.
    // `posix_fadvise` answers with the errno rather than setting it.
    let said = unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    match said {
        0 => Ok(()),
        errno => Err(io::Error::from_raw_os_error(errno)),
    }
}

/// The database and the write-ahead log beside it. The `-shm` is left alone: it
/// is mapped by the connections the store still has open, which is a reason the
/// kernel will not drop it and not a page anybody reads from disk.
fn archive_files(archive: &Path) -> Vec<PathBuf> {
    let wal = PathBuf::from(format!("{}-wal", archive.display()));
    let mut files = vec![archive.to_path_buf()];
    if wal.exists() {
        files.push(wal);
    }
    files
}

/// Pages the kernel holds across the whole archive, and pages there are.
fn held(archive: &Path) -> (usize, usize) {
    archive_files(archive)
        .iter()
        .map(|file| resident(file).expect("the kernel says what it is holding"))
        .fold((0, 0), |(held, all), (some, of)| (held + some, all + of))
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

        for file in archive_files(&archive) {
            evict(&file).expect("the page cache is dropped");
        }
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
    if evicted_to.1 > 0 && evicted_to.0 * 2 > evicted_to.1 {
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
