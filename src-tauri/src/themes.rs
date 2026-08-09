//! Reads the themes directory. The backend does not parse any file: it hands
//! theme.json, theme.css and optional ui.css to the frontend, which owns
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
            ui_stylesheet: std::fs::read_to_string(entry.path().join("ui.css")).unwrap_or_default(),
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

/// The three files a theme is made of. `ui.css` is optional and copied when it
/// is there; the other two are what makes a directory a theme at all.
const FILES: [&str; 3] = ["theme.json", "theme.css", "ui.css"];

/// Copies a theme directory into the themes directory, and answers with the id
/// it landed under — its folder name, which is what the rest of the theme
/// system keys on.
///
/// Only those three files are copied, and nothing below them. A theme is a
/// manifest and a stylesheet; anything else in the folder somebody picked is
/// something they did not mean to install, and copying a tree the client never
/// reads would make this a general file copier with a themes-shaped name.
pub fn install(directory: &Path, source: &Path) -> Result<String, String> {
    let Some(id) = theme_id(source) else {
        return Err(format!(
            "{} is not a folder. Pick the folder holding theme.json and theme.css.",
            source.display()
        ));
    };

    for required in ["theme.json", "theme.css"] {
        if !source.join(required).is_file() {
            return Err(format!(
                "{id} has no {required}. A theme is a folder holding theme.json and theme.css."
            ));
        }
    }

    let target = directory.join(&id);
    /* Installing the folder that is already installed would copy each file onto
     * itself, and the picker puts that one click away: the themes directory is
     * where somebody looking for an example to copy goes first. */
    if same_place(source, &target) {
        return Err(format!(
            "{id} is already installed. There is nothing to copy."
        ));
    }

    std::fs::create_dir_all(&target)
        .map_err(|error| format!("ircx could not create {}: {error}", target.display()))?;

    for file in FILES {
        let from = source.join(file);
        if !from.is_file() {
            /* Reinstalling a theme that has dropped its ui.css must not leave
             * the old one behind, animating a theme that no longer asks it. */
            let _ = std::fs::remove_file(target.join(file));
            continue;
        }
        std::fs::copy(&from, target.join(file))
            .map_err(|error| format!("ircx could not copy {}: {error}", from.display()))?;
    }

    Ok(id)
}

/// Whether two paths name the same directory, compared after resolution so a
/// symlink or a `..` in the picked path is still recognised.
fn same_place(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
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
        for file in ["theme.json", "theme.css", "ui.css"] {
            let Ok(meta) = std::fs::metadata(entry.path().join(file)) else {
                continue;
            };
            marks.push((format!("{id}/{file}"), meta.len(), meta.modified().ok()));
        }
    }
    marks.sort();
    marks
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A theme folder with whichever files the test wants in it.
    fn source(at: &Path, files: &[&str]) -> PathBuf {
        let folder = at.join("harbour");
        std::fs::create_dir_all(&folder).unwrap();
        for file in files {
            std::fs::write(folder.join(file), format!("{file} contents")).unwrap();
        }
        folder
    }

    #[test]
    fn copies_a_theme_under_its_folder_name() {
        let picked = tempfile::tempdir().unwrap();
        let themes = tempfile::tempdir().unwrap();
        let from = source(picked.path(), &["theme.json", "theme.css"]);

        let id = install(themes.path(), &from).unwrap();

        assert_eq!(id, "harbour");
        assert!(themes.path().join("harbour/theme.json").is_file());
        assert!(themes.path().join("harbour/theme.css").is_file());
    }

    #[test]
    fn takes_the_optional_ui_stylesheet_too() {
        let picked = tempfile::tempdir().unwrap();
        let themes = tempfile::tempdir().unwrap();
        let from = source(picked.path(), &["theme.json", "theme.css", "ui.css"]);

        install(themes.path(), &from).unwrap();

        assert!(themes.path().join("harbour/ui.css").is_file());
    }

    /// Nothing below the three is a theme, and copying it would make this a
    /// general file copier that happens to be called from the theme sheet.
    #[test]
    fn leaves_everything_that_is_not_a_theme_file() {
        let picked = tempfile::tempdir().unwrap();
        let themes = tempfile::tempdir().unwrap();
        let from = source(picked.path(), &["theme.json", "theme.css", "notes.txt"]);
        std::fs::create_dir_all(from.join("screenshots")).unwrap();

        install(themes.path(), &from).unwrap();

        assert!(!themes.path().join("harbour/notes.txt").exists());
        assert!(!themes.path().join("harbour/screenshots").exists());
    }

    /// Left behind, it would animate a theme whose author took the file out.
    #[test]
    fn drops_a_ui_stylesheet_a_reinstall_no_longer_has() {
        let picked = tempfile::tempdir().unwrap();
        let themes = tempfile::tempdir().unwrap();

        install(
            themes.path(),
            &source(picked.path(), &["theme.json", "theme.css", "ui.css"]),
        )
        .unwrap();
        std::fs::remove_file(picked.path().join("harbour/ui.css")).unwrap();
        install(themes.path(), &picked.path().join("harbour")).unwrap();

        assert!(!themes.path().join("harbour/ui.css").exists());
    }

    #[test]
    fn names_the_file_a_folder_is_missing() {
        let picked = tempfile::tempdir().unwrap();
        let themes = tempfile::tempdir().unwrap();
        let from = source(picked.path(), &["theme.json"]);

        let problem = install(themes.path(), &from).unwrap_err();

        assert!(problem.contains("theme.css"), "{problem}");
    }

    #[test]
    fn refuses_a_path_that_is_not_a_folder() {
        let picked = tempfile::tempdir().unwrap();
        let themes = tempfile::tempdir().unwrap();
        let file = picked.path().join("theme.css");
        std::fs::write(&file, "").unwrap();

        assert!(install(themes.path(), &file).is_err());
    }

    /// The themes directory is where somebody goes for an example to copy, so
    /// the picker puts installing a theme over itself one click away.
    #[test]
    fn refuses_to_install_a_theme_over_itself() {
        let themes = tempfile::tempdir().unwrap();
        let from = source(themes.path(), &["theme.json", "theme.css"]);

        let problem = install(themes.path(), &from).unwrap_err();

        assert!(problem.contains("already installed"), "{problem}");
        assert_eq!(
            std::fs::read_to_string(from.join("theme.css")).unwrap(),
            "theme.css contents"
        );
    }
}
