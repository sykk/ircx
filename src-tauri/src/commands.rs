use std::path::PathBuf;

use ircx_core::SessionCommand;
use ircx_ipc::{
    AppSnapshot, ArchiveScope, ArchiveSummary, Attachment, ChatMessage, CommandOutcome,
    FileToUpload, HistoryRequest, InstalledPlugin, Member, NetworkConfig, NetworkId, PluginGrants,
    PluginPermissionInfo, Query, SearchHit, SearchRequest, TargetName, ThemeSource, UploadProvider,
    UploadedFile,
};
use ircx_store::{in_words, StoreError};
use tauri::State;

use crate::state::{describe, App};

#[tauri::command]
pub async fn get_snapshot(app: State<'_, App>) -> Result<AppSnapshot, String> {
    app.snapshot().await
}

#[tauri::command]
pub async fn list_network_configs(app: State<'_, App>) -> Result<Vec<NetworkConfig>, String> {
    app.store().list_networks().map_err(describe)
}

/// The upload provider, or nothing when none is configured — which the spec
/// names as a choice rather than a fault. The token is never sent to the
/// window; it is read at the moment of an upload.
#[tauri::command]
pub async fn get_upload_provider(app: State<'_, App>) -> Result<Option<UploadProvider>, String> {
    app.store().upload_provider().map_err(describe)
}

#[tauri::command]
pub async fn save_upload_provider(
    app: State<'_, App>,
    provider: UploadProvider,
) -> Result<(), String> {
    app.store()
        .save_upload_provider(&provider)
        .map_err(describe)
}

#[tauri::command]
pub async fn remove_upload_provider(app: State<'_, App>) -> Result<(), String> {
    app.store().remove_upload_provider().map_err(describe)
}

/// What the confirmation shows about the files a user dropped: the name, the
/// size, and whether this client will send it at all.
#[tauri::command]
pub async fn describe_uploads(paths: Vec<String>) -> Result<Vec<FileToUpload>, String> {
    Ok(crate::upload::describe_files(&paths).await)
}

/// Sends a file to the configured provider and answers with its address. The
/// window puts that address in the conversation; nothing is sent from here.
#[tauri::command]
pub async fn upload_file(app: State<'_, App>, path: String) -> Result<UploadedFile, String> {
    crate::upload::send_file(&app, &path).await
}

#[tauri::command]
pub async fn save_network(app: State<'_, App>, config: NetworkConfig) -> Result<NetworkId, String> {
    app.save_network(config).await
}

#[tauri::command]
pub async fn remove_network(app: State<'_, App>, network: NetworkId) -> Result<(), String> {
    app.remove_network(&network).await
}

#[tauri::command]
pub async fn connect_network(app: State<'_, App>, network: NetworkId) -> Result<(), String> {
    app.connect(&network).await
}

#[tauri::command]
pub async fn disconnect_network(
    app: State<'_, App>,
    network: NetworkId,
    quit_message: Option<String>,
) -> Result<(), String> {
    app.disconnect(&network, quit_message).await
}

#[tauri::command]
pub async fn join_channel(
    app: State<'_, App>,
    network: NetworkId,
    channel: String,
    key: Option<String>,
) -> Result<(), String> {
    app.tell(&network, SessionCommand::Join { channel, key })
        .await
}

#[tauri::command]
pub async fn open_query(
    app: State<'_, App>,
    network: NetworkId,
    nick: String,
) -> Result<Query, String> {
    app.ask(&network, |reply| SessionCommand::OpenQuery { nick, reply })
        .await
}

#[tauri::command]
pub async fn close_target(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
) -> Result<(), String> {
    app.tell_if_connected(&network, SessionCommand::CloseTarget { target })
        .await;
    Ok(())
}

#[tauri::command]
pub async fn submit_input(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
    input: String,
    reply_to: Option<String>,
) -> Result<CommandOutcome, String> {
    app.ask(&network, |reply| SessionCommand::Submit {
        target,
        input,
        reply_to,
        reply,
    })
    .await
}

#[tauri::command]
pub async fn list_members(
    app: State<'_, App>,
    network: NetworkId,
    channel: TargetName,
) -> Result<Vec<Member>, String> {
    app.ask(&network, |reply| SessionCommand::Members { channel, reply })
        .await
}

#[tauri::command]
pub async fn load_history(
    app: State<'_, App>,
    req: HistoryRequest,
) -> Result<Vec<ChatMessage>, String> {
    app.store().load_history(&req).map_err(describe)
}

#[tauri::command]
pub async fn search_history(
    app: State<'_, App>,
    req: SearchRequest,
) -> Result<Vec<SearchHit>, String> {
    app.store().search(&req).map_err(describe)
}

#[tauri::command]
pub async fn mark_read(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
) -> Result<(), String> {
    app.tell_if_connected(&network, SessionCommand::MarkRead { target })
        .await;
    Ok(())
}

#[tauri::command]
pub async fn set_typing(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
    active: bool,
) -> Result<(), String> {
    app.tell_if_connected(&network, SessionCommand::SetTyping { target, active })
        .await;
    Ok(())
}

/// The only fetch ircx makes for a URL somebody else posted, and only because
/// the user asked for the preview by name.
#[tauri::command]
pub async fn load_preview(url: String) -> Result<Attachment, String> {
    crate::preview::load(&url).await
}

#[tauri::command]
pub async fn get_draft(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
) -> Result<Option<String>, String> {
    app.store().get_draft(&network, &target).map_err(describe)
}

#[tauri::command]
pub async fn set_draft(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
    text: String,
) -> Result<(), String> {
    app.store()
        .set_draft(&network, &target, &text)
        .map_err(describe)
}

/// Says something to a screen reader, which a live region in this window
/// cannot. `crate::announce` has the why.
#[tauri::command]
pub async fn announce(window: tauri::WebviewWindow, message: String) -> Result<(), String> {
    if !message.is_empty() {
        crate::announce::say(window, message);
    }
    Ok(())
}

/// The themes directory, read whole. Themes install by being copied in, so
/// there is nothing to register and nothing to keep in sync.
#[tauri::command]
pub async fn list_themes(app: tauri::AppHandle) -> Result<Vec<ThemeSource>, String> {
    let directory = crate::themes::directory(&app)?;
    crate::themes::read(&directory)
}

#[tauri::command]
pub async fn list_plugins(app: State<'_, App>) -> Result<Vec<InstalledPlugin>, String> {
    app.list_plugins()
}

#[tauri::command]
pub async fn plugin_permissions() -> Result<Vec<PluginPermissionInfo>, String> {
    Ok(ircx_core::describe_permissions())
}

/// `source` is the folder the user picked, which holds the author's
/// `plugin.json` and its one file of code.
#[tauri::command]
pub async fn install_plugin(
    app: State<'_, App>,
    source: String,
) -> Result<InstalledPlugin, String> {
    app.install_plugin(&PathBuf::from(source)).await
}

#[tauri::command]
pub async fn set_plugin_grants(
    app: State<'_, App>,
    plugin: String,
    grants: PluginGrants,
) -> Result<InstalledPlugin, String> {
    app.set_plugin_grants(&plugin, grants).await
}

#[tauri::command]
pub async fn remove_plugin(app: State<'_, App>, plugin: String) -> Result<(), String> {
    app.remove_plugin(&plugin).await
}

/// What the archive holds, and what this conversation's rule is.
///
/// `target` is optional because the sheet opens with or without a conversation
/// in front of it, and the network's own rule is worth showing either way.
#[tauri::command]
pub async fn archive_summary(
    app: State<'_, App>,
    network: Option<NetworkId>,
    target: Option<TargetName>,
) -> Result<ArchiveSummary, String> {
    let store = app.store();
    let size = store.archive_size().map_err(describe)?;
    let (network_days, target_days, target_override) = match network.as_deref() {
        None => (None, None, false),
        Some(network) => {
            let network_days = store.retention(network, None).map_err(describe)?.flatten();
            match target.as_deref() {
                None => (network_days, None, false),
                Some(target) => match store.retention(network, Some(target)).map_err(describe)? {
                    Some(days) => (network_days, days, true),
                    None => (network_days, None, false),
                },
            }
        }
    };
    Ok(ArchiveSummary {
        messages: size.messages,
        bytes: size.bytes,
        network_days,
        target_days,
        target_override,
        removed_on_launch: app.pruned_on_launch(),
    })
}

/// `days` of `None` keeps messages forever. `target` of `None` sets the
/// network's own rule rather than an override.
#[tauri::command]
pub async fn set_retention(
    app: State<'_, App>,
    network: NetworkId,
    target: Option<TargetName>,
    days: Option<u32>,
) -> Result<(), String> {
    app.store()
        .set_retention(&network, target.as_deref(), days)
        .map_err(describe)
}

/// Writes the archive to `path` as JSON Lines and answers with how many bytes
/// went, which is the only thing the caller can show that the file itself does
/// not already say.
#[tauri::command]
pub async fn export_archive(
    app: State<'_, App>,
    scope: ArchiveScope,
    path: String,
) -> Result<u64, String> {
    // Streamed rather than rendered into memory first: "Everything" on an old
    // archive is the whole archive.
    let file = std::fs::File::create(&path).map_err(|error| unwritable(&path, &error))?;
    let mut out = std::io::BufWriter::new(file);
    let store = app.store();
    match &scope {
        ArchiveScope::Conversation { network, target } => store
            .export_target(network, target, &mut out)
            .map_err(|error| gave_up(&path, error))?,
        ArchiveScope::Everything => store
            .export_everything(&mut out)
            .map_err(|error| gave_up(&path, error))?,
    }
    let file = out
        .into_inner()
        .map_err(|error| unwritable(&path, error.error()))?;
    file.metadata()
        .map(|meta| meta.len())
        .map_err(|error| unwritable(&path, &error))
}

/// Which file would not take the export, and why.
fn unwritable(path: &str, error: &std::io::Error) -> String {
    format!("{path} could not be written: {}", in_words(error))
}

/// An export that stops partway stopped for one of two reasons, and only one of
/// them is about the file. The store raises `Io` without knowing which file it
/// was handed a writer for, so the path is put back here; anything else is the
/// archive failing and has nothing to do with where it was going.
fn gave_up(path: &str, error: StoreError) -> String {
    match error {
        StoreError::Io(io) => unwritable(path, &io),
        archive => describe(archive),
    }
}

/// There is no undo. Whatever asks for this has to have said so.
#[tauri::command]
pub async fn delete_archive(app: State<'_, App>, scope: ArchiveScope) -> Result<(), String> {
    let store = app.store();
    match &scope {
        ArchiveScope::Conversation { network, target } => {
            store.delete_target(network, target).map_err(describe)
        }
        ArchiveScope::Everything => store.delete_everything().map_err(describe),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Error, ErrorKind};

    use super::{gave_up, unwritable, StoreError};

    #[test]
    fn a_refused_folder_says_what_to_do_about_it() {
        let said = unwritable(
            "/srv/backups/ircx.jsonl",
            &Error::from(ErrorKind::PermissionDenied),
        );
        assert_eq!(
            said,
            "/srv/backups/ircx.jsonl could not be written: there is no permission to write there"
        );
    }

    /// The walk that found this met it as "could not write the export: Broken
    /// pipe (os error 32)" — no file named, because the store never knew one.
    #[test]
    fn a_write_that_stops_partway_names_the_file_it_was_going_to() {
        let said = gave_up(
            "/tmp/pipe.jsonl",
            StoreError::Io(Error::from(ErrorKind::BrokenPipe)),
        );
        assert_eq!(
            said,
            "/tmp/pipe.jsonl could not be written: whatever was reading it stopped"
        );
    }

    /// The archive failing is not the file failing, and naming the file for it
    /// would send the reader to the wrong place.
    #[test]
    fn an_archive_that_fails_is_not_reported_against_the_file() {
        let said = gave_up(
            "/tmp/x.jsonl",
            StoreError::SchemaTooNew {
                found: 9,
                supported: 4,
            },
        );
        assert!(!said.contains("/tmp/x.jsonl"), "said {said}");
        assert!(said.contains("newer version of ircx"), "said {said}");
    }
}
