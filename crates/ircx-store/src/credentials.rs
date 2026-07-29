use std::collections::HashMap;
use std::sync::Mutex;

use ircx_ipc::NetworkId;

use crate::StoreError;

const SERVICE: &str = "ircx";

/// The seam that keeps tests off the developer's real keyring.
pub(crate) trait CredentialStore: Send + Sync {
    fn get(&self, network: &NetworkId) -> Result<Option<String>, StoreError>;
    fn set(&self, network: &NetworkId, password: &str) -> Result<(), StoreError>;
    fn delete(&self, network: &NetworkId) -> Result<(), StoreError>;
}

pub(crate) struct OsKeyring;

impl OsKeyring {
    fn entry(network: &NetworkId) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(SERVICE, network).map_err(|source| StoreError::Keyring {
            network: network.clone(),
            source,
        })
    }

    fn wrap(network: &NetworkId, source: keyring::Error) -> StoreError {
        StoreError::Keyring {
            network: network.clone(),
            source,
        }
    }
}

impl CredentialStore for OsKeyring {
    fn get(&self, network: &NetworkId) -> Result<Option<String>, StoreError> {
        match Self::entry(network)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(source) => Err(Self::wrap(network, source)),
        }
    }

    fn set(&self, network: &NetworkId, password: &str) -> Result<(), StoreError> {
        Self::entry(network)?
            .set_password(password)
            .map_err(|source| Self::wrap(network, source))
    }

    fn delete(&self, network: &NetworkId) -> Result<(), StoreError> {
        match Self::entry(network)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(source) => Err(Self::wrap(network, source)),
        }
    }
}

#[derive(Default)]
pub(crate) struct MemoryCredentials(Mutex<HashMap<NetworkId, String>>);

impl MemoryCredentials {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<NetworkId, String>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl CredentialStore for MemoryCredentials {
    fn get(&self, network: &NetworkId) -> Result<Option<String>, StoreError> {
        Ok(self.map().get(network).cloned())
    }

    fn set(&self, network: &NetworkId, password: &str) -> Result<(), StoreError> {
        self.map().insert(network.clone(), password.to_owned());
        Ok(())
    }

    fn delete(&self, network: &NetworkId) -> Result<(), StoreError> {
        self.map().remove(network);
        Ok(())
    }
}
