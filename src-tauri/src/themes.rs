//! Reads the themes directory. The backend does not parse either file: it
//! hands both to the frontend, which owns the token contract and so owns
//! validation.

use std::path::{Path, PathBuf};
use std::time::Duration;

use ircx_ipc::{ThemeSource, THEMES_CHANNEL};
use tauri::{AppHandle, Emitter, Manager};
use tracing::warn;

/// How often the themes directory is checked for edits. Long enough to be free
/// and short enough that saving a stylesheet feels like it took effect.
const POLL: Duration = Duration::from_secs(2);

pub fn directory(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("ircx could not find its data directory: {error}"))?;
    let themes = data.join("themes");
    std::fs::create_dir_all(&themes)
        .map_err(|error| format!("ircx could not open {}: {error}", themes.display()))?;
    Ok(themes)
}

/// One entry per subdirectory. A theme missing a file still comes back, with
/// that file empty, so the frontend can say which one is missing instead of
/// the theme quietly not existing.
pub fn read(directory: &Path) -> Result<Vec<ThemeSource>, String> {
    let entries = std::fs::read_dir(directory)
        .map_err(|error| format!("ircx could not read {}: {error}", directory.display()))?;

    let mut themes = Vec::new();
    for entry in entries.flatten() {
        let Some(id) = theme_id(&entry.path()) else {
            continue;
        };
        themes.push(ThemeSource {
            manifest: std::fs::read_to_string(entry.path().join("theme.json")).unwrap_or_default(),
            stylesheet: std::fs::read_to_string(entry.path().join("theme.css")).unwrap_or_default(),
            id,
        });
    }
    themes.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(themes)
}

fn theme_id(path: &Path) -> Option<String> {
    if !path.is_dir() {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    if name.starts_with('.') {
        return None;
    }
    Some(name.to_owned())
}

/// Republishes the directory whenever it changes on disk. Polling metadata
/// beats a watcher dependency here: the directory holds a handful of entries,
/// and an editor that writes through a temporary file trips a watcher twice
/// anyway.
pub fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Ok(directory) = directory(&app).inspect_err(|error| warn!(%error)) else {
            return;
        };

        let mut known = fingerprint(&directory);
        loop {
            tokio::time::sleep(POLL).await;
            let current = fingerprint(&directory);
            if current == known {
                continue;
            }
            known = current;

            match read(&directory) {
                Ok(themes) => {
                    if let Err(error) = app.emit(THEMES_CHANNEL, &themes) {
                        warn!(%error, "could not deliver the themes to the window");
                    }
                }
                Err(error) => warn!(%error),
            }
        }
    });
}

/// Cheap enough to run on a timer: metadata only, no file contents.
fn fingerprint(directory: &Path) -> Vec<(String, u64, Option<std::time::SystemTime>)> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };

    let mut marks = Vec::new();
    for entry in entries.flatten() {
        let Some(id) = theme_id(&entry.path()) else {
            continue;
        };
        for file in ["theme.json", "theme.css"] {
            let Ok(meta) = std::fs::metadata(entry.path().join(file)) else {
                continue;
            };
            marks.push((format!("{id}/{file}"), meta.len(), meta.modified().ok()));
        }
    }
    marks.sort();
    marks
}
