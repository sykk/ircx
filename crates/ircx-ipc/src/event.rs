use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{Channel, ChatMessage, ConnectionStatus, Member, Network, Query, SaslStatus};
use crate::{NetworkId, TargetName};

pub const EVENT_CHANNEL: &str = "ircx://event";

/// Themes are files on disk, not IRC, so they get their own channel rather
/// than a variant the reducer would have to carry. The payload is the whole
/// themes directory, re-read: the frontend validates it and keeps what parses.
pub const THEMES_CHANNEL: &str = "ircx://themes";

/// One channel for every backend push, so the frontend reducer stays a single
/// exhaustive match and ordering holds across kinds. Ordering matters:
/// `MemberJoined` must not land before the `ChannelUpdated` that created it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum IrcxEvent {
    NetworkUpdated {
        network: Network,
    },
    NetworkRemoved {
        network: NetworkId,
    },
    ConnectionChanged {
        network: NetworkId,
        status: ConnectionStatus,
    },
    SaslChanged {
        network: NetworkId,
        status: SaslStatus,
    },
    /// Sent once per registration and again on `CAP NEW` / `CAP DEL`.
    CapsChanged {
        network: NetworkId,
        enabled: Vec<String>,
    },
    /// Batched: history backfill would otherwise emit thousands of events.
    MessagesAppended {
        network: NetworkId,
        target: TargetName,
        messages: Vec<ChatMessage>,
    },
    /// Delivery confirmed by echo, or a preview finished loading. Boxed so the
    /// enum is not the size of one message; serialises unchanged.
    MessageUpdated {
        message: Box<ChatMessage>,
    },
    ChannelUpdated {
        channel: Channel,
    },
    ChannelRemoved {
        network: NetworkId,
        name: TargetName,
    },
    QueryUpdated {
        query: Query,
    },
    /// A query the user closed. Channels have `ChannelRemoved`; without the
    /// matching event a closed query stayed on screen until the next launch.
    QueryRemoved {
        network: NetworkId,
        nick: TargetName,
    },
    MembersReplaced {
        network: NetworkId,
        channel: TargetName,
        members: Vec<Member>,
    },
    MemberUpdated {
        network: NetworkId,
        channel: TargetName,
        member: Member,
    },
    MemberRemoved {
        network: NetworkId,
        channel: TargetName,
        nick: String,
    },
    /// The frontend expires these on its own timer; no stop is sent per start.
    TypingChanged {
        network: NetworkId,
        target: TargetName,
        nick: String,
        active: bool,
    },
    /// One person reacting to one message, or taking that reaction back. A
    /// delta rather than the whole set, because a reaction can name a message
    /// nothing here holds. Applying one twice has to land where applying it
    /// once did: an echo of our own reaction follows the local copy.
    ReactionChanged {
        network: NetworkId,
        target: TargetName,
        /// The `msgid` the reaction named.
        message: String,
        nick: String,
        emoji: String,
        /// `false` when the tag was `+draft/unreact`.
        active: bool,
    },
    LagChanged {
        network: NetworkId,
        lag_ms: u32,
    },
    RawLine {
        network: NetworkId,
        outgoing: bool,
        line: String,
    },
    /// `text` is written for a human; `detail` carries protocol specifics.
    Notice {
        network: Option<NetworkId>,
        severity: Severity,
        text: String,
        detail: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Info,
    Warning,
    Error,
}
