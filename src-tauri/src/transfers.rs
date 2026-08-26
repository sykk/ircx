//! The part of a file transfer that needs a disk or an operating system.
//!
//! The handshake belongs to the session and the bytes to `ircx_net`; what is
//! here is everything neither of them can know — where a received file lands,
//! what it is called once two people have sent one with the same name, how much
//! of it is already there, and what address this machine can honestly claim in
//! an offer.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use ircx_core::dcc::safe_file_name;
use ircx_ipc::TransferSettings;
use ircx_net::dcc::{local_address, partial};
use ircx_store::Store;
use tauri::{AppHandle, Manager};

use crate::state::describe;

/// How many times a name is numbered before this gives up. A directory holding
/// a thousand files of one name is not a collision any more.
const NAMES_TRIED: u32 = 1000;

/// What the settings are before anybody changes them: files land where the
/// operating system puts downloads, the ports are the operating system's to
/// choose, and an offer names the address the connection goes out from.
pub fn defaults(handle: &AppHandle) -> TransferSettings {
    TransferSettings {
        directory: downloads(handle),
        ports: None,
        address: None,
        passive: false,
    }
}

pub fn settings(handle: &AppHandle, store: &Store) -> Result<TransferSettings, String> {
    Ok(store
        .transfer_settings()
        .map_err(describe)?
        .unwrap_or_else(|| defaults(handle)))
}

/// Refuses settings that would fail at the moment they were needed, which is
/// during somebody else's transfer rather than on this page.
pub fn refuse_save(settings: &TransferSettings) -> Option<String> {
    if settings.directory.trim().is_empty() {
        return Some("Choose a folder for received files".into());
    }
    if let Some((first, last)) = settings.ports {
        if first == 0 || last == 0 {
            return Some("A port range needs two port numbers, or leave both empty".into());
        }
        if first > last {
            return Some(format!("Port {first} is above port {last}"));
        }
    }
    if let Some(address) = settings.address.as_deref().filter(|a| !a.trim().is_empty()) {
        if address.trim().parse::<IpAddr>().is_err() {
            return Some(format!(
                "{address} is not an IP address. Use the address other people reach this \
                 machine at, or leave it empty to use the one this connection goes out from."
            ));
        }
    }
    None
}

fn downloads(handle: &AppHandle) -> String {
    let path = handle
        .path()
        .download_dir()
        .or_else(|_| handle.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    path.to_string_lossy().into_owned()
}

/// Where an accepted file lands, and how much of it is already on disk.
///
/// A name already taken by a finished file is numbered, because two people
/// sending `screenshot.png` must not overwrite each other. A name with only a
/// part file behind it is not taken: that part is what a resume continues, and
/// it is the only thing this client ever appends to.
pub async fn landing(directory: &Path, offered: &str, size: u64) -> Result<(PathBuf, u64), String> {
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| {
            format!(
                "ircx could not open {} to put the file in: {error}",
                directory.display()
            )
        })?;

    let name = safe_file_name(offered);
    let mut landing = directory.join(&name);
    for number in 2..NAMES_TRIED {
        if !exists(&landing).await {
            return Ok((landing.clone(), resume_from(&landing, size).await));
        }
        landing = directory.join(numbered(&name, number));
    }
    Err(format!(
        "{} already holds {NAMES_TRIED} files called {name}",
        directory.display()
    ))
}

/// Where a save-as lands: the path the user picked, with whatever of it is
/// already there. Not numbered — a name typed into a save dialog is a name
/// somebody chose over the one that was there.
pub async fn chosen(path: &str, size: u64) -> (PathBuf, u64) {
    let path = PathBuf::from(path);
    let from = resume_from(&path, size).await;
    (path, from)
}

/// What a part file beside `landing` is worth resuming from. One at or past the
/// offered size is not part of this file, and starting again is the only honest
/// thing to do with it.
async fn resume_from(landing: &Path, size: u64) -> u64 {
    match tokio::fs::metadata(partial(landing)).await {
        Ok(part) if size == 0 || part.len() < size => part.len(),
        _ => 0,
    }
}

async fn exists(path: &Path) -> bool {
    tokio::fs::try_exists(path).await.unwrap_or(false)
}

/// `holiday.png` under a name that is taken becomes `holiday (2).png`.
fn numbered(name: &str, number: u32) -> String {
    match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{stem} ({number}).{extension}"),
        _ => format!("{name} ({number})"),
    }
}

/// The name and length of a file about to be offered.
pub async fn describe_file(path: &Path) -> Result<(String, u64), String> {
    let file = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("{} could not be read: {error}", path.display()))?;
    if !file.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    // A zero-length offer is how a sender says it does not know the size, so an
    // empty file cannot be offered without claiming something untrue about it.
    if file.len() == 0 {
        return Err(format!(
            "{} is empty, so there is nothing to send",
            path.display()
        ));
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| format!("{} has no name to offer it under", path.display()))?;
    Ok((name, file.len()))
}

/// The address an offer names.
///
/// The configured one wins, because a client behind a router knows something
/// the routing table does not. Without one this is the address the IRC
/// connection goes out from, which is right for a machine that is directly
/// reachable and is a private address for every other one — which is what
/// passive offers are for.
pub async fn advertised(
    settings: &TransferSettings,
    host: &str,
    port: u16,
) -> Result<IpAddr, String> {
    if let Some(address) = settings.address.as_deref().filter(|a| !a.trim().is_empty()) {
        return address.trim().parse().map_err(|_| {
            format!("{address} is not an IP address ircx can put in an offer. Change it on the Transfers page.")
        });
    }
    local_address(host, port).await.ok_or_else(|| {
        "ircx could not work out which address to offer the file from. Set one on the \
         Transfers page."
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_a_name_before_its_extension() {
        assert_eq!(numbered("holiday.png", 2), "holiday (2).png");
        assert_eq!(numbered("archive.tar.gz", 3), "archive.tar (3).gz");
        assert_eq!(numbered("README", 2), "README (2)");
        assert_eq!(numbered(".hidden", 2), ".hidden (2)");
    }

    #[tokio::test]
    async fn a_taken_name_is_numbered_and_an_unfinished_one_is_resumed() {
        let directory = std::env::temp_dir().join("ircx-landing");
        let _ = tokio::fs::remove_dir_all(&directory).await;
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("a directory");

        let (fresh, from) = landing(&directory, "holiday.png", 100)
            .await
            .expect("a place for it");
        assert_eq!(fresh, directory.join("holiday.png"));
        assert_eq!(from, 0);

        tokio::fs::write(&fresh, b"finished")
            .await
            .expect("a finished file");
        let (second, _) = landing(&directory, "holiday.png", 100)
            .await
            .expect("a place for it");
        assert_eq!(second, directory.join("holiday (2).png"));

        tokio::fs::write(partial(&second), b"half")
            .await
            .expect("a part file");
        let (again, from) = landing(&directory, "holiday.png", 100)
            .await
            .expect("a place for it");
        assert_eq!(again, second, "a part file does not take the name");
        assert_eq!(from, 4, "and is what the transfer carries on from");

        let _ = tokio::fs::remove_dir_all(&directory).await;
    }

    /// A part file as long as the offer is not the beginning of it, whatever it
    /// is. Appending to it would produce a file of twice the length.
    #[tokio::test]
    async fn a_part_file_that_is_already_long_enough_is_started_again() {
        let directory = std::env::temp_dir().join("ircx-landing-full");
        let _ = tokio::fs::remove_dir_all(&directory).await;
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("a directory");
        let landed = directory.join("holiday.png");
        tokio::fs::write(partial(&landed), vec![0u8; 100])
            .await
            .expect("a part file");

        let (_, from) = landing(&directory, "holiday.png", 100)
            .await
            .expect("a place for it");
        assert_eq!(from, 0);
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }

    #[test]
    fn settings_that_would_fail_later_are_refused_now() {
        let good = TransferSettings {
            directory: "/tmp".into(),
            ports: Some((40_000, 40_010)),
            address: Some("10.0.0.7".into()),
            passive: true,
        };
        assert_eq!(refuse_save(&good), None);

        let backwards = TransferSettings {
            ports: Some((40_010, 40_000)),
            ..good.clone()
        };
        assert!(refuse_save(&backwards).is_some());

        let unnamed = TransferSettings {
            directory: "  ".into(),
            ..good.clone()
        };
        assert!(refuse_save(&unnamed).is_some());

        let not_an_address = TransferSettings {
            address: Some("my-router".into()),
            ..good.clone()
        };
        assert!(refuse_save(&not_an_address).is_some());

        let no_address = TransferSettings {
            address: Some(String::new()),
            ..good
        };
        assert_eq!(refuse_save(&no_address), None);
    }
}
