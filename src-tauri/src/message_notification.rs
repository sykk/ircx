use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

const OPENED: &str = "ircx://notification-opened";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Opened {
    network: String,
    target: String,
    message_id: String,
}

#[tauri::command]
pub async fn show_message_notification(
    app: AppHandle,
    title: String,
    body: String,
    network: String,
    target: String,
    message_id: String,
) -> Result<(), String> {
    let route = Opened {
        network,
        target,
        message_id,
    };
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let identifier = app.config().identifier.clone();
    let (reported, shown) = oneshot::channel();

    std::thread::spawn(move || {
        #[cfg(target_os = "macos")]
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &identifier
        });

        let mut notification = notify_rust::Notification::new();
        notification
            .summary(&title)
            .body(&body)
            .action("default", "Open")
            .auto_icon();
        #[cfg(target_os = "windows")]
        notification.app_id(&identifier);

        let handle = match notification.show() {
            Ok(handle) => handle,
            Err(error) => {
                let _ = reported.send(Err(error.to_string()));
                return;
            }
        };
        let _ = reported.send(Ok(()));
        handle.wait_for_action(|action| {
            if action != "default" {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit(OPENED, route);
        });
    });

    shown
        .await
        .map_err(|_| "The desktop notification service stopped before it answered.".to_string())?
        .map_err(|reason| format!("The desktop refused the notification: {reason}"))
}
