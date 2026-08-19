use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{
    Channel, ChannelListing, ChatMessage, ConnectionStatus, Member, Network, Query, SaslStatus,
};
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
    ///
    /// `answers` names the page-back this batch is the answer to, as the reader
    /// named it when they asked — `None` for everything else, which is most
    /// batches. Two page-backs can be outstanding on one conversation at once,
    /// and a reader who has given up on one is still sent its answer, so a
    /// batch that says nothing about which ask it belongs to can be read as the
    /// answer to a question nobody put (#540).
    MessagesAppended {
        network: NetworkId,
        target: TargetName,
        messages: Vec<ChatMessage>,
        answers: Option<String>,
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
    ReadMarkerUpdated {
        network: NetworkId,
        target: TargetName,
        timestamp: String,
    },
    /// A query the user closed. Channels have `ChannelRemoved`; without the
    /// matching event a closed query stayed on screen until the next launch.
    QueryRemoved {
        network: NetworkId,
        nick: TargetName,
    },
    /// The person a query is with changed their nick.
    ///
    /// One event rather than a removal and an arrival, because a conversation
    /// is more than its row: everything the frontend keys by the name — the
    /// history, what is being typed, what a reply answers — has to move with
    /// it, and two events cannot say whether the old name left or became this
    /// one. What is already written down keeps the name it was said under.
    QueryRenamed {
        network: NetworkId,
        from: TargetName,
        to: TargetName,
    },
    /// A `LIST` that finished, whole. Sent once rather than per reply: a
    /// network answers with tens of thousands, and an event each is what #119
    /// was about.
    ChannelsListed {
        network: NetworkId,
        channels: Vec<ChannelListing>,
        /// True when the server sent more than ircx would hold, so the list is
        /// the beginning of one rather than all of it.
        truncated: bool,
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
    /// Who is ignored on this network, in full rather than as a delta.
    ///
    /// The whole set because it is small and because a delta would have to
    /// survive the reload that follows a reconnect; the frontend needs it to
    /// draw the control that undoes an ignore, and nothing else consults it —
    /// the session already dropped everything this describes.
    IgnoredChanged {
        network: NetworkId,
        nicks: Vec<String>,
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
    /// A plugin's note about a message that arrived. Sent after the message
    /// itself, because the annotator runs on arrival rather than on draw: the
    /// conversation is never waiting on a plugin.
    MessageAnnotated {
        network: NetworkId,
        target: TargetName,
        /// The id of the message the note is about.
        message: String,
        /// Which plugin said it. Drawn with the note, for the reason a
        /// command's answer is named: it is how a reader tells what somebody
        /// else's code said from what the person said.
        plugin: String,
        text: String,
    },
    /// A rule thought a message worth interrupting the user for. Sent after the
    /// message, for the reason a note is: nothing is waiting on a plugin.
    ///
    /// There is no event for a message a rule passed over. A rule raises and
    /// cannot lower, so nothing it answers can take a raise back.
    MessageRaised {
        network: NetworkId,
        target: TargetName,
        /// The id of the message that was raised.
        message: String,
        /// Which rule raised it, so a reader can tell why a conversation went
        /// loud without a word of it naming them.
        plugin: String,
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
