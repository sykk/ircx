//! The status icon, and the one thing it has to say.
//!
//! A tray icon that never changes is a second way to reach a window the reader
//! can already reach. This one is here because closing the window no longer
//! ends the session: it is where ircx goes, and it has to be able to say that
//! somebody is waiting.
//!
//! What it says is the sidebar's own rule and not a second one. A network row
//! collapses to `attention`, which `SidebarNetworks` sums as the highlights on
//! its channels plus the unread on its queries — a channel only raises you by
//! name, a query is addressed to you by existing. The icon is marked exactly
//! when that total is not zero anywhere, so the tray and the sidebar cannot
//! disagree about whether anything is waiting.

use std::collections::HashMap;

use ircx_ipc::{IrcxEvent, NetworkId, TargetName};
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tracing::{debug, warn};

/// The id the tray is built under, so `AppHandle::tray_by_id` can find it again
/// from the event pump.
const TRAY_ID: &str = "ircx";

const SHOW: &str = "show";
const QUIT: &str = "quit";

/// The two states, as two files of one size.
///
/// `PLAIN` is a copy of `icons/64x64.png` rather than `default_window_icon()`,
/// which is the 32×32: the icon swapped resolution as well as image every time
/// the mark went on or off, and a panel scaling one of the pair differently
/// from the other is a wobble on every highlight. Walked on KDE 2026-08-26 —
/// the live file was 32×32 in one state and 64×64 in the other.
///
/// `MARKED` is that same image with a dot in the corner, in
/// `--badge-highlight-bg` from the default theme ringed in `--surface-base`. A
/// tray icon is outside the token system — it is a file the desktop draws, not
/// a component reading a variable — so the values are written down here rather
/// than resolved, and the sidebar's badge is where they came from.
const PLAIN: &[u8] = include_bytes!("../icons/tray-plain.png");
const MARKED: &[u8] = include_bytes!("../icons/tray-marked.png");

/// What is waiting, per conversation.
///
/// Kept as the counts rather than as one flag because the events that move it
/// each carry one conversation's total: a channel going quiet has to be able
/// to take its own contribution away without knowing about the others.
///
/// One map for channels and queries together. Their names cannot collide —
/// a channel's begins with a sigil no nickname may start with — and separating
/// them would only mean asking twice.
#[derive(Default)]
pub struct Attention {
    outstanding: HashMap<(NetworkId, TargetName), u32>,
}

impl Attention {
    /// Folds one event in. Returns whether the answer to `wanted` changed, so
    /// the caller can leave the icon alone on the overwhelming majority of
    /// events that move a count without crossing zero.
    pub fn apply(&mut self, event: &IrcxEvent) -> bool {
        let before = self.wanted();
        match event {
            IrcxEvent::ChannelUpdated { channel } => {
                self.set(&channel.network, &channel.name, channel.highlights);
            }
            IrcxEvent::QueryUpdated { query } => {
                self.set(&query.network, &query.nick, query.unread);
            }
            IrcxEvent::ChannelRemoved { network, name } => {
                self.outstanding.remove(&(network.clone(), name.clone()));
            }
            IrcxEvent::QueryRemoved { network, nick } => {
                self.outstanding.remove(&(network.clone(), nick.clone()));
            }
            // The `QueryUpdated` that follows names the new nick and puts back
            // whatever is still outstanding, so only the old name goes here.
            IrcxEvent::QueryRenamed { network, from, .. } => {
                self.outstanding.remove(&(network.clone(), from.clone()));
            }
            // No `ChannelRemoved` arrives for the conversations on a network
            // being forgotten, so they would sit here marking the icon for a
            // network that no longer exists.
            IrcxEvent::NetworkRemoved { network } => {
                self.outstanding.retain(|(on, _), _| on != network);
            }
            _ => {}
        }
        self.wanted() != before
    }

    fn set(&mut self, network: &NetworkId, target: &TargetName, count: u32) {
        let key = (network.clone(), target.clone());
        match count {
            0 => self.outstanding.remove(&key),
            _ => self.outstanding.insert(key, count),
        };
    }

    /// Whether anything is waiting to be read.
    pub fn wanted(&self) -> bool {
        !self.outstanding.is_empty()
    }
}

/// Builds the status icon, or returns `None` when the desktop has nowhere to
/// put one.
///
/// The `None` is load-bearing rather than defensive. A desktop with no
/// StatusNotifier host — GNOME without an extension is the common one — gives
/// no icon and no error the reader would see, and hiding the window to a tray
/// that is not there is a window nothing can bring back. Everything that hides
/// asks here first.
pub fn build(app: &AppHandle) -> Option<TrayIcon> {
    let show = MenuItem::with_id(app, SHOW, "Show ircx", true, None::<&str>).ok()?;
    let quit = MenuItem::with_id(app, QUIT, "Quit ircx", true, None::<&str>).ok()?;
    let menu = Menu::with_items(app, &[&show, &quit]).ok()?;

    let built = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(PLAIN).ok()?)
        .tooltip("ircx")
        .menu(&menu)
        // Windows and macOS only, both of them. On Linux the menu is the whole
        // interaction: `tray-icon` documents `with_menu_on_left_click` as
        // unsupported there and delivers no `TrayIconEvent` at all, because the
        // AppIndicator protocol the desktop speaks carries a menu and not
        // clicks. Walked on KDE 2026-08-26 — the registered item exposes
        // `SecondaryActivate` and `Scroll` and has no `Activate` method for a
        // left click to arrive on. So "Show ircx" in the menu is the way back
        // on Linux, and these two make left-click the shortcut elsewhere.
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu)
        .on_tray_icon_event(on_click)
        .build(app);

    match built {
        Ok(tray) => Some(tray),
        Err(error) => {
            warn!(%error, "no status icon: the desktop has nowhere to put one");
            None
        }
    }
}

/// Whether an icon was built. What everything that would hide the window asks
/// before hiding it.
pub fn available(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

/// Swaps the icon for the state the reader is in. Silent when there is no tray:
/// the caller is the event pump, which runs whether one was built or not.
pub fn mark(app: &AppHandle, wanted: bool) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let Ok(icon) = Image::from_bytes(if wanted { MARKED } else { PLAIN }) else {
        return;
    };
    if let Err(error) = tray.set_icon(Some(icon)) {
        debug!(%error, "the status icon would not take a new image");
    }
}

/// Brings the window back from wherever it went — hidden to the tray,
/// minimised, or behind everything else.
pub fn show(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id.as_ref() {
        SHOW => show(app),
        // The only way out once the close button stops being one. `RunEvent`
        // does the archive's shutdown on the way.
        QUIT => app.exit(0),
        _ => {}
    }
}

fn on_click(tray: &TrayIcon, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        show(tray.app_handle());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ircx_ipc::{Channel, Query};

    fn channel(name: &str, highlights: u32) -> IrcxEvent {
        IrcxEvent::ChannelUpdated {
            channel: Channel {
                network: "net".into(),
                name: name.into(),
                topic: None,
                modes: String::new(),
                joined: true,
                member_count: 1,
                unread: highlights + 3,
                highlights,
                muted: false,
            },
        }
    }

    fn query(nick: &str, unread: u32) -> IrcxEvent {
        IrcxEvent::QueryUpdated {
            query: Query {
                network: "net".into(),
                nick: nick.into(),
                account: None,
                unread,
                online: true,
                muted: false,
            },
        }
    }

    fn wanted_after(events: &[IrcxEvent]) -> bool {
        let mut attention = Attention::default();
        for event in events {
            attention.apply(event);
        }
        attention.wanted()
    }

    /// The distinction the sidebar draws: a channel raises you by name, so its
    /// unread count is not what the tray is about.
    #[test]
    fn a_busy_channel_that_never_named_you_leaves_the_icon_alone() {
        assert!(!wanted_after(&[channel("#ircx", 0)]));
    }

    #[test]
    fn a_highlight_marks_it_and_reading_the_channel_takes_the_mark_off() {
        let mut attention = Attention::default();

        assert!(attention.apply(&channel("#ircx", 1)));
        assert!(attention.wanted());
        assert!(attention.apply(&channel("#ircx", 0)));
        assert!(!attention.wanted());
    }

    /// A query is addressed to you by existing, so its plain unread counts.
    #[test]
    fn a_private_message_marks_it() {
        assert!(wanted_after(&[query("sable", 1)]));
    }

    /// The icon has one state, so only the first and last of a run are worth
    /// an image swap.
    #[test]
    fn only_crossing_zero_is_reported_as_a_change() {
        let mut attention = Attention::default();

        assert!(attention.apply(&channel("#ircx", 1)));
        assert!(!attention.apply(&channel("#ircx", 2)));
        assert!(!attention.apply(&channel("#rust", 5)));
        assert!(!attention.apply(&channel("#ircx", 0)));
        assert!(attention.apply(&channel("#rust", 0)));
    }

    #[test]
    fn one_conversation_going_quiet_leaves_the_others_marked() {
        assert!(wanted_after(&[
            channel("#ircx", 1),
            query("sable", 2),
            channel("#ircx", 0),
        ]));
    }

    #[test]
    fn a_closed_conversation_takes_its_mark_with_it() {
        assert!(!wanted_after(&[
            channel("#ircx", 4),
            IrcxEvent::ChannelRemoved {
                network: "net".into(),
                name: "#ircx".into(),
            },
        ]));
        assert!(!wanted_after(&[
            query("sable", 4),
            IrcxEvent::QueryRemoved {
                network: "net".into(),
                nick: "sable".into(),
            },
        ]));
    }

    /// Nothing announces the conversations on a removed network one by one, so
    /// a mark left behind would outlive the network that earned it.
    #[test]
    fn a_removed_network_takes_every_mark_on_it() {
        let mut attention = Attention::default();
        attention.apply(&channel("#ircx", 2));
        attention.apply(&query("sable", 1));

        assert!(attention.apply(&IrcxEvent::NetworkRemoved {
            network: "net".into(),
        }));
        assert!(!attention.wanted());
    }

    /// A rename is a move: the old name has to go, and the update that follows
    /// it puts whatever is still unread under the new one.
    #[test]
    fn a_renamed_query_keeps_its_mark_under_the_new_name() {
        let mut attention = Attention::default();
        attention.apply(&query("sable", 2));

        attention.apply(&IrcxEvent::QueryRenamed {
            network: "net".into(),
            from: "sable".into(),
            to: "basil".into(),
        });
        assert!(!attention.wanted());

        attention.apply(&query("basil", 2));
        assert!(attention.wanted());
    }
}
