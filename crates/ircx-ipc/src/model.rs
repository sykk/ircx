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
    /// What plugins said *about* this message, which is not what `via` says:
    /// `via` is a message a plugin wrote, these are notes beside one somebody
    /// else wrote. Defaulted for the reason `reactions` is — nothing archived
    /// before annotators existed has the field.
    #[serde(default)]
    #[ts(as = "Option<Vec<Annotation>>", optional)]
    pub annotations: Vec<Annotation>,
    /// The plugins that thought this message worth interrupting the user for.
    /// Empty is the ordinary case and means nothing raised it — a rule raises
    /// and cannot lower, so there is no third state. Defaulted for the reason
    /// `annotations` is.
    #[serde(default)]
    #[ts(as = "Option<Vec<String>>", optional)]
    pub raised_by: Vec<String>,
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

/// One plugin's note about one message. Named with the plugin that said it,
/// because a reader has to be able to tell somebody else's code from the
/// person — the same reason a plugin's own message carries `via`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    /// The plugin's id.
    pub plugin: String,
    pub text: String,
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
    Authenticated {
        account: String,
        /// Set when SASL was refused earlier on this connection and the account
        /// arrived some other way — identifying to NickServ by hand. Both are
        /// true at once and only one of them is something the user can act on,
        /// so the login does not get to erase the refusal. #390.
        refused: Option<String>,
    },
    Failed {
        message: String,
    },
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
    /// Set by muting this conversation or the network it is on. The count
    /// beside it still rises; what mute stops is `highlights`, so the badge
    /// stays quiet rather than going away.
    pub muted: bool,
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
    /// A query has no loud badge to quieten, so this marks the row and waits
    /// for the desktop notification it will keep away.
    pub muted: bool,
}

/// Something the reader muted, for the settings window's list of them.
///
/// The network's name travels with its id because that window has no network
/// list to look one up in — it runs no event bridge — and a page listing
/// hashes is a page nobody can act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct MutedConversation {
    pub network: NetworkId,
    pub network_name: String,
    /// Empty for the network itself rather than one conversation on it.
    pub target: TargetName,
}

/// One line of a `LIST` reply. Not a `Channel`: the user is not in it, so there
/// is nothing to say about membership, modes or unread — only what the server
/// offers to help them choose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ChannelListing {
    pub name: TargetName,
    /// What the server said, which nobody verifies and which is a moment old.
    pub users: u32,
    pub topic: String,
}
