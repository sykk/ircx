//! Sandboxed plugins.
//!
//! A plugin is JavaScript with a manifest. It runs in its own QuickJS runtime,
//! on its own thread, and reaches the client only through the host functions
//! its grants allow — there is no filesystem, no socket and no clock beyond
//! what `sandbox.rs` installs. A native subprocess would keep the user's own
//! filesystem and network access, so withholding a host function would not
//! enforce those grants.
//!
//! Custom slash commands, annotators, and notification rules are built. Message
//! renderers, link and attachment providers, and protocol adapters are outside
//! this milestone.
//!
//! What a broken plugin costs the host is asserted in `tests/failure_modes.rs`
//! rather than described: it panics, loops, allocates and backtracks, and the
//! host keeps running each time.

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

mod data;
pub mod library;
pub mod manifest;
pub mod net;
pub mod runtime;
pub mod sandbox;

pub use library::{Installed, Library, LibraryError};
pub use manifest::{CommandSpec, Grants, Manifest, ManifestError, Permission};
pub use net::{FetchRequest, Fetched, Fetcher};
pub use runtime::{Annotator, Notifier, PluginRuntime, Route};
pub use sandbox::Sandbox;

/// What the host allows a plugin to cost. Not the plugin's to declare: a
/// manifest that set its own deadline would be setting how long a misbehaving
/// plugin gets to misbehave.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Wall clock for one call, including anything a host function waits for.
    pub call: Duration,
    /// Bytes the QuickJS runtime may hold.
    pub memory: usize,
    /// How much longer than `call` the host waits before deciding a plugin is
    /// not coming back at all.
    pub grace: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // Room for a network request, because one host function makes one.
            call: Duration::from_millis(2_000),
            memory: 8 << 20,
            grace: Duration::from_millis(250),
        }
    }
}

/// A slash command the user typed, on its way to the plugin that owns it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandRequest {
    pub command: String,
    pub args: String,
    /// The conversation it was typed in.
    pub target: String,
    /// The user's own nickname on that network.
    pub nick: String,
    /// Recent messages in `target`, oldest first. Empty unless the plugin
    /// holds `read-messages` and `target` is one of its channels — the host
    /// does not read them otherwise, and the sandbox drops them if it did.
    #[serde(default)]
    pub messages: Vec<ContextMessage>,
}

/// A batch of messages that arrived in one conversation, handed to every
/// annotator that reaches it. One call per batch rather than per message: a
/// netsplit rejoin or a history backfill is hundreds of them, and calling once
/// each would multiply the call count by the channel's traffic.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotateRequest {
    pub target: String,
    pub messages: Vec<ArrivedMessage>,
}

/// Carries the id the note will be filed under, which `ContextMessage` has no
/// reason to: a command's history is read, not answered.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArrivedMessage {
    /// The message's id, as the host knows it. A note names one of these.
    pub id: String,
    pub nick: String,
    pub text: String,
    /// RFC 3339 UTC, as the archive holds it.
    pub time: String,
}

/// A batch of messages handed to every notification rule that reaches the
/// conversation. Separate from [`AnnotateRequest`] because the two hooks are
/// separate consents, and one type would let a change to either reach the
/// other.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotifyRequest {
    pub target: String,
    pub messages: Vec<ArrivedMessage>,
}

/// Which messages in the batch one rule thought worth interrupting the user
/// for, by [`ArrivedMessage::id`].
///
/// A rule raises and cannot lower: there is no field here for a message it
/// wants quiet, so nothing a plugin returns can hide a message the host
/// already raised, or one another rule did. That is the same constraint the
/// annotator holds as a type, said about attention rather than about text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotifyReply {
    pub raised: Vec<String>,
}

/// What one annotator said about one batch. A message the plugin passed over
/// is absent rather than present and empty.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AnnotateReply {
    pub notes: Vec<Note>,
}

/// Sanitised by the host, for the reason a command's `content` is: no
/// isolation mechanism makes returned text safe to display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    /// The `ArrivedMessage::id` this is about.
    pub message: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextMessage {
    pub nick: String,
    pub text: String,
    /// RFC 3339 UTC, as the archive holds it.
    pub time: String,
}

/// A message the plugin asked the host to send, already checked against
/// `send-messages` and the plugin's channels.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outgoing {
    pub target: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommandReply {
    /// What to show in the conversation. Needs `render-content`, and is
    /// sanitised by the host, because no isolation mechanism makes returned
    /// text safe to display.
    pub content: Option<String>,
    pub sends: Vec<Outgoing>,
}

/// Why a call produced no answer. Every one of these leaves the host running
/// and the plugin either dead or told no.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The plugin threw.
    Raised(String),
    /// The deadline passed and the runtime was interrupted.
    Timeout,
    /// The plugin asked for more memory than it is allowed.
    OutOfMemory,
    /// The plugin asked for something it was not granted.
    Denied(Permission),
    /// One command tried to send more messages than a command may.
    Flooded,
    /// Nothing came back at all, so the plugin's thread is parked somewhere
    /// the deadline cannot reach. It is abandoned rather than waited for.
    Unresponsive,
    /// The host could not load or run it: unreadable code, no runtime.
    Host(String),
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Raised(message) => write!(f, "failed: {message}"),
            Self::Timeout => write!(f, "took too long and was stopped"),
            Self::OutOfMemory => write!(f, "used more memory than it is allowed and was stopped"),
            Self::Denied(permission) => write!(
                f,
                "tried to {}, which you have not allowed",
                denied(*permission)
            ),
            Self::Flooded => write!(f, "tried to send more messages than one command may"),
            Self::Unresponsive => write!(f, "stopped responding and was disconnected"),
            Self::Host(why) => write!(f, "could not be run: {why}"),
        }
    }
}

/// The permission read back as the thing the plugin was doing, so the sentence
/// in `Failure` reads as one.
fn denied(permission: Permission) -> &'static str {
    match permission {
        Permission::ReadMessages => "read this conversation",
        Permission::SendMessages => "send a message",
        Permission::AddCommands => "add a command",
        Permission::StoreLocalData => "store data on this computer",
        Permission::AccessChannels => "act in this conversation",
        Permission::NetworkRequests => "fetch something from the internet",
        Permission::RenderContent => "show text in this conversation",
        Permission::AnnotateMessages => {
            "read messages as they arrive and note something beside them"
        }
        Permission::RaiseNotifications => {
            "read messages as they arrive and decide which are worth interrupting you for"
        }
    }
}

/// A failure with the plugin it belongs to. Errors reach the user, so they
/// name the plugin and what it did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginFailure {
    pub plugin: String,
    pub failure: Failure,
}

impl fmt::Display for PluginFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "The plugin \"{}\" {}", self.plugin, self.failure)
    }
}

impl std::error::Error for PluginFailure {}
