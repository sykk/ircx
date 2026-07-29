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

    #[error("could not write the export: {0}")]
    Io(#[from] std::io::Error),
}
