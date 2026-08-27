use std::path::{Path, PathBuf};

use ircx_core::SessionCommand;
use ircx_ipc::{
    AppSnapshot, ArchiveScope, ArchiveSummary, Attachment, ChatMessage, CommandOutcome,
    FileToUpload, HistoryRequest, IgnoredPerson, InstalledPlugin, Member, MutedConversation,
    NetworkConfig, NetworkId, PageBackOutcome, PluginGrants, PluginPermissionInfo, Query,
    SaslConfig, SaslMechanism, SearchHit, SearchRequest, TargetName, ThemeSource, Transfer,
    TransferSettings, TraySettings, UploadProvider, UploadedFile, WatchedPerson,
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

/// Saves it, or says why it would not work. A provider that needs a credential
/// and has none is refused here rather than at the first upload, which is where
/// it used to surface.
#[tauri::command]
pub async fn save_upload_provider(
    app: State<'_, App>,
    provider: UploadProvider,
) -> Result<(), String> {
    let store = app.store();
    let stored = store.upload_provider().map_err(describe)?;
    if let Some(why) = crate::upload::refuse_save(&provider, crate::upload::saved(stored.as_ref()))
    {
        return Err(why);
    }
    store.save_upload_provider(&provider).map_err(describe)
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
pub async fn register_libera_account(
    app: State<'_, App>,
    network: NetworkId,
    account: String,
    password: String,
    email: String,
) -> Result<(), String> {
    let mut config = app
        .store()
        .list_networks()
        .map_err(describe)?
        .into_iter()
        .find(|config| config.id.as_ref() == Some(&network))
        .ok_or_else(|| "That network is no longer configured — add it again".to_string())?;
    validate_libera_registration(&config, &account, &password, &email)?;

    app.ask(&network, |reply| SessionCommand::RegisterLibera {
        account: account.clone(),
        password: password.clone(),
        email,
        reply,
    })
    .await??;

    config.sasl = Some(SaslConfig {
        mechanism: SaslMechanism::Plain,
        account,
        password: Some(password),
    });
    app.save_network(config).await.map(|_| ()).map_err(|error| {
        format!(
            "Registration was sent, but the SASL password could not be saved: {error}. Save it in this network's settings before reconnecting."
        )
    })
}

fn validate_libera_registration(
    config: &NetworkConfig,
    account: &str,
    password: &str,
    email: &str,
) -> Result<(), String> {
    let host = config.host.trim_end_matches('.').to_ascii_lowercase();
    if host != "libera.chat" && !host.ends_with(".libera.chat") {
        return Err(format!(
            "{} is not a Libera.Chat server — choose the Libera.Chat network",
            config.host
        ));
    }
    if !config.tls || !config.tls_verify {
        return Err(
            "Libera.Chat registration needs verified TLS — enable TLS and certificate verification first"
                .into(),
        );
    }
    if account.trim().is_empty() {
        return Err("Enter the Libera.Chat nick to register".into());
    }
    if password.is_empty() {
        return Err("Enter a password for the Libera.Chat account".into());
    }
    if password.chars().any(char::is_whitespace) {
        return Err(
            "The Libera.Chat password cannot contain spaces — choose another password".into(),
        );
    }
    if !email.contains('@') || email.chars().any(char::is_whitespace) {
        return Err("Enter a complete email address without spaces".into());
    }
    Ok(())
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
    app.close_target(&network, &target).await
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
pub async fn load_history_around(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
    message_id: String,
    limit: u32,
) -> Result<Vec<ChatMessage>, String> {
    app.store()
        .load_history_around(&network, &target, &message_id, limit)
        .map_err(describe)
}

/// The page behind what the archive holds, from the server. Answers whether
/// another may be behind it, or that the server has not said yet; the messages
/// arrive as `messagesAppended` on their way through the archive, the same as
/// any other history.
///
/// `ask` is the caller's own name for this request, and comes back on the batch
/// that answers it. The answer outlives the deadline this waits on — a reader
/// who gave up and asked again has two of these outstanding, and only the batch
/// says which is which (#540).
#[tauri::command]
pub async fn page_back(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
    from: String,
    msgid: Option<String>,
    ask: String,
) -> Result<PageBackOutcome, String> {
    let answer = app
        .ask_server(&network, |reply| SessionCommand::PageBack {
            target,
            from,
            msgid,
            ask,
            reply,
        })
        .await?;
    // The session says which of the three answers it is; `None` is the round
    // trip's own deadline expiring, which is the one it cannot say.
    Ok(answer.unwrap_or(PageBackOutcome::Waiting))
}

#[tauri::command]
pub async fn search_history(
    app: State<'_, App>,
    req: SearchRequest,
) -> Result<Vec<SearchHit>, String> {
    app.store().search(&req).map_err(describe)
}

#[tauri::command]
pub async fn list_bookmarks(
    app: State<'_, App>,
    network: Option<NetworkId>,
    target: Option<TargetName>,
    limit: u32,
) -> Result<Vec<SearchHit>, String> {
    app.store()
        .bookmarks(network.as_deref(), target.as_deref(), limit)
        .map_err(describe)
}

#[tauri::command]
pub async fn set_bookmark(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
    message_id: String,
    active: bool,
) -> Result<(), String> {
    if app
        .store()
        .set_bookmark(&network, &target, &message_id, active)
        .map_err(describe)?
    {
        Ok(())
    } else {
        Err("That message is no longer in local history.".into())
    }
}

#[tauri::command]
pub async fn set_bookmark_note(
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
    message_id: String,
    note: String,
) -> Result<(), String> {
    if app
        .store()
        .set_bookmark_note(&network, &target, &message_id, note.trim())
        .map_err(describe)?
    {
        Ok(())
    } else {
        Err("That bookmark is no longer in local history.".into())
    }
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

/// What the inspector asks when it is opened on somebody whose real name is not
/// known. Silent like `set_typing`: the answer arrives as a `MemberUpdated`,
/// and a reader who is looking at a panel did not ask to read a whois.
#[tauri::command]
pub async fn look_up_member(
    app: State<'_, App>,
    network: NetworkId,
    nick: String,
) -> Result<(), String> {
    app.tell_if_connected(&network, SessionCommand::LookUp { nick })
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

/// Appends the window's instrument lines to the file `IRCX_PROBE` names.
///
/// The one command in this file whose error is not written for a user: nothing
/// user-facing reaches it. `src/lib/probe.ts` is compiled out of a build that
/// did not ask for it, so in the app anybody runs this is never called, and a
/// build that does ask and is run without the variable gets the refusal below
/// once and stops.
///
/// A file rather than stdout because WebKitGTK writes no console message
/// anywhere this process can see: `enable-write-console-messages-to-stdout` is
/// off and wry never turns it on, so a release window has no other way to say
/// anything. #508.
#[tauri::command]
pub async fn probe(lines: Vec<String>) -> Result<(), String> {
    let path = std::env::var("IRCX_PROBE").map_err(|_| "IRCX_PROBE names no file".to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|reason| format!("{path}: {reason}"))?;
    let mut out = String::new();
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    std::io::Write::write_all(&mut file, out.as_bytes())
        .map_err(|reason| format!("{path}: {reason}"))
}

/// The themes directory, read whole. Themes install by being copied in, so
/// there is nothing to register and nothing to keep in sync.
#[tauri::command]
pub async fn list_themes(app: tauri::AppHandle) -> Result<Vec<ThemeSource>, String> {
    let directory = crate::themes::directory(&app)?;
    crate::themes::read(&directory)
}

/// `source` is the folder the user picked, holding the author's `theme.json`
/// and `theme.css`. Answers with the id it installed under, which the window
/// then selects; the directory watcher is what puts it in the list.
#[tauri::command]
pub async fn install_theme(app: tauri::AppHandle, source: String) -> Result<String, String> {
    let directory = crate::themes::directory(&app)?;
    crate::themes::install(&directory, std::path::Path::new(&source))
}

/// Where themes live, so the window can offer to open it. A path rather than
/// the opening itself: the frontend already reaches the opener plugin for
/// everything else it shows somebody.
#[tauri::command]
pub async fn themes_directory(app: tauri::AppHandle) -> Result<String, String> {
    Ok(crate::themes::directory(&app)?
        .to_string_lossy()
        .into_owned())
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

/// The words that raise a conversation beside the reader's nickname.
#[tauri::command]
pub async fn highlight_words(app: State<'_, App>) -> Result<Vec<String>, String> {
    app.store().highlight_words().map_err(describe)
}

/// Replaces the list, and tells every connected network so the change counts
/// from the next message rather than the next launch.
#[tauri::command]
pub async fn set_highlight_words(app: State<'_, App>, words: Vec<String>) -> Result<(), String> {
    app.set_highlight_words(words).await
}

/// The names whose lines never raise the reader — the inverse of the words
/// above, and stored beside them.
#[tauri::command]
pub async fn hushed_nicks(app: State<'_, App>) -> Result<Vec<String>, String> {
    app.store().hushed_nicks().map_err(describe)
}

#[tauri::command]
pub async fn set_hushed_nicks(app: State<'_, App>, nicks: Vec<String>) -> Result<(), String> {
    app.set_hushed_nicks(nicks).await
}

/// Everything the reader has muted, with the network named.
#[tauri::command]
pub async fn muted_conversations(app: State<'_, App>) -> Result<Vec<MutedConversation>, String> {
    let rows = app.store().muted_conversations().map_err(describe)?;
    Ok(rows
        .into_iter()
        .map(|(network, network_name, target)| MutedConversation {
            network,
            network_name,
            target,
        })
        .collect())
}

/// Mutes a conversation, or the whole network when `target` is `None`.
#[tauri::command]
pub async fn set_muted(
    app: State<'_, App>,
    network: NetworkId,
    target: Option<TargetName>,
    muted: bool,
) -> Result<(), String> {
    app.set_muted(&network, target.as_ref(), muted).await
}

/// Everybody the reader has ignored, with the network named.
#[tauri::command]
pub async fn ignored_people(app: State<'_, App>) -> Result<Vec<IgnoredPerson>, String> {
    let rows = app.store().ignored_people().map_err(describe)?;
    Ok(rows
        .into_iter()
        .map(|(network, network_name, nick)| IgnoredPerson {
            network,
            network_name,
            nick,
        })
        .collect())
}

/// Starts or stops ignoring somebody on one network.
#[tauri::command]
pub async fn set_ignored(
    app: State<'_, App>,
    network: NetworkId,
    nick: String,
    ignored: bool,
) -> Result<(), String> {
    app.set_ignored(&network, &nick, ignored).await
}

#[tauri::command]
pub async fn watched_people(app: State<'_, App>) -> Result<Vec<WatchedPerson>, String> {
    let rows = app.store().watched_people().map_err(describe)?;
    Ok(rows
        .into_iter()
        .map(|(network, network_name, nick)| WatchedPerson {
            network,
            network_name,
            nick,
        })
        .collect())
}

#[tauri::command]
pub async fn set_watched(
    app: State<'_, App>,
    network: NetworkId,
    nick: String,
    watched: bool,
) -> Result<(), String> {
    app.set_watched(&network, &nick, watched).await
}

/// Where received files land and what this client can say about reaching it.
/// Absent from the store until a page changes something, because the default
/// download directory is the operating system's answer rather than a value.
#[tauri::command]
pub async fn transfer_settings(
    handle: tauri::AppHandle,
    app: State<'_, App>,
) -> Result<TransferSettings, String> {
    crate::transfers::settings(&handle, app.store())
}

#[tauri::command]
pub async fn set_transfer_settings(
    app: State<'_, App>,
    settings: TransferSettings,
) -> Result<(), String> {
    if let Some(why) = crate::transfers::refuse_save(&settings) {
        return Err(why);
    }
    app.store()
        .save_transfer_settings(&settings)
        .map_err(describe)
}

/// What the close button does, and whether the desktop gave this client an
/// icon for it to do it to.
///
/// `available` is asked of the tray itself rather than remembered, because it
/// is a fact about this session: the same profile on a desktop with no
/// StatusNotifier host gets no icon, and a page that promised one would be
/// offering to hide the window somewhere nothing could bring it back from.
#[tauri::command]
pub async fn tray_settings(
    handle: tauri::AppHandle,
    app: State<'_, App>,
) -> Result<TraySettings, String> {
    Ok(TraySettings {
        close_to_tray: app.close_to_tray(),
        available: crate::tray::available(&handle),
    })
}

#[tauri::command]
pub async fn set_close_to_tray(app: State<'_, App>, hide: bool) -> Result<(), String> {
    app.set_close_to_tray(hide)
}

/// Every network's transfers. What a window that has just been reloaded reads
/// to catch up; everything after that arrives as events.
#[tauri::command]
pub async fn list_transfers(app: State<'_, App>) -> Result<Vec<Transfer>, String> {
    Ok(app.transfers().await)
}

/// Offers a file to one person. Answers with the transfer, which is waiting
/// for them to accept — nothing has been read off the disk yet.
#[tauri::command]
pub async fn offer_file(
    handle: tauri::AppHandle,
    app: State<'_, App>,
    network: NetworkId,
    target: TargetName,
    path: String,
) -> Result<Transfer, String> {
    let path = PathBuf::from(path);
    let (file, size) = crate::transfers::describe_file(&path).await?;
    let settings = crate::transfers::settings(&handle, app.store())?;
    let (host, port) = app.endpoint(&network)?;
    let address = crate::transfers::advertised(&settings, &host, port).await?;

    app.ask(&network, |reply| SessionCommand::OfferFile {
        nick: target,
        path,
        file,
        size,
        ports: settings.ports,
        address,
        passive: settings.passive,
        reply,
    })
    .await?
}

/// Takes an offer. `path` is a name the user chose in a save dialog; without
/// one the file lands in the download directory under the name it was offered
/// as, numbered if that name is taken.
#[tauri::command]
pub async fn accept_transfer(
    handle: tauri::AppHandle,
    app: State<'_, App>,
    network: NetworkId,
    id: String,
    path: Option<String>,
) -> Result<(), String> {
    let offered = app
        .transfers()
        .await
        .into_iter()
        .find(|transfer| transfer.id == id)
        .ok_or("That transfer is no longer waiting to be accepted")?;

    let settings = crate::transfers::settings(&handle, app.store())?;
    let (landing, resume_from) = match path {
        Some(path) => crate::transfers::chosen(&path, offered.size).await,
        None => {
            crate::transfers::landing(Path::new(&settings.directory), &offered.file, offered.size)
                .await?
        }
    };
    let (host, port) = app.endpoint(&network)?;
    let address = crate::transfers::advertised(&settings, &host, port).await?;

    app.ask(&network, |reply| SessionCommand::AcceptTransfer {
        id,
        path: landing,
        resume_from,
        ports: settings.ports,
        address,
        reply,
    })
    .await?
}

#[tauri::command]
pub async fn decline_transfer(
    app: State<'_, App>,
    network: NetworkId,
    id: String,
) -> Result<(), String> {
    app.tell(&network, SessionCommand::DeclineTransfer { id })
        .await
}

#[tauri::command]
pub async fn cancel_transfer(
    app: State<'_, App>,
    network: NetworkId,
    id: String,
) -> Result<(), String> {
    app.tell(&network, SessionCommand::CancelTransfer { id })
        .await
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

/// Writes a profile the window has already rendered, and answers with its size
/// for the same reason `export_archive` does. The JSON is built in the frontend,
/// where most of what it describes is kept; only the write needs a process that
/// can reach the path the save dialog gave back.
#[tauri::command]
pub async fn export_profile(path: String, contents: String) -> Result<u64, String> {
    std::fs::write(&path, contents.as_bytes()).map_err(|error| unwritable(&path, &error))?;
    Ok(contents.len() as u64)
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
        ArchiveScope::Network { network } => store
            .export_network(network, &mut out)
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
        .map_err(|error| stopped(path, error.error()))?;
    // Everything is written by the time this runs, so a failure to stat is not
    // an export that stopped and must not be described as one.
    file.metadata()
        .map(|meta| meta.len())
        .map_err(|error| unwritable(path, &error))
}

/// Which file would not take the export, and why.
fn unwritable(path: &str, error: &std::io::Error) -> String {
    // Windows answers `File::create` on a directory with `PermissionDenied`
    // rather than `IsADirectory`. The path is what the user picked, so name
    // what it is instead of sending them looking for a permission they lack.
    let reason = if std::path::Path::new(path).is_dir() {
        in_words(&std::io::Error::from(std::io::ErrorKind::IsADirectory))
    } else {
        in_words(error)
    };
    format!("{path} could not be written: {reason}")
}

/// The same, once the file is open and part of the export may be in it.
///
/// "Could not be written" over a file holding a third of the archive sends
/// somebody looking for nothing, while it takes up the room they need to try
/// again — which on a full disk is the room the export itself just used. So a
/// destination with bytes in it is described as what it is.
///
/// Nothing here removes the file. JSON Lines truncates cleanly, so what arrived
/// is readable to the last newline, and on a disk with no room it may be the
/// only part of the archive that got out. Deleting it would also put a second
/// thing that can fail inside the handling of the first.
///
/// **Decided by how far the export got, not by what is on disk.** A file that
/// already existed and was refused has bytes in it too, and they are somebody
/// else's rather than this export's — so only the failures after `File::create`
/// come through here.
fn stopped(path: &str, error: &std::io::Error) -> String {
    match std::fs::metadata(path).map(|meta| meta.len()) {
        Ok(bytes) if bytes > 0 => {
            format!("{path} was left part-written: {}", in_words(error))
        }
        _ => unwritable(path, error),
    }
}

/// An export that stops partway stopped for one of two reasons, and only one of
/// them is about the file. The store raises `Io` without knowing which file it
/// was handed a writer for, so the path is put back here; anything else is the
/// archive failing and has nothing to do with where it was going.
fn gave_up(path: &str, error: StoreError) -> String {
    match error {
        StoreError::Io(io) => stopped(path, &io),
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
        ArchiveScope::Network { network } => {
            store.delete_network_archive(network).map_err(describe)
        }
        ArchiveScope::Everything => store.delete_everything().map_err(describe),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Error, ErrorKind};

    use ircx_ipc::{
        ArchiveScope, ChatMessage, Delivery, EncryptionState, MessageKind, MessageSource,
        NetworkConfig, Sender,
    };
    use ircx_store::Store;

    use super::{
        gave_up, stopped, unwritable, validate_libera_registration, write_export, StoreError,
    };

    fn libera() -> NetworkConfig {
        NetworkConfig {
            id: Some("libera".into()),
            name: "Libera.Chat".into(),
            host: "irc.libera.chat".into(),
            port: 6697,
            tls: true,
            tls_verify: true,
            socks5_proxy: None,
            client_certificate: None,
            nick: "sable".into(),
            alt_nicks: Vec::new(),
            username: "sable".into(),
            realname: "sable".into(),
            sasl: None,
            connect_commands: Vec::new(),
            autojoin: Vec::new(),
            auto_connect: true,
            quit_message: None,
            part_message: None,
            away_message: None,
        }
    }

    #[test]
    fn guided_registration_requires_verified_tls_to_libera() {
        let mut config = libera();
        assert!(validate_libera_registration(
            &config,
            "sable",
            "correct-horse",
            "private@example.com"
        )
        .is_ok());

        config.tls_verify = false;
        assert!(validate_libera_registration(
            &config,
            "sable",
            "correct-horse",
            "private@example.com"
        )
        .unwrap_err()
        .contains("verified TLS"));

        config = libera();
        config.host = "irc.example.com".into();
        assert!(validate_libera_registration(
            &config,
            "sable",
            "correct-horse",
            "private@example.com"
        )
        .unwrap_err()
        .contains("not a Libera.Chat server"));
    }

    #[test]
    fn guided_registration_rejects_values_nickserv_cannot_parse() {
        let config = libera();

        assert!(
            validate_libera_registration(&config, "sable", "two words", "private@example.com")
                .unwrap_err()
                .contains("cannot contain spaces")
        );
        assert!(
            validate_libera_registration(&config, "sable", "correct-horse", "not-an-email")
                .unwrap_err()
                .contains("complete email address")
        );
    }

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

    /// A disk that is full raises `ENOSPC`; this asserts it arrives as
    /// `StorageFull` rather than proving only the wording from a constructed
    /// error kind.
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
            format!("{path} was left part-written: the disk is full")
        );
        assert!(left > 0, "nothing was written before it stopped");
        assert!(left < wanted as u64, "the whole export fitted after all");
    }

    /// The sentence above needs a disk that fills to reach it, and this reaches
    /// the same branch without one: a destination that already holds bytes when
    /// the export gives up.
    #[test]
    fn a_destination_holding_part_of_the_export_says_so() {
        let room = tempfile::tempdir().expect("a temp directory");
        let half = room.path().join("export-everything.jsonl");
        std::fs::write(&half, b"{\"id\":\"the part that got there\"}\n").expect("a partial export");

        let said = stopped(
            half.to_str().expect("a path"),
            &Error::from(ErrorKind::StorageFull),
        );

        assert_eq!(
            said,
            format!("{} was left part-written: the disk is full", half.display())
        );
    }

    /// Nothing arrived, so there is nothing to go and look at. An empty file is
    /// the `mkfifo` walk's case — the pipe exists and holds nothing — and a
    /// missing one is a destination that was never opened.
    #[test]
    fn a_destination_holding_nothing_says_it_could_not_be_written() {
        let room = tempfile::tempdir().expect("a temp directory");
        let empty = room.path().join("export-everything.jsonl");
        std::fs::write(&empty, b"").expect("an empty file");
        let missing = room.path().join("never-opened.jsonl");

        for path in [&empty, &missing] {
            let said = stopped(
                path.to_str().expect("a path"),
                &Error::from(ErrorKind::StorageFull),
            );
            assert_eq!(
                said,
                format!("{} could not be written: the disk is full", path.display())
            );
        }
    }

    /// **The frame is decided by how far the export got, not by what is on
    /// disk.** A folder has a size, and so does a file that already existed and
    /// was refused — in both the bytes are somebody else's. Deciding by the
    /// destination alone would report this one as part-written and send the
    /// reader looking for an export inside their own directory.
    #[test]
    fn a_refused_destination_that_already_had_bytes_is_not_part_written() {
        let room = tempfile::tempdir().expect("a temp directory");

        let said = write_export(
            &stocked(1),
            &ArchiveScope::Everything,
            room.path().to_str().expect("a path"),
        )
        .expect_err("a folder cannot take the export");

        assert!(
            said.ends_with("that is a folder, not a file"),
            "said {said}"
        );
        assert!(!said.contains("part-written"), "said {said}");
    }
}
