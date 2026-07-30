mod commands;
mod events;
mod state;

use std::sync::Arc;

use ircx_store::Store;
use state::App;
use tauri::{Manager, RunEvent};
use tokio::sync::mpsc;

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
        ])
        .setup(|app| {
            let store = Arc::new(open_store(app.handle())?);
            let (events, inbox) = mpsc::channel(EVENT_QUEUE);
            events::pump(app.handle().clone(), inbox);
            app.manage(App::new(store, events));

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
