//! Types crossing the Tauri boundary.
//!
//! `cargo test -p ircx-ipc` regenerates `src/types/generated/` for the frontend.
//! CI fails when the committed bindings drift from the Rust types.

pub mod command;
pub mod event;
pub mod model;

pub use command::*;
pub use event::*;
pub use model::*;

/// Stable across reconnects. Channel and message identity are scoped to one.
pub type NetworkId = String;

/// Channel name or query nick, cased as the server reported it.
pub type TargetName = String;
