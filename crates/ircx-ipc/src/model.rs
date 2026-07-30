use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::{NetworkId, TargetName};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    /// IRCv3 `msgid` when the server sends one, otherwise a local UUID.
    pub id: String,
    /// Whether `id` was minted here. A server msgid is the same string on
    /// every client and survives a replay; a local one identifies the message
    /// only within this archive.
    pub id_is_local: bool,
    pub network: NetworkId,
    pub target: TargetName,
    pub kind: MessageKind,
    pub sender: Sender,
    /// RFC 3339 UTC. From the `server-time` tag when negotiated, else receipt time.
    pub timestamp: String,
    pub timestamp_is_local: bool,
    pub text: String,
    /// Unescaped tag values, kept whole so plugins reach what the parser dropped.
    pub tags: Vec<(String, Option<String>)>,
    pub reply_to: Option<String>,
    pub batch: Option<String>,
    pub delivery: Delivery,
    /// Reactions against this message's `msgid`, oldest first. Anything
    /// archived or exported before reactions existed has no such field, which
    /// is why it defaults rather than being required.
    #[serde(default)]
    #[ts(as = "Option<Vec<Reaction>>", optional)]
    pub reactions: Vec<Reaction>,
    pub attachments: Vec<Attachment>,
    /// Always `Plaintext` this milestone; the field is the extension point.
    pub encryption: EncryptionState,
    pub raw: String,
    pub source: MessageSource,
    /// The plugin that produced this message, by its id. `None` for everything
    /// the client or the server said, which is almost everything — a plugin's
    /// answer is the only text in a conversation that came from neither.
    pub via: Option<String>,
}

/// One `+draft/react` value and everyone who sent it. The readability studies
/// ask for names rather than counts, so the nicks travel and a count is
/// whatever the frontend makes of their number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    /// The tag's value. Emoji in practice; the specification puts no
    /// restriction on it, so `lol` and `:)` are as valid as `👋`.
    pub emoji: String,
    /// Oldest first, cased as each reactor's nick was at the time.
    pub nicks: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum MessageKind {
    Privmsg,
    Notice,
    Action,
    Join,
    Part,
    Quit,
    Kick,
    Nick,
    Topic,
    Mode,
    /// Numerics and other server chatter.
    Server,
    /// Client-generated: connection state, command errors, plugin output.
    Client,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Sender {
    pub nick: String,
    pub user: Option<String>,
    pub host: Option<String>,
    /// Services account. A verified identity, unlike the nick.
    pub account: Option<String>,
    pub is_self: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state",
    content = "detail"
)]
pub enum Delivery {
    Pending,
    /// Written to the socket. Without `echo-message` this is the terminal state.
    Sent,
    Delivered,
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum MessageSource {
    Live,
    ServerHistory,
    LocalArchive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum EncryptionState {
    Plaintext,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub url: String,
    pub filename: Option<String>,
    pub mime: Option<String>,
    pub size_bytes: Option<u64>,
    /// `None` until the user asks for it; the client never fetches unprompted.
    pub preview: Option<AttachmentPreview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreview {
    /// `data:` URI, held in memory so it does not outlive the session on disk.
    pub data_uri: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub id: NetworkId,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub status: ConnectionStatus,
    /// May differ from the configured nick after a collision.
    pub current_nick: Option<String>,
    pub sasl: SaslStatus,
    pub caps_enabled: Vec<String>,
    pub lag_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state",
    content = "detail"
)]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    /// TLS is up, registration still in flight.
    Registering,
    Connected,
    Reconnecting {
        in_seconds: u32,
    },
    /// `message` is written for a human, not a log.
    Failed {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "state",
    content = "detail"
)]
pub enum SaslStatus {
    NotConfigured,
    InProgress,
    Authenticated { account: String },
    Failed { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub network: NetworkId,
    pub name: TargetName,
    pub topic: Option<Topic>,
    pub modes: String,
    pub joined: bool,
    pub member_count: u32,
    pub unread: u32,
    pub highlights: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub text: String,
    pub set_by: Option<String>,
    pub set_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub nick: String,
    pub account: Option<String>,
    /// Highest first. Only complete when `multi-prefix` is negotiated.
    pub prefixes: Vec<String>,
    pub away: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pub network: NetworkId,
    pub nick: TargetName,
    pub account: Option<String>,
    pub unread: u32,
    pub online: bool,
}
