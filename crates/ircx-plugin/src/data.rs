//! `store local data`: a string map per plugin, in one file the plugin never
//! names. There is no filesystem in the sandbox, so this is the only writing a
//! plugin can do, and it can only do it inside its own directory.

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::path::PathBuf;

/// Enough for settings and a cache of what a command looked up. A plugin that
/// wants a database wants something this client does not offer.
const MAX_BYTES: usize = 256 * 1024;
const MAX_KEY: usize = 128;

pub(crate) struct LocalData {
    file: PathBuf,
    values: BTreeMap<String, String>,
    held: usize,
}

impl LocalData {
    /// Unreadable or corrupt storage opens empty rather than failing the load:
    /// a plugin whose data file was damaged should still run.
    pub(crate) fn open(file: PathBuf) -> Self {
        let values: BTreeMap<String, String> = fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let held = values.iter().map(|(k, v)| k.len() + v.len()).sum();
        Self { file, values, held }
    }

    pub(crate) fn get(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned()
    }

    pub(crate) fn keys(&self) -> Vec<String> {
        self.values.keys().cloned().collect()
    }

    pub(crate) fn set(&mut self, key: String, value: String) -> Result<(), DataError> {
        if key.is_empty() || key.len() > MAX_KEY {
            return Err(DataError::Key);
        }
        let replaced = self.values.get(&key).map_or(0, |old| key.len() + old.len());
        let after = self.held - replaced + key.len() + value.len();
        if after > MAX_BYTES {
            return Err(DataError::Full);
        }
        self.values.insert(key, value);
        self.held = after;
        self.write()
    }

    pub(crate) fn remove(&mut self, key: &str) -> Result<(), DataError> {
        if let Some(old) = self.values.remove(key) {
            self.held -= key.len() + old.len();
            return self.write();
        }
        Ok(())
    }

    fn write(&self) -> Result<(), DataError> {
        let json = serde_json::to_vec(&self.values).map_err(|_| DataError::Full)?;
        fs::write(&self.file, json).map_err(|_| DataError::Unwritable)
    }
}

#[derive(Debug)]
pub(crate) enum DataError {
    Key,
    Full,
    Unwritable,
}

impl fmt::Display for DataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Key => write!(f, "that is not a key a plugin may store"),
            Self::Full => write!(f, "this plugin has used all the storage it is allowed"),
            Self::Unwritable => write!(f, "the plugin's storage could not be written"),
        }
    }
}
