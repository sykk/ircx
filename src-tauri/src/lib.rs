mod commands;
mod events;
mod preview;
mod state;
mod themes;

use std::sync::Arc;

use ircx_core::{network_for_plugins, PluginLimits, PluginRuntime};
use ircx_store::Store;
use state::App;
use tauri::{Manager, RunEvent};
use tokio::sync::mpsc;
use tracing::warn;

/// Room for a burst of history to queue while the pump is emitting. Core waits
/// on a full channel rather than dropping, so this only sets how far ahead a
/// connection may run.
const EVENT_QUEUE: usize = 4_096;

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("IRCX_LOG")
                .unwrap_or_else(|_| "ircx=info".into()),
        )
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_snapshot,
            commands::list_network_configs,
            commands::save_network,
            commands::remove_network,
            commands::connect_network,
            commands::disconnect_network,
            commands::join_channel,
            commands::part_channel,
            commands::open_query,
            commands::close_target,
            commands::submit_input,
            commands::send_raw,
            commands::list_members,
            commands::load_history,
            commands::search_history,
            commands::mark_read,
            commands::set_typing,
            commands::load_preview,
            commands::get_draft,
            commands::set_draft,
            commands::list_themes,
            commands::list_plugins,
            commands::plugin_permissions,
            commands::install_plugin,
            commands::set_plugin_grants,
            commands::remove_plugin,
        ])
        .setup(|app| {
            let store = Arc::new(open_store(app.handle())?);
            let (events, inbox) = mpsc::channel(EVENT_QUEUE);
            events::pump(app.handle().clone(), inbox);
            themes::watch(app.handle().clone());
            app.manage(App::new(store, events, open_plugins(app.handle())));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { handle.state::<App>().start().await });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri failed to start");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            tauri::async_runtime::block_on(app.state::<App>().shutdown());
        }
    });
}

fn open_store(app: &tauri::AppHandle) -> Result<Store, Box<dyn std::error::Error>> {
    let directory = app.path().app_data_dir()?;
    std::fs::create_dir_all(&directory)?;
    Ok(Store::open(&directory.join("ircx.sqlite3"))?)
}

/// The plugin library, or nothing. One that cannot be opened costs the plugins
/// and nothing else: an unreadable folder is not a reason to lose the client.
///
/// The fetcher is built with a handle rather than taking one, because a plugin
/// granted `network-requests` calls from its own thread, which is not the async
/// runtime's and has no current handle.
fn open_plugins(app: &tauri::AppHandle) -> Option<Arc<PluginRuntime>> {
    let directory = app
        .path()
        .app_data_dir()
        .inspect_err(|error| warn!(%error, "could not find the data directory for plugins"))
        .ok()?;
    let fetch = network_for_plugins(tauri::async_runtime::handle().inner().clone());

    PluginRuntime::open(directory.join("plugins"), PluginLimits::default(), fetch)
        .inspect_err(|error| warn!(%error, "starting without plugins"))
        .ok()
        .map(Arc::new)
}
