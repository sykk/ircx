use std::collections::HashMap;
use std::time::Duration;

use ircx_ipc::{IrcxEvent, NetworkId, TargetName, EVENT_CHANNEL};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tracing::warn;

/// How long the pump keeps collecting before it hands a batch to the webview.
/// Anything longer is visible as input lag on a message the user just sent;
/// anything shorter stops a history backfill from folding into one event.
const WINDOW: Duration = Duration::from_millis(8);

/// Forwards core's events to the frontend, merging whatever arrives inside one
/// window and delivering it as one message. Nothing is dropped: a slow webview
/// widens the batches instead.
pub fn pump(app: AppHandle, mut inbox: mpsc::Receiver<IrcxEvent>) {
    tauri::async_runtime::spawn(async move {
        let mut batch = Batch::default();

        while let Some(first) = inbox.recv().await {
            batch.push(first);
            let deadline = Instant::now() + WINDOW;
            loop {
                tokio::select! {
                    biased;
                    event = inbox.recv() => match event {
                        Some(event) => batch.push(event),
                        None => break,
                    },
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            }

            // One delivery for the window rather than one per event. A `LIST`
            // answers with tens of thousands of lines, and a message each meant
            // a store write and a render each — #119.
            let ready = batch.take();
            if !ready.is_empty() {
                if let Err(error) = app.emit(EVENT_CHANNEL, &ready) {
                    warn!(%error, "could not deliver events to the window");
                }
            }
        }
    });
}

/// The store slice an event writes to. Two events share a lane when the
/// frontend reducer would apply them to the same place, which is exactly when
/// their order matters and when one can absorb the other.
#[derive(PartialEq, Eq, Hash)]
enum Lane {
    Messages(NetworkId, TargetName),
    Channel(NetworkId, TargetName),
    Query(NetworkId, TargetName),
    Members(NetworkId, TargetName),
    Network(NetworkId),
}

#[derive(Default)]
pub struct Batch {
    events: Vec<IrcxEvent>,
    /// Where the most recent event of each lane sits. Merging only ever folds
    /// into that one, so an update can never overtake a removal that came
    /// between them.
    last: HashMap<Lane, usize>,
}

impl Batch {
    pub fn push(&mut self, event: IrcxEvent) {
        let Some(lane) = lane(&event) else {
            self.events.push(event);
            return;
        };

        let event = match self.last.get(&lane) {
            Some(&at) => match merge(&mut self.events[at], event) {
                Some(event) => event,
                None => return,
            },
            None => event,
        };

        self.last.insert(lane, self.events.len());
        self.events.push(event);
    }

    pub fn take(&mut self) -> Vec<IrcxEvent> {
        self.last.clear();
        order(std::mem::take(&mut self.events))
    }
}

fn lane(event: &IrcxEvent) -> Option<Lane> {
    match event {
        IrcxEvent::MessagesAppended {
            network, target, ..
        } => Some(Lane::Messages(network.clone(), target.clone())),
        IrcxEvent::MessageUpdated { message } => Some(Lane::Messages(
            message.network.clone(),
            message.target.clone(),
        )),
        IrcxEvent::ChannelUpdated { channel } => {
            Some(Lane::Channel(channel.network.clone(), channel.name.clone()))
        }
        IrcxEvent::ChannelRemoved { network, name } => {
            Some(Lane::Channel(network.clone(), name.clone()))
        }
        IrcxEvent::QueryUpdated { query } => {
            Some(Lane::Query(query.network.clone(), query.nick.clone()))
        }
        IrcxEvent::QueryRemoved { network, nick } => {
            Some(Lane::Query(network.clone(), nick.clone()))
        }

        IrcxEvent::MembersReplaced {
            network, channel, ..
        }
        | IrcxEvent::MemberUpdated {
            network, channel, ..
        }
        | IrcxEvent::MemberRemoved {
            network, channel, ..
        } => Some(Lane::Members(network.clone(), channel.clone())),
        IrcxEvent::NetworkUpdated { network } => Some(Lane::Network(network.id.clone())),
        IrcxEvent::NetworkRemoved { network }
        | IrcxEvent::ConnectionChanged { network, .. }
        | IrcxEvent::SaslChanged { network, .. }
        | IrcxEvent::CapsChanged { network, .. }
        | IrcxEvent::LagChanged { network, .. } => Some(Lane::Network(network.clone())),
        // A reaction is a delta, not a state: coalescing two of them would
        // drop one, and the second does not carry what the first said.
        IrcxEvent::TypingChanged { .. }
        | IrcxEvent::ReactionChanged { .. }
        | IrcxEvent::RawLine { .. }
        // A finished list arrives once for a `LIST` and writes where nothing
        // else does, so it shares a lane with nothing.
        | IrcxEvent::ChannelsListed { .. }
        // One note about one message, from one plugin. Sharing the message
        // lane would fold it into the message it is about and lose it.
        | IrcxEvent::MessageAnnotated { .. }
        | IrcxEvent::Notice { .. } => None,
    }
}

/// Returns the event back when it has to stand on its own.
fn merge(held: &mut IrcxEvent, event: IrcxEvent) -> Option<IrcxEvent> {
    match (held, event) {
        (
            IrcxEvent::MessagesAppended { messages, .. },
            IrcxEvent::MessagesAppended { messages: more, .. },
        ) => {
            messages.extend(more);
            None
        }
        (held, event) if supersedes(held, &event) => {
            *held = event;
            None
        }
        (_, event) => Some(event),
    }
}

/// Both events are already known to write to the same slice, so a second one
/// of the same kind carries the whole truth and the first can go.
fn supersedes(held: &IrcxEvent, event: &IrcxEvent) -> bool {
    match (held, event) {
        (IrcxEvent::MessageUpdated { message: held }, IrcxEvent::MessageUpdated { message }) => {
            held.id == message.id
        }
        (
            IrcxEvent::MemberUpdated { member: held, .. },
            IrcxEvent::MemberUpdated { member, .. },
        ) => held.nick == member.nick,
        (IrcxEvent::ChannelUpdated { .. }, IrcxEvent::ChannelUpdated { .. })
        | (IrcxEvent::QueryUpdated { .. }, IrcxEvent::QueryUpdated { .. })
        | (IrcxEvent::MembersReplaced { .. }, IrcxEvent::MembersReplaced { .. })
        | (IrcxEvent::NetworkUpdated { .. }, IrcxEvent::NetworkUpdated { .. })
        | (IrcxEvent::ConnectionChanged { .. }, IrcxEvent::ConnectionChanged { .. })
        | (IrcxEvent::SaslChanged { .. }, IrcxEvent::SaslChanged { .. })
        | (IrcxEvent::CapsChanged { .. }, IrcxEvent::CapsChanged { .. })
        | (IrcxEvent::LagChanged { .. }, IrcxEvent::LagChanged { .. }) => true,
        _ => false,
    }
}

/// A member event for a channel the frontend has not heard of yet would land
/// in a list nothing renders, so the channel's own update goes first.
fn order(events: Vec<IrcxEvent>) -> Vec<IrcxEvent> {
    let mut slots: Vec<Option<IrcxEvent>> = events.into_iter().map(Some).collect();
    let mut ordered = Vec::with_capacity(slots.len());

    for at in 0..slots.len() {
        let Some(event) = slots[at].take() else {
            continue;
        };
        if let Some(channel) = member_channel(&event) {
            if let Some(update) = channel_update_after(&slots, at, &channel) {
                if let Some(update) = slots[update].take() {
                    ordered.push(update);
                }
            }
        }
        ordered.push(event);
    }

    ordered
}

fn member_channel(event: &IrcxEvent) -> Option<(&NetworkId, &TargetName)> {
    match event {
        IrcxEvent::MembersReplaced {
            network, channel, ..
        }
        | IrcxEvent::MemberUpdated {
            network, channel, ..
        }
        | IrcxEvent::MemberRemoved {
            network, channel, ..
        } => Some((network, channel)),
        _ => None,
    }
}

/// Stops at a removal of the same channel: hoisting an update from the far
/// side of one would resurrect a channel the user closed.
fn channel_update_after(
    slots: &[Option<IrcxEvent>],
    from: usize,
    channel: &(&NetworkId, &TargetName),
) -> Option<usize> {
    let (network, name) = *channel;
    for (at, held) in slots.iter().enumerate().skip(from + 1) {
        match held {
            Some(IrcxEvent::ChannelUpdated { channel })
                if &channel.network == network && &channel.name == name =>
            {
                return Some(at)
            }
            Some(IrcxEvent::ChannelRemoved {
                network: closed,
                name: closed_name,
            }) if closed == network && closed_name == name => return None,
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use ircx_ipc::{
        Channel, ChatMessage, Delivery, EncryptionState, Member, MessageKind, MessageSource, Sender,
    };

    fn message(id: &str, target: &str) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            id_is_local: true,
            network: "net".into(),
            target: target.into(),
            kind: MessageKind::Privmsg,
            sender: Sender {
                nick: "sykk".into(),
                user: None,
                host: None,
                account: None,
                is_self: false,
            },
            timestamp: "2026-01-01T00:00:00Z".into(),
            timestamp_is_local: false,
            text: "hello".into(),
            tags: vec![],
            reactions: vec![],
            annotations: vec![],
            reply_to: None,
            batch: None,
            delivery: Delivery::Sent,
            attachments: vec![],
            encryption: EncryptionState::Plaintext,
            via: None,
            raw: String::new(),
            source: MessageSource::Live,
        }
    }

    fn appended(id: &str, target: &str) -> IrcxEvent {
        IrcxEvent::MessagesAppended {
            network: "net".into(),
            target: target.into(),
            messages: vec![message(id, target)],
        }
    }

    fn channel(name: &str, unread: u32) -> IrcxEvent {
        IrcxEvent::ChannelUpdated {
            channel: Channel {
                network: "net".into(),
                name: name.into(),
                topic: None,
                modes: String::new(),
                joined: true,
                member_count: 1,
                unread,
                highlights: 0,
            },
        }
    }

    fn member(nick: &str) -> IrcxEvent {
        IrcxEvent::MemberUpdated {
            network: "net".into(),
            channel: "#ircx".into(),
            member: Member {
                nick: nick.into(),
                account: None,
                prefixes: vec![],
                away: None,
            },
        }
    }

    #[test]
    fn a_backfill_becomes_one_append() {
        let mut batch = Batch::default();
        for n in 0..500 {
            batch.push(appended(&format!("m{n}"), "#ircx"));
        }

        let events = batch.take();

        assert_eq!(events.len(), 1);
        let IrcxEvent::MessagesAppended { messages, .. } = &events[0] else {
            panic!("expected one append, got {events:?}");
        };
        assert_eq!(messages.len(), 500);
    }

    #[test]
    fn appends_to_different_targets_stay_apart() {
        let mut batch = Batch::default();
        batch.push(appended("a", "#ircx"));
        batch.push(appended("b", "#rust"));
        batch.push(appended("c", "#ircx"));

        let events = batch.take();

        assert_eq!(events.len(), 2);
        let IrcxEvent::MessagesAppended {
            target, messages, ..
        } = &events[0]
        else {
            panic!("expected an append");
        };
        assert_eq!(target, "#ircx");
        assert_eq!(messages.len(), 2);
    }

    /// The unread counter ticks with every message; only the last figure is
    /// worth rendering.
    #[test]
    fn repeated_channel_updates_collapse_to_the_last() {
        let mut batch = Batch::default();
        batch.push(channel("#ircx", 1));
        batch.push(appended("a", "#ircx"));
        batch.push(channel("#ircx", 2));

        let events = batch.take();

        assert_eq!(events.len(), 2);
        let IrcxEvent::ChannelUpdated { channel } = &events[0] else {
            panic!("expected the channel first, got {events:?}");
        };
        assert_eq!(channel.unread, 2);
    }

    #[test]
    fn a_close_is_not_overtaken_by_a_later_update() {
        let mut batch = Batch::default();
        batch.push(channel("#ircx", 1));
        batch.push(IrcxEvent::ChannelRemoved {
            network: "net".into(),
            name: "#ircx".into(),
        });
        batch.push(channel("#ircx", 0));

        let events = batch.take();

        assert_eq!(events.len(), 3);
        assert!(matches!(events[2], IrcxEvent::ChannelUpdated { .. }));
    }

    #[test]
    fn a_channel_arrives_before_its_members() {
        let mut batch = Batch::default();
        batch.push(member("sykk"));
        batch.push(channel("#ircx", 0));

        let events = batch.take();

        assert!(
            matches!(
                events.as_slice(),
                [
                    IrcxEvent::ChannelUpdated { .. },
                    IrcxEvent::MemberUpdated { .. }
                ]
            ),
            "{events:?}"
        );
    }

    #[test]
    fn a_member_update_is_not_hoisted_past_a_closed_channel() {
        let mut batch = Batch::default();
        batch.push(member("sykk"));
        batch.push(IrcxEvent::ChannelRemoved {
            network: "net".into(),
            name: "#ircx".into(),
        });
        batch.push(channel("#ircx", 0));

        let events = batch.take();

        assert!(
            matches!(events[0], IrcxEvent::MemberUpdated { .. }),
            "{events:?}"
        );
    }

    #[test]
    fn notices_are_never_folded_together() {
        let mut batch = Batch::default();
        for text in ["first", "second"] {
            batch.push(IrcxEvent::Notice {
                network: None,
                severity: ircx_ipc::Severity::Info,
                text: text.into(),
                detail: None,
            });
        }

        assert_eq!(batch.take().len(), 2);
    }
}
