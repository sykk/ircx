//! Taking an archive out of the kernel's page cache, and asking what is left.
//!
//! Shared by `cold_archive.rs`, which reads the whole file, and by
//! `history_page.rs`, which reads a page of it. Both measure the same
//! distinction — a file the machine has just written against one it has not
//! touched — and neither figure exists on a filesystem whose pages cannot be
//! dropped, so counting what stayed resident is part of the measurement rather
//! than a check on it.
//!
//! Linux only: `posix_fadvise` and `mincore` are how the cache is dropped and
//! how the drop is read.

#![allow(dead_code)]

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

pub fn page_size() -> usize {
    // SAFETY: `sysconf` takes a constant and answers with a long.
    unsafe { libc::sysconf(libc::_SC_PAGESIZE) as usize }
}

/// How many of `path`'s pages the kernel is holding, and how many it has.
///
/// `mincore` over a read-only mapping, which is what `fincore(1)` does. The
/// mapping is the cheapest way to ask; it reads none of the file and so warms
/// nothing by asking.
pub fn resident(path: &Path) -> io::Result<(usize, usize)> {
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
pub fn evict(path: &Path) -> io::Result<()> {
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
pub fn archive_files(archive: &Path) -> Vec<PathBuf> {
    let wal = PathBuf::from(format!("{}-wal", archive.display()));
    let mut files = vec![archive.to_path_buf()];
    if wal.exists() {
        files.push(wal);
    }
    files
}

/// Pages the kernel holds across the whole archive, and pages there are.
pub fn held(archive: &Path) -> (usize, usize) {
    archive_files(archive)
        .iter()
        .map(|file| resident(file).expect("the kernel says what it is holding"))
        .fold((0, 0), |(held, all), (some, of)| (held + some, all + of))
}

/// Drops every page of the archive that the kernel will let go of.
pub fn evict_archive(archive: &Path) {
    for file in archive_files(archive) {
        evict(&file).expect("the page cache is dropped");
    }
}

/// Whether an eviction left so much resident that what follows it is a second
/// warm reading. A `TMPDIR` on tmpfs *is* the page cache and cannot be taken
/// off it, and a run there has to say so rather than report two warm numbers.
pub fn eviction_failed(after: (usize, usize)) -> bool {
    after.1 > 0 && after.0 * 2 > after.1
}
