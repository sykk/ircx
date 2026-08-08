use std::collections::HashMap;
use std::sync::Mutex;

use crate::StoreError;

const SERVICE: &str = "ircx";

/// Where the upload provider's token is kept.
///
/// The same store as a network's SASL password, under a name no network can
/// take: an id is 32 hex characters, so nothing generated can equal this.
pub(crate) const UPLOAD_PROVIDER: &str = "upload-provider";

/// The seam that keeps tests off the developer's real keyring.
pub(crate) trait CredentialStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError>;
    fn set(&self, key: &str, password: &str) -> Result<(), StoreError>;
    fn delete(&self, key: &str) -> Result<(), StoreError>;
}

pub(crate) struct OsKeyring;

impl OsKeyring {
    fn entry(key: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(SERVICE, key).map_err(StoreError::Keyring)
    }
}

impl CredentialStore for OsKeyring {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        match Self::entry(key)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(source) => Err(StoreError::Keyring(source)),
        }
    }

    fn set(&self, key: &str, password: &str) -> Result<(), StoreError> {
        Self::entry(key)?
            .set_password(password)
            .map_err(StoreError::Keyring)
    }

    fn delete(&self, key: &str) -> Result<(), StoreError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(source) => Err(StoreError::Keyring(source)),
        }
    }
}

#[derive(Default)]
pub(crate) struct MemoryCredentials(Mutex<HashMap<String, String>>);

impl MemoryCredentials {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl CredentialStore for MemoryCredentials {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self.map().get(key).cloned())
    }

    fn set(&self, key: &str, password: &str) -> Result<(), StoreError> {
        self.map().insert(key.to_owned(), password.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.map().remove(key);
        Ok(())
    }
}
