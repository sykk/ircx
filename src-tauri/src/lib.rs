mod announce;
mod commands;
mod events;
mod preview;
mod sigv4;
mod state;
mod themes;
mod upload;

use std::sync::Arc;

use ircx_core::{network_for_plugins, PluginLimits, PluginRuntime};
use ircx_store::Store;
use state::App;
use tauri::{Manager, RunEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tokio::sync::mpsc;
use tracing::warn;

/// Room for a burst of history to queue while the pump is emitting. Core waits
/// on a full channel rather than dropping, so this only sets how far ahead a
/// connection may run.
const EVENT_QUEUE: usize = 4_096;

/// What the dev server said about itself, or why it could not be asked.
#[cfg(debug_assertions)]
#[derive(Debug)]
enum DevServer {
    /// Serving this checkout. The only answer that lets the window open.
    Ours,
    /// Answering, and serving something else — a second checkout on the same
    /// fixed port. The window would come up built from another working tree.
    Theirs(String),
    /// Nothing on the address at all.
    Silent,
    /// Answering but not saying which checkout, or not askable at all. A dev
    /// server older than this check says nothing about itself, and a check that
    /// could not run must not be the reason the client refuses to start.
    Unknown,
}

/// Asks the dev server which checkout it is serving.
///
/// A hostname does not parse as a `SocketAddr`, so it is resolved first — the
/// dev URL is a hostname, which is exactly the case that would otherwise answer
/// "cannot tell" and let the blank window through.
///
/// Only the response headers are read, and only far enough to find the one
/// `vite.config.ts` sets. Nothing here needs a body, so nothing here has to
/// know about transfer encodings.
#[cfg(debug_assertions)]
fn dev_server(url: &tauri::Url, root: &std::path::Path) -> DevServer {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};
    use std::time::Duration;

    const WAIT: Duration = Duration::from_millis(1500);
    let Some(host) = url.host_str() else {
        return DevServer::Unknown;
    };
    let authority = format!("{host}:{}", url.port().unwrap_or(80));
    let Ok(resolved) = authority.to_socket_addrs() else {
        return DevServer::Unknown;
    };
    let mut stream = match resolved
        .into_iter()
        .find_map(|address| TcpStream::connect_timeout(&address, WAIT).ok())
    {
        Some(stream) => stream,
        None => return DevServer::Silent,
    };
    let _ = stream.set_read_timeout(Some(WAIT));
    let request = format!("GET / HTTP/1.0\r\nHost: {authority}\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return DevServer::Unknown;
    }

    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    // Headers only: stop at the blank line, and never read more than a header
    // block's worth however the other end behaves.
    while head.len() < 16 * 1024 && !head.ends_with(b"\r\n\r\n") {
        match stream.read(&mut byte) {
            Ok(0) | Err(_) => break,
            Ok(_) => head.push(byte[0]),
        }
    }

    let head = String::from_utf8_lossy(&head);
    let named = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("x-ircx-root")
            .then(|| value.trim().to_string())
    });
    match named {
        None => DevServer::Unknown,
        Some(named) => match same_directory(named.as_ref(), root) {
            true => DevServer::Ours,
            false => DevServer::Theirs(named),
        },
    }
}

/// Compares two paths as directories, so a trailing separator or an unresolved
/// symlink does not read as a different checkout.
#[cfg(debug_assertions)]
fn same_directory(left: &std::path::Path, right: &std::path::Path) -> bool {
    let settle =
        |path: &std::path::Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    settle(left) == settle(right)
}

pub fn run() {
    let context = tauri::generate_context!();

    // A debug build loads the frontend from the dev server named in
    // `tauri.conf.json`, which is the one place that address is written down.
    #[cfg(debug_assertions)]
    if let Some(dev_url) = context.config().build.dev_url.as_ref() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .to_path_buf();
        match dev_server(dev_url, &root) {
            DevServer::Ours => {}
            DevServer::Silent => {
                eprintln!("ircx: nothing is listening on {dev_url}.");
                eprintln!(
                    "A debug build loads the frontend from the dev server, so the window would \
                     be blank."
                );
                eprintln!("Start it with: npm run tauri dev");
                std::process::exit(1);
            }
            DevServer::Theirs(theirs) => {
                eprintln!("ircx: {dev_url} is serving another checkout.");
                eprintln!("  it is serving: {theirs}");
                eprintln!("  this build is: {}", root.display());
                eprintln!(
                    "The window would come up built from that working tree, connect, and draw a \
                     conversation with none of your changes in it."
                );
                eprintln!(
                    "Stop that dev server, or give this checkout its own port in \
                     src-tauri/tauri.conf.json."
                );
                std::process::exit(1);
            }
            // Started rather than refused: the check not running is not
            // evidence of anything, and blocking on it would make a dev server
            // older than this change look like a broken build.
            DevServer::Unknown => {
                eprintln!("ircx: {dev_url} did not say which checkout it serves; starting anyway.");
            }
        }
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("IRCX_LOG")
                .unwrap_or_else(|_| "ircx=info".into()),
        )
        .init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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
            commands::load_history_around,
            commands::page_back,
            commands::search_history,
            commands::list_bookmarks,
            commands::set_bookmark,
            commands::set_bookmark_note,
            commands::mark_read,
            commands::set_typing,
            commands::load_preview,
            commands::get_draft,
            commands::set_draft,
            commands::list_themes,
            commands::install_theme,
            commands::themes_directory,
            commands::list_plugins,
            commands::plugin_permissions,
            commands::install_plugin,
            commands::set_plugin_grants,
            commands::remove_plugin,
            commands::archive_summary,
            commands::set_retention,
            commands::highlight_words,
            commands::set_highlight_words,
            commands::muted_conversations,
            commands::set_muted,
            commands::ignored_people,
            commands::set_ignored,
            commands::export_archive,
            commands::export_profile,
            commands::delete_archive,
            commands::announce,
            commands::certificate_fingerprint,
            commands::probe,
        ])
        .setup(|app| {
            let store = match open_store(app.handle()) {
                Ok(store) => Arc::new(store),
                Err(reason) => {
                    say_why_and_quit(app.handle(), reason.as_ref());
                    return Ok(());
                }
            };
            let (events, inbox) = mpsc::channel(EVENT_QUEUE);
            events::pump(app.handle().clone(), inbox);
            themes::watch(app.handle().clone());
            app.manage(App::new(store, events, open_plugins(app.handle())));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { handle.state::<App>().start().await });
            Ok(())
        })
        .build(context)
        .expect("tauri failed to start");

    app.run(|app, event| {
        if let RunEvent::ExitRequested { .. } = event {
            // A start that never opened an archive never managed one of these.
            // It is sitting on a dialog saying so, and reaching for state it
            // never had would panic on the way out.
            if let Some(app) = app.try_state::<App>() {
                tauri::async_runtime::block_on(app.shutdown());
            }
        }
    });
}

fn open_store(app: &tauri::AppHandle) -> Result<Store, Box<dyn std::error::Error>> {
    let directory = app.path().app_data_dir()?;
    std::fs::create_dir_all(&directory)?;
    Ok(Store::open(&directory.join("ircx.sqlite3"))?)
}

/// Says why the client cannot start, on screen and on stderr, and ends it once
/// the answer has been read.
///
/// An error returned from the setup hook panics inside Tauri's own `build`,
/// before any window exists. Walked on 2026-08-01 against a profile marked one
/// schema ahead: exit 101, and a sentence written for a person wrapped in
/// `panicked at ... note: run with RUST_BACKTRACE=1`.
///
/// Getting a dialog to appear this early took three attempts, and the two that
/// failed are why this one is shaped the way it is. `blocking_show` in setup
/// hangs with nothing drawn: setup runs before the event loop, and a dialog
/// with no loop to pump it never reaches the screen. Handing it to the loop
/// with a callback drew nothing either, as long as the window was closed
/// first — it is the only one, so closing it asks the loop to exit before the
/// dialog is up.
///
/// So the window is hidden rather than closed. The loop stays alive to draw the
/// dialog, and what it draws is not sitting in front of a client that cannot
/// reach its own backend.
///
/// stderr keeps its copy. A dialog is for the person at the machine and does
/// not survive into a log, and the launch that led here is one somebody may
/// well be reading a log about.
fn say_why_and_quit(app: &tauri::AppHandle, reason: &dyn std::error::Error) {
    eprintln!("ircx cannot open its archive.");
    eprintln!("  {reason}");
    eprintln!("Your history is still there and has not been changed.");
    eprintln!("Install the newer ircx to open it.");

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    app.dialog()
        .message(format!(
            "{reason}\n\nYour history is still there and has not been changed. \
             Install the newer ircx to open it."
        ))
        .title("ircx cannot open its archive")
        .kind(MessageDialogKind::Error)
        .show(|_| std::process::exit(1));
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
    use super::{dev_server, same_directory, DevServer};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};

    /// A dev server that names `root`, for one request. `None` is one that says
    /// nothing about itself, which is what an older one does.
    fn serving(root: Option<PathBuf>) -> (tauri::Url, std::thread::JoinHandle<()>) {
        let socket = TcpListener::bind("127.0.0.1:0").expect("a port to listen on");
        let port = socket.local_addr().expect("its address").port();
        let handle = std::thread::spawn(move || {
            let Ok((mut stream, _)) = socket.accept() else {
                return;
            };
            let mut scratch = [0u8; 1024];
            let _ = stream.read(&mut scratch);
            let header = match root {
                Some(root) => format!("x-ircx-root: {}\r\n", root.display()),
                None => String::new(),
            };
            let _ = stream.write_all(
                format!("HTTP/1.0 200 OK\r\n{header}Content-Length: 0\r\n\r\n").as_bytes(),
            );
        });
        let url = tauri::Url::parse(&format!("http://localhost:{port}/")).expect("a url");
        (url, handle)
    }

    /// #187. The check has to be right about the address the binary actually
    /// uses, and the dev URL is a hostname — the case that does not parse as a
    /// `SocketAddr` and would otherwise wave a blank window through.
    #[test]
    fn a_hostname_is_resolved_rather_than_waved_through() {
        let root = std::env::current_dir().expect("a working directory");
        let (url, server) = serving(Some(root.clone()));

        assert!(matches!(dev_server(&url, &root), DevServer::Ours));
        let _ = server.join();
    }

    #[test]
    fn a_port_with_nothing_behind_it_is_not_listening() {
        let socket = TcpListener::bind("127.0.0.1:0").expect("a port to listen on");
        let port = socket.local_addr().expect("its address").port();
        drop(socket);
        let url = tauri::Url::parse(&format!("http://localhost:{port}/")).expect("a url");

        assert!(matches!(
            dev_server(&url, Path::new(".")),
            DevServer::Silent
        ));
    }

    /// #233. The failure this was written for: a second checkout answering on
    /// the fixed port, which draws a whole convincing window from the wrong
    /// working tree.
    #[test]
    fn another_checkout_is_named_rather_than_served() {
        let (url, server) = serving(Some(PathBuf::from("/somewhere/else")));

        match dev_server(&url, Path::new(".")) {
            DevServer::Theirs(named) => assert_eq!(named, "/somewhere/else"),
            other => panic!("expected the other checkout to be named, got {other:?}"),
        }
        let _ = server.join();
    }

    /// Said rather than guessed: a check that cannot run must not be the reason
    /// the client refuses to start.
    #[test]
    fn a_server_that_says_nothing_about_itself_is_not_refused() {
        let (url, server) = serving(None);

        assert!(matches!(
            dev_server(&url, Path::new(".")),
            DevServer::Unknown
        ));
        let _ = server.join();
    }

    /// A trailing separator is how the dev server writes its root and not how
    /// `CARGO_MANIFEST_DIR` writes it, which would otherwise read as two
    /// different checkouts on every run.
    #[test]
    fn a_trailing_separator_is_the_same_directory() {
        let here = std::env::current_dir().expect("a working directory");
        let trailing = PathBuf::from(format!("{}/", here.display()));

        assert!(same_directory(&trailing, &here));
    }
}
