use std::path::PathBuf;

use ircx_core::SessionCommand;
use ircx_ipc::{
    AppSnapshot, Attachment, ChatMessage, CommandOutcome, HistoryRequest, InstalledPlugin, Member,
    NetworkConfig, NetworkId, PluginGrants, PluginPermissionInfo, Query, SearchHit, SearchRequest,
    TargetName, ThemeSource,
};
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
pub async fn part_channel(
    app: State<'_, App>,
    network: NetworkId,
    channel: String,
    reason: Option<String>,
) -> Result<(), String> {
    app.tell(&network, SessionCommand::Part { channel, reason })
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
) -> Result<CommandOutcome, String> {
    app.ask(&network, |reply| SessionCommand::Submit {
        target,
        input,
        reply,
    })
    .await
}

#[tauri::command]
pub async fn send_raw(app: State<'_, App>, network: NetworkId, line: String) -> Result<(), String> {
    app.tell(&network, SessionCommand::Raw { line }).await
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

/// The only outbound request ircx makes that is not an IRC connection, and the
/// only one a user has to ask for by name.
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
    app.install_plugin(&PathBuf::from(source))
}

#[tauri::command]
pub async fn set_plugin_grants(
    app: State<'_, App>,
    plugin: String,
    grants: PluginGrants,
) -> Result<InstalledPlugin, String> {
    app.set_plugin_grants(&plugin, grants)
}

#[tauri::command]
pub async fn remove_plugin(app: State<'_, App>, plugin: String) -> Result<(), String> {
    app.remove_plugin(&plugin)
}
