//! Saying something to a screen reader, which the page cannot do for itself.
//!
//! A live region in this window is correct in the accessibility tree and silent
//! in practice. WebKitGTK's AT-SPI backend has no case for a live region
//! changing, and the text signals it does send come out of the editing
//! pipeline — so what a person types into a control is reported and nothing the
//! page writes ever is. Orca compounds it: its live-region presenter answers
//! only to `object:text-changed:insert`, which is the one event that will never
//! arrive. `docs/manual-verification.md` has the measurements.
//!
//! The window is not subject to any of that. ATK carries an `announcement`
//! signal, the bridge relays it as `object:announcement`, and Orca speaks that
//! without consulting the live-region machinery at all.

/// Say `message` to whatever screen reader is listening.
///
/// Silence is the ordinary case, not a fault: most desktops run no
/// accessibility bus, and a message that goes unannounced is one the reader
/// sees on screen the way they already did. So there is nothing here a user
/// could act on, and nothing to report.
#[cfg(target_os = "linux")]
pub fn say(window: tauri::WebviewWindow, message: String) {
    use gtk::glib::subclass::SignalId;
    use gtk::prelude::*;

    // The accessible belongs to GTK's thread, and a command does not run on it.
    let speaking = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(gtk_window) = speaking.gtk_window() else {
            return;
        };
        let Some(accessible) = gtk_window.accessible() else {
            return;
        };
        // ATK grew this signal in 2.50. Asking for it by name rather than
        // emitting blind keeps an older one from taking the window down.
        let Some((signal, _)) = SignalId::parse_name("announcement", accessible.type_(), false)
        else {
            return;
        };
        accessible.emit_with_values(signal, &[message.to_value()]);
    });
}

/// Elsewhere the page's own live regions are heard, so there is nothing to do.
#[cfg(not(target_os = "linux"))]
pub fn say(_window: tauri::WebviewWindow, _message: String) {}
