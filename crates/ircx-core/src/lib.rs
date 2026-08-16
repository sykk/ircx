//! Capability negotiation, SASL, session state, and command dispatch. Owns the
//! connection task per network and emits `ircx_ipc::IrcxEvent`.
//!
//! `SessionState` is where the protocol lives and it does no I/O: lines go in,
//! [`Action`]s come out. `spawn_network` is the only part that touches a
//! socket, which is what lets the state machine be driven by a script in a
//! test.
//!
//! Plugins hang off the same command path: a network spawned with a
//! [`PluginRuntime`] routes a slash command no built-in claims to the plugin
//! that owns it. Without one, nothing about plugins is built, started or paid
//! for.

mod archive;
mod caps;
mod casemap;
mod client;
mod dispatch;
mod history;
mod isupport;
mod message;
mod numeric;
pub mod plugins;
mod sasl;
mod scram;
mod session;
mod sts;
mod task;
mod text;

pub use caps::SUPPORTED as SUPPORTED_CAPS;
pub use casemap::CaseMapping;
pub use client::version_reply;
pub use isupport::ISupport;
pub use plugins::{
    chosen_grants, describe_permissions, describe_plugin, network_for_plugins, run_plugin, spoken,
    PluginCall,
};
pub use session::{
    Action, PageBack, Restored, SaslCredentials, SessionConfig, SessionState, SERVER_TARGET,
};
pub use task::{
    spawn_network, spawn_network_with_plugins, ArchiveWrites, NetworkHandle, SessionCommand,
};

/// The plugin system, re-exported so the application installs and grants
/// through the same types the session enforces against.
pub use ircx_plugin::{
    CommandSpec, Grants, Installed, LibraryError, Limits as PluginLimits, Manifest, Permission,
    PluginFailure, PluginRuntime,
};
