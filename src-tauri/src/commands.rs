use std::path::PathBuf;

use ircx_core::SessionCommand;
use ircx_ipc::{
    AppSnapshot, ArchiveScope, ArchiveSummary, Attachment, ChatMessage, CommandOutcome,
    FileToUpload, HistoryRequest, InstalledPlugin, Member, NetworkConfig, NetworkId, PluginGrants,
    PluginPermissionInfo, Query, SearchHit, SearchRequest, TargetName, ThemeSource, UploadProvider,
    UploadedFile,
};
use ircx_store::{in_words, Store, StoreError};
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

/// The SHA-256 of a certificate file, for the user to register with their
/// account service before SASL EXTERNAL can authenticate them.
///
/// Read here rather than in the frontend because the frontend has no way to
/// read a file, and should not: the path is one the user chose in a dialog and
/// the fingerprint is the only part of the file this window ever sees.
#[tauri::command]
pub async fn certificate_fingerprint(path: String) -> Result<String, String> {
    // `NetError`'s own sentences are written for a reader — they name the file
    // and which half of it is missing — so there is nothing to translate.
    ircx_net::certificate_fingerprint(std::path::Path::new(&path))
        .map_err(|reason| reason.to_string())
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
    write_export(app.store(), &scope, &path)
}

/// The export without the Tauri state around it, so a test can aim it at a
/// destination that refuses the write. The sentences below are chosen by
/// `io::ErrorKind`, and a kind built by hand only ever proves the wording —
/// not that the kernel raises that kind here.
fn write_export(store: &Store, scope: &ArchiveScope, path: &str) -> Result<u64, String> {
    // Streamed rather than rendered into memory first: "Everything" on an old
    // archive is the whole archive.
    let file = std::fs::File::create(path).map_err(|error| unwritable(path, &error))?;
    let mut out = std::io::BufWriter::new(file);
    match scope {
        ArchiveScope::Conversation { network, target } => store
            .export_target(network, target, &mut out)
            .map_err(|error| gave_up(path, error))?,
        ArchiveScope::Everything => store
            .export_everything(&mut out)
            .map_err(|error| gave_up(path, error))?,
    }
    // An export short enough to fit in the buffer has not written anything yet,
    // so this is where its one write happens and where it fails. A longer one
    // empties the buffer as it goes and fails above instead. The two paths
    // report through different code and have to say the same thing; the
    // `a_full_disk_*` tests below hold them to it.
    let file = out
        .into_inner()
        .map_err(|error| unwritable(path, error.error()))?;
    file.metadata()
        .map(|meta| meta.len())
        .map_err(|error| unwritable(path, &error))
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

    use ircx_ipc::{
        ArchiveScope, ChatMessage, Delivery, EncryptionState, MessageKind, MessageSource, Sender,
    };
    use ircx_store::Store;

    use super::{gave_up, unwritable, write_export, StoreError};

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

    /// `BufWriter::new`'s capacity, which decides which of the two error paths
    /// a refused export takes. Not a guarantee std makes, so the two tests
    /// below check where they land rather than assuming it.
    const BUFFER: usize = 8 * 1024;

    fn archived(index: usize) -> ChatMessage {
        ChatMessage {
            id: format!("old-{index}"),
            network: "scripted".into(),
            target: "#measure".into(),
            kind: MessageKind::Privmsg,
            sender: Sender {
                nick: "talker".into(),
                user: None,
                host: None,
                account: None,
                is_self: false,
            },
            timestamp: format!("2026-01-01T00:00:{:02}Z", index % 60),
            timestamp_is_local: false,
            text: format!("something said a while ago, number {index}"),
            tags: Vec::new(),
            reply_to: None,
            batch: None,
            delivery: Delivery::Delivered,
            attachments: Vec::new(),
            encryption: EncryptionState::Plaintext,
            raw: String::new(),
            source: MessageSource::Live,
            via: None,
            id_is_local: false,
            reactions: Vec::new(),
            annotations: Vec::new(),
            raised_by: Vec::new(),
        }
    }

    fn stocked(messages: usize) -> Store {
        let store = Store::open_in_memory().expect("an archive");
        let held: Vec<ChatMessage> = (0..messages).map(archived).collect();
        store.append_messages(&held).expect("fill the archive");
        store
    }

    /// How much this archive exports to, which is what says whether the
    /// `BufWriter` empties while the export runs or only at the end of it.
    fn exported(store: &Store) -> usize {
        let mut out = Vec::new();
        store.export_everything(&mut out).expect("the export runs");
        out.len()
    }

    /// **A disk that is full raises `ENOSPC`, and nothing had ever checked that
    /// it arrives as `StorageFull`.** `docs/manual-verification.md` walked a
    /// destination that refuses the write with a `mkfifo` and got `BrokenPipe`,
    /// and said what that left: *"what is untested is only whether
    /// `StorageFull` arrives where it is expected to."* Every other test here
    /// builds the kind by hand and so can only prove the wording.
    ///
    /// `/dev/full` answers every write with `ENOSPC`. This is the export short
    /// enough that all of it is still in the buffer when the file is closed, so
    /// the first write of the run is also the last and it fails at
    /// `into_inner`.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_full_disk_refusing_the_last_write_says_the_disk_is_full() {
        let store = stocked(1);
        assert!(exported(&store) < BUFFER, "this export empties the buffer");

        let said = write_export(&store, &ArchiveScope::Everything, "/dev/full")
            .expect_err("a full disk cannot take the export");
        assert_eq!(said, "/dev/full could not be written: the disk is full");
    }

    /// The other half of the same fault, which is the one a real disk filling
    /// mid-export takes: the buffer empties while `export_everything` is still
    /// walking rows, so the error comes back through `gave_up` rather than
    /// `into_inner`. Both have to say the same thing.
    #[test]
    #[cfg(target_os = "linux")]
    fn a_full_disk_refusing_a_write_partway_says_the_same_thing() {
        let store = stocked(200);
        assert!(exported(&store) > BUFFER, "this export fits in the buffer");

        let said = write_export(&store, &ArchiveScope::Everything, "/dev/full")
            .expect_err("a full disk cannot take the export");
        assert_eq!(said, "/dev/full could not be written: the disk is full");
    }

    /// A disk that genuinely fills, which `/dev/full` is not: that refuses
    /// every byte, where a real one takes what fits and stops. What the two
    /// cannot both answer is what the failure leaves behind.
    ///
    /// `IRCX_SMALL_DISK` is a directory on a filesystem smaller than the export
    /// — a tmpfs in a user namespace needs no privileges:
    ///
    /// ```text
    /// unshare --user --map-root-user --mount sh -c '
    ///   mkdir -p /tmp/smallfs && mount -t tmpfs -o size=8M tmpfs /tmp/smallfs
    ///   IRCX_SMALL_DISK=/tmp/smallfs cargo test -p ircx --lib -- \
    ///     --ignored --nocapture a_disk_that_fills'
    /// ```
    #[test]
    #[ignore = "needs IRCX_SMALL_DISK on a filesystem smaller than the export"]
    #[cfg(target_os = "linux")]
    fn a_disk_that_fills_partway_through_an_export() {
        let room = std::env::var("IRCX_SMALL_DISK").expect("IRCX_SMALL_DISK names a small disk");
        let path = format!("{room}/export-everything.jsonl");
        let store = stocked(50_000);
        let wanted = exported(&store);

        let said = write_export(&store, &ArchiveScope::Everything, &path)
            .expect_err("the disk is too small to take the export");

        let left = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        println!();
        println!("  the export wanted {wanted} bytes");
        println!("  it said: {said}");
        println!("  it left {left} bytes at {path}");

        assert_eq!(
            said,
            format!("{path} could not be written: the disk is full")
        );
        assert!(left > 0, "nothing was written before it stopped");
        assert!(left < wanted as u64, "the whole export fitted after all");
    }
}
