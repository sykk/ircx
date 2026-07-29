//! Command parameters and return types.
//!
//! The `#[tauri::command]` handlers themselves live in `src-tauri`. Their
//! signatures, which the frontend binds against:
//!
//! ```text
//! get_snapshot()                              -> AppSnapshot
//! list_network_configs()                      -> Vec<NetworkConfig>
//! save_network(config: NetworkConfig)         -> NetworkId
//! remove_network(network: NetworkId)          -> ()
//! connect_network(network: NetworkId)         -> ()
//! disconnect_network(network, quit_message)   -> ()
//! join_channel(network, channel, key)         -> ()
//! part_channel(network, channel, reason)      -> ()
//! open_query(network, nick)                   -> Query
//! close_target(network, target)               -> ()
//! submit_input(network, target, input)        -> CommandOutcome
//! send_raw(network, line)                     -> ()
//! list_members(network, channel)              -> Vec<Member>
//! load_history(req: HistoryRequest)           -> Vec<ChatMessage>
//! search_history(req: SearchRequest)          -> Vec<SearchHit>
//! mark_read(network, target)                  -> ()
//! set_typing(network, target, active)         -> ()
//! load_preview(url)                           -> Attachment
//! get_draft(network, target)                  -> Option<String>
//! set_draft(network, target, text)            -> ()
//! ```
//!
//! Every handler returns `Result<T, String>`; the error string is user-facing.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{Channel, ChatMessage, Network, Query};
use crate::{NetworkId, TargetName};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    /// Absent when creating; set when updating an existing network.
    pub id: Option<NetworkId>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub tls: bool,
    /// Skipping verification is a per-network opt-in for self-signed servers.
    pub tls_verify: bool,
    pub nick: String,
    pub alt_nicks: Vec<String>,
    pub username: String,
    pub realname: String,
    pub sasl: Option<SaslConfig>,
    /// Sent verbatim after registration, one command per entry, no leading slash.
    pub connect_commands: Vec<String>,
    pub autojoin: Vec<String>,
    pub auto_connect: bool,
}

/// The password lives in the OS keyring, keyed by network id; it never crosses
/// this boundary on read.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SaslConfig {
    pub mechanism: SaslMechanism,
    pub account: String,
    /// Write-only: `Some` when the user sets it, always `None` when read back.
    pub password: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "SCREAMING-KEBAB-CASE")]
pub enum SaslMechanism {
    Plain,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRequest {
    pub network: NetworkId,
    pub target: TargetName,
    /// RFC 3339. Pages backwards from the oldest message already shown.
    pub before: Option<String>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    /// SQLite FTS5 syntax.
    pub query: String,
    pub network: Option<NetworkId>,
    pub target: Option<TargetName>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub message: ChatMessage,
    /// FTS5 snippet with `<mark>` around matches.
    pub snippet: String,
}

/// Result of dispatching composer input.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum CommandOutcome {
    /// Plain text, sent as PRIVMSG. Carries the optimistic local copy.
    Sent(ChatMessage),
    /// A slash command ran and produced nothing to render.
    Handled,
    /// A slash command produced output for the timeline.
    Output(String),
    /// Unknown command or bad arguments, phrased for the user.
    Rejected(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub networks: Vec<Network>,
    pub channels: Vec<Channel>,
    pub queries: Vec<Query>,
}
