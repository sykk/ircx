mod commands;
mod events;
mod preview;
mod state;
mod themes;
mod upload;

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

/// Where a debug build looks for the frontend. Tauri bakes `devUrl` into the
/// binary, so this is the address regardless of what `dist/` holds.
#[cfg(debug_assertions)]
const DEV_URL: &str = "http://localhost:5183";

/// Whether anything is listening on `host:port`.
///
/// A hostname does not parse as a `SocketAddr`, so it is resolved first — the
/// dev URL is `localhost:5183`, which is exactly the case that would otherwise
/// answer "cannot tell" and let the blank window through.
#[cfg(debug_assertions)]
fn listening(address: &str) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    let Ok(resolved) = address.to_socket_addrs() else {
        // Nothing this can check, so say nothing rather than refuse to start
        // over a check that did not run.
        return true;
    };
    resolved
        .into_iter()
        .any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(500)).is_ok())
}

pub fn run() {
    #[cfg(debug_assertions)]
    if !listening(DEV_URL.trim_start_matches("http://")) {
        eprintln!("ircx: nothing is listening on {DEV_URL}.");
        eprintln!(
            "A debug build loads the frontend from the dev server, so the window would be blank."
        );
        eprintln!("Start it with: npm run tauri dev");
        std::process::exit(1);
    }

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
            commands::get_upload_provider,
            commands::save_upload_provider,
            commands::remove_upload_provider,
            commands::describe_uploads,
            commands::upload_file,
            commands::remove_network,
            commands::connect_network,
            commands::disconnect_network,
            commands::join_channel,
            commands::open_query,
            commands::close_target,
            commands::submit_input,
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

#[cfg(all(test, debug_assertions))]
mod tests {
    use super::listening;
    use std::net::TcpListener;

    /// #187. The check has to be right about the address the binary actually
    /// uses, and `localhost:5183` is a hostname — the case that does not parse
    /// as a `SocketAddr` and would otherwise wave a blank window through.
    #[test]
    fn a_hostname_is_resolved_rather_than_waved_through() {
        let socket = TcpListener::bind("127.0.0.1:0").expect("a port to listen on");
        let port = socket.local_addr().expect("its address").port();

        assert!(listening(&format!("localhost:{port}")));
    }

    #[test]
    fn a_port_with_nothing_behind_it_is_not_listening() {
        let socket = TcpListener::bind("127.0.0.1:0").expect("a port to listen on");
        let port = socket.local_addr().expect("its address").port();
        drop(socket);

        assert!(!listening(&format!("localhost:{port}")));
    }

    /// Said rather than guessed: a check that cannot run must not be the reason
    /// the client refuses to start.
    #[test]
    fn an_address_that_cannot_be_resolved_does_not_stop_the_client() {
        assert!(listening("this is not an address"));
    }
}
