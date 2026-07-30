//! Installed plugins on disk.
//!
//! ```text
//! <root>/<id>/plugin.json   what the author declared
//! <root>/<id>/<entry>.js    the code
//! <root>/<id>/grants.json   what the user allowed, written only from here
//! <root>/<id>/data.json     the plugin's own storage, if it was granted any
//! ```
//!
//! Installing copies those first two files and nothing else, so a plugin
//! cannot arrive with its own grants already written.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::manifest::{Grants, Manifest, ManifestError};

const MANIFEST_FILE: &str = "plugin.json";
const GRANTS_FILE: &str = "grants.json";
const DATA_FILE: &str = "data.json";
/// A plugin is a script, not a program. Anything larger is a mistake or an
/// attempt to make loading expensive.
const MAX_SOURCE_BYTES: u64 = 1 << 20;

#[derive(Debug, Clone)]
pub struct Installed {
    pub manifest: Manifest,
    /// What the user allowed. Empty until they say otherwise: installing a
    /// plugin grants it nothing.
    pub grants: Grants,
    pub directory: PathBuf,
}

impl Installed {
    pub fn id(&self) -> &str {
        &self.manifest.id
    }

    pub(crate) fn entry(&self) -> PathBuf {
        self.directory.join(&self.manifest.entry)
    }

    pub(crate) fn data_file(&self) -> PathBuf {
        self.directory.join(DATA_FILE)
    }
}

/// The set of installed plugins. Opening one is a directory listing, which is
/// what a launch with no plugins pays.
pub struct Library {
    root: PathBuf,
    plugins: BTreeMap<String, Installed>,
}

impl Library {
    pub fn open(root: PathBuf) -> Result<Self, LibraryError> {
        let mut plugins = BTreeMap::new();
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            // No directory is the ordinary case for a user with no plugins.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self { root, plugins })
            }
            Err(error) => return Err(LibraryError::Unreadable(error)),
        };

        for entry in entries.flatten() {
            let directory = entry.path();
            if !directory.is_dir() {
                continue;
            }
            match read_installed(&directory) {
                Ok(installed) => {
                    plugins.insert(installed.id().to_owned(), installed);
                }
                // One unreadable plugin directory is not a reason to start
                // with none of them.
                Err(error) => {
                    tracing::warn!(directory = %directory.display(), %error, "ignoring a plugin");
                }
            }
        }
        Ok(Self { root, plugins })
    }

    pub fn installed(&self) -> Vec<Installed> {
        self.plugins.values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<&Installed> {
        self.plugins.get(id)
    }

    /// Copies `source`'s manifest and entry file into the library. The plugin
    /// arrives with nothing granted; `set_grants` is the only way to change
    /// that, and it is a separate decision by the user.
    pub fn install(&mut self, source: &Path) -> Result<Installed, LibraryError> {
        // A folder that holds no manifest is the ordinary mistake once the
        // source is something a user picked, so it says what it was looking for
        // rather than repeating the operating system.
        let manifest_bytes =
            fs::read(source.join(MANIFEST_FILE)).map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => LibraryError::NotAPlugin(display(source)),
                _ => LibraryError::Unreadable(error),
            })?;
        let manifest = Manifest::parse(&manifest_bytes).map_err(LibraryError::Rejected)?;

        let entry = source.join(&manifest.entry);
        let size = fs::metadata(&entry)
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => {
                    LibraryError::MissingEntry(manifest.id.clone(), manifest.entry.clone())
                }
                _ => LibraryError::Unreadable(error),
            })?
            .len();
        if size > MAX_SOURCE_BYTES {
            return Err(LibraryError::TooLarge(manifest.id, size));
        }
        let code = fs::read(&entry).map_err(LibraryError::Unreadable)?;
        if std::str::from_utf8(&code).is_err() {
            return Err(LibraryError::NotText(manifest.id));
        }

        let directory = self.root.join(&manifest.id);
        fs::create_dir_all(&directory).map_err(LibraryError::Unreadable)?;
        fs::write(directory.join(MANIFEST_FILE), &manifest_bytes)
            .map_err(LibraryError::Unreadable)?;
        fs::write(directory.join(&manifest.entry), &code).map_err(LibraryError::Unreadable)?;

        // Installing over a plugin that is already here grants nothing either,
        // because the code is not the code the user answered for. An id is a
        // folder name and a manifest can claim any of them, so keeping the
        // grants would let a second install inherit the first one's answer and
        // act on it before anybody was asked again.
        let grants = Grants::default();
        write_grants(&directory, &grants)?;

        let installed = Installed {
            manifest,
            grants,
            directory,
        };
        self.plugins
            .insert(installed.id().to_owned(), installed.clone());
        Ok(installed)
    }

    /// Grants are explicit and revocable: this writes exactly what it is given,
    /// so revoking is granting less, and granting nothing is uninstalling in
    /// everything but the files.
    pub fn set_grants(&mut self, id: &str, grants: Grants) -> Result<Installed, LibraryError> {
        let installed = self
            .plugins
            .get_mut(id)
            .ok_or_else(|| LibraryError::Unknown(id.to_owned()))?;
        grants
            .within(&installed.manifest.requests)
            .map_err(|error| LibraryError::Refused(id.to_owned(), error))?;
        write_grants(&installed.directory, &grants)?;
        installed.grants = grants;
        Ok(installed.clone())
    }

    /// The files go first. Dropping the entry before the removal that can fail
    /// would leave a plugin the library has forgotten, its routes still
    /// standing, and its grants on disk to be read back at the next launch.
    pub fn remove(&mut self, id: &str) -> Result<(), LibraryError> {
        let installed = self
            .plugins
            .get(id)
            .ok_or_else(|| LibraryError::Unknown(id.to_owned()))?;
        fs::remove_dir_all(&installed.directory).map_err(LibraryError::Unreadable)?;
        self.plugins.remove(id);
        Ok(())
    }
}

fn read_installed(directory: &Path) -> Result<Installed, LibraryError> {
    let bytes = fs::read(directory.join(MANIFEST_FILE)).map_err(LibraryError::Unreadable)?;
    let manifest = Manifest::parse(&bytes).map_err(LibraryError::Rejected)?;
    // The directory a plugin lives in is its id, so a manifest cannot rename
    // itself into another plugin's storage after it was installed.
    if directory
        .file_name()
        .is_none_or(|name| name != manifest.id.as_str())
    {
        return Err(LibraryError::Misplaced(manifest.id));
    }

    let grants = match fs::read(directory.join(GRANTS_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => Grants::default(),
    };
    // A grants file that outlived the manifest asking for those permissions
    // grants nothing; the user is asked again rather than kept to a promise
    // the new version did not make.
    let grants = match grants.within(&manifest.requests) {
        Ok(()) => grants,
        Err(_) => Grants::default(),
    };

    Ok(Installed {
        manifest,
        grants,
        directory: directory.to_path_buf(),
    })
}

fn write_grants(directory: &Path, grants: &Grants) -> Result<(), LibraryError> {
    let json = serde_json::to_vec_pretty(grants).map_err(LibraryError::Unwritable)?;
    fs::write(directory.join(GRANTS_FILE), json).map_err(LibraryError::Unreadable)
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("the plugin folder could not be read: {0}")]
    Unreadable(#[source] std::io::Error),
    #[error("{0} holds no plugin.json, so there is no plugin in it to install")]
    NotAPlugin(String),
    #[error("the plugin \"{0}\" names {1} as its code, and there is no such file beside its plugin.json")]
    MissingEntry(String, String),
    #[error("the plugin's permissions could not be written: {0}")]
    Unwritable(#[source] serde_json::Error),
    #[error("that plugin cannot be installed: {0}")]
    Rejected(#[source] ManifestError),
    #[error("the plugin \"{0}\" cannot be given that: {1}")]
    Refused(String, #[source] ManifestError),
    #[error("the plugin \"{0}\" is {1} bytes of code, which is more than a plugin may be")]
    TooLarge(String, u64),
    #[error("the plugin \"{0}\" is not text")]
    NotText(String),
    #[error("the plugin \"{0}\" is installed under another name")]
    Misplaced(String),
    #[error("no plugin named \"{0}\" is installed")]
    Unknown(String),
}
