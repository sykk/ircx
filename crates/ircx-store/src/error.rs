use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("could not open the message archive at {path}: {source}")]
    Open {
        path: PathBuf,
        #[source]
        source: rusqlite::Error,
    },

    #[error("the message archive could not be read: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("a message could not be read from the archive: {0}")]
    Json(#[from] serde_json::Error),

    #[error("that search could not be run: {0}")]
    Search(String),

    #[error(
        "this archive was written by a newer version of ircx (schema {found}, this build knows {supported})"
    )]
    SchemaTooNew { found: u32, supported: u32 },

    #[error(
        "the system keyring is unavailable, so the password for {network} was not saved: {source}"
    )]
    Keyring {
        network: String,
        #[source]
        source: keyring::Error,
    },

    #[error("could not write the export: {}", in_words(.0))]
    Io(#[from] std::io::Error),
}

/// Why a file would not take what was written to it, in the words somebody
/// looking at the save dialog would use for it.
///
/// `io::Error` renders as "Broken pipe (os error 32)", and the errno is the
/// half of that a log wants. The kinds a person can act on say what to do
/// instead; the rest keep the system's own words without the number.
pub fn in_words(error: &std::io::Error) -> String {
    use std::io::ErrorKind;

    match error.kind() {
        ErrorKind::PermissionDenied => "there is no permission to write there".to_owned(),
        ErrorKind::NotFound => "that folder does not exist".to_owned(),
        ErrorKind::IsADirectory => "that is a folder, not a file".to_owned(),
        ErrorKind::ReadOnlyFilesystem => "that disk is read-only".to_owned(),
        ErrorKind::StorageFull => "the disk is full".to_owned(),
        ErrorKind::BrokenPipe => "whatever was reading it stopped".to_owned(),
        // Whatever the OS said, up to the errno it ends with.
        _ => {
            let said = error.to_string();
            match said.find(" (os error ") {
                Some(at) => said[..at].to_owned(),
                None => said,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Error, ErrorKind};

    use super::in_words;

    /// The walk that found this met it as "Broken pipe (os error 32)".
    #[test]
    fn no_reason_carries_an_errno() {
        for kind in [
            ErrorKind::PermissionDenied,
            ErrorKind::NotFound,
            ErrorKind::IsADirectory,
            ErrorKind::ReadOnlyFilesystem,
            ErrorKind::StorageFull,
            ErrorKind::BrokenPipe,
            ErrorKind::WouldBlock,
        ] {
            let said = in_words(&Error::from(kind));
            assert!(!said.contains("os error"), "{kind:?} said {said}");
        }
    }

    /// A kind with nothing written for it keeps the system's words, which are
    /// still a sentence once the number is off the end.
    #[test]
    fn an_unnamed_kind_keeps_what_the_system_said() {
        // The raw code is platform-specific; what matters is that `in_words`
        // strips the errno suffix and leaves the OS message intact.
        let error = Error::from_raw_os_error(25);
        let mut expected = error.to_string();
        if let Some(at) = expected.find(" (os error ") {
            expected.truncate(at);
        }
        let said = in_words(&error);
        assert_eq!(said, expected);
    }
}
