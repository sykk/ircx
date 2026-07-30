use ircx_ipc::{
    ChatMessage, Delivery, EncryptionState, IrcxEvent, MessageKind, MessageSource, Sender,
};
use ircx_proto::{Message, Prefix};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::session::{Action, BatchState, SessionState};
use crate::text;

impl SessionState {
    /// A message the server sent us. `text` is already unwrapped from any CTCP
    /// framing; `kind` is what that framing turned it into.
    pub(crate) fn chat_message(
        &self,
        source: &Message,
        target: &str,
        kind: MessageKind,
        text: String,
    ) -> ChatMessage {
        let (id, id_is_local) = match source.tag("msgid").filter(|id| !id.is_empty()) {
            Some(msgid) => (msgid.to_string(), false),
            None => (Uuid::new_v4().to_string(), true),
        };
        let (timestamp, timestamp_is_local) = match source.tag("time").filter(|t| !t.is_empty()) {
            Some(time) => (time.to_string(), false),
            None => (now(), true),
        };
        let batch = source.tag("batch").map(str::to_string);

        ChatMessage {
            id,
            id_is_local,
            network: self.config.network.clone(),
            target: target.to_string(),
            kind,
            sender: self.sender_of(source),
            timestamp,
            timestamp_is_local,
            attachments: match kind {
                MessageKind::Privmsg | MessageKind::Notice | MessageKind::Action => {
                    text::attachments(&text)
                }
                _ => Vec::new(),
            },
            text,
            tags: source.tags.clone(),
            reactions: Vec::new(),
            reply_to: reply_to(source),
            source: batch
                .as_deref()
                .and_then(|reference| self.batches.get(reference))
                .map_or(MessageSource::Live, |batch| batch.source),
            batch,
            delivery: Delivery::Delivered,
            encryption: EncryptionState::Plaintext,
            raw: source.raw.clone(),
            via: None,
        }
    }

    /// A line ircx wrote itself: command output, connection notes, the local
    /// copy of something being sent.
    pub(crate) fn local_message(
        &self,
        target: &str,
        kind: MessageKind,
        text: String,
    ) -> ChatMessage {
        ChatMessage {
            id: Uuid::new_v4().to_string(),
            id_is_local: true,
            network: self.config.network.clone(),
            target: target.to_string(),
            kind,
            sender: Sender {
                nick: self.nick.clone(),
                user: self.user.clone(),
                host: self.host.clone(),
                account: self.account.clone(),
                is_self: true,
            },
            timestamp: now(),
            timestamp_is_local: true,
            attachments: text::attachments(&text),
            text,
            tags: Vec::new(),
            reactions: Vec::new(),
            reply_to: None,
            batch: None,
            delivery: Delivery::Delivered,
            source: MessageSource::Live,
            via: None,
            encryption: EncryptionState::Plaintext,
            raw: String::new(),
        }
    }

    /// Nobody on the network said this. Used for a plugin's own output, which
    /// would otherwise be archived as having been sent by the user.
    fn nobody(&self) -> Sender {
        Sender {
            nick: self.config.name.clone(),
            user: None,
            host: None,
            account: None,
            is_self: false,
        }
    }

    pub(crate) fn sender_of(&self, source: &Message) -> Sender {
        match &source.prefix {
            Some(Prefix::User { nick, user, host }) => Sender {
                account: source
                    .tag("account")
                    .filter(|account| !account.is_empty() && *account != "*")
                    .map(str::to_string)
                    .or_else(|| self.known_account(nick)),
                is_self: self.is_me(nick),
                nick: nick.clone(),
                user: user.clone(),
                host: host.clone(),
            },
            Some(Prefix::Server(name)) => Sender {
                nick: name.clone(),
                user: None,
                host: None,
                account: None,
                is_self: false,
            },
            None => Sender {
                nick: self.config.name.clone(),
                user: None,
                host: None,
                account: None,
                is_self: false,
            },
        }
    }

    /// Buffers into an open batch, or emits it on its own. Nothing else may
    /// emit `MessagesAppended`: a batch that leaked its lines one at a time
    /// would render a history backfill as thousands of arrivals.
    pub(crate) fn append(&mut self, message: ChatMessage) {
        if let Some(batch) = message
            .batch
            .clone()
            .and_then(|reference| self.batches.get_mut(&reference))
        {
            batch.messages.push(message);
            return;
        }
        self.count_towards_unread(&message);
        let target = message.target.clone();
        self.emit(IrcxEvent::MessagesAppended {
            network: self.config.network.clone(),
            target,
            messages: vec![message],
        });
    }

    pub(crate) fn note(&mut self, target: &str, kind: MessageKind, text: String) {
        let message = self.local_message(target, kind, text);
        self.append(message);
    }

    /// Client output of more than one line. The timeline draws a message as a
    /// line, so each line is its own message; they arrive together.
    pub(crate) fn note_block(&mut self, target: &str, text: &str) {
        self.note_block_via(target, text, None);
    }

    /// The same, naming the plugin that produced it. A plugin's answer is the
    /// only text in a conversation that neither the client nor the server said,
    /// and the sender it would otherwise inherit is the user's own — so the
    /// name goes on and the sender comes off.
    pub(crate) fn note_block_via(&mut self, target: &str, text: &str, via: Option<&str>) {
        let messages: Vec<ChatMessage> = text
            .lines()
            .map(|line| {
                let mut message = self.local_message(target, MessageKind::Client, line.to_string());
                if let Some(plugin) = via {
                    message.sender = self.nobody();
                    message.via = Some(plugin.to_owned());
                }
                message
            })
            .collect();
        if messages.is_empty() {
            return;
        }
        self.emit(IrcxEvent::MessagesAppended {
            network: self.config.network.clone(),
            target: target.to_string(),
            messages,
        });
    }

    pub(crate) fn open_batch(&mut self, reference: &str, kind: &str) {
        let source = match kind {
            "chathistory" | "draft/chathistory" => MessageSource::ServerHistory,
            _ => MessageSource::Live,
        };
        self.batches.insert(
            reference.to_string(),
            BatchState {
                source,
                messages: Vec::new(),
            },
        );
    }

    /// One `MessagesAppended` per run of messages sharing a target, so a
    /// netjoin batch spanning channels still arrives as few events, in order.
    pub(crate) fn close_batch(&mut self, reference: &str) {
        let Some(batch) = self.batches.remove(reference) else {
            return;
        };
        let mut run: Vec<ChatMessage> = Vec::new();
        for message in batch.messages {
            if batch.source == MessageSource::Live {
                self.count_towards_unread(&message);
            }
            if run.last().is_some_and(|last| last.target != message.target) {
                self.flush_run(&mut run);
            }
            run.push(message);
        }
        self.flush_run(&mut run);
    }

    fn flush_run(&mut self, run: &mut Vec<ChatMessage>) {
        let Some(target) = run.first().map(|message| message.target.clone()) else {
            return;
        };
        let messages = std::mem::take(run);
        self.emit(IrcxEvent::MessagesAppended {
            network: self.config.network.clone(),
            target,
            messages,
        });
    }

    fn count_towards_unread(&mut self, message: &ChatMessage) {
        if message.sender.is_self
            || !matches!(
                message.kind,
                MessageKind::Privmsg | MessageKind::Notice | MessageKind::Action
            )
        {
            return;
        }

        let highlight = text::mentions(&message.text, &self.nick);
        let key = self.fold(&message.target);
        if let Some(channel) = self.channels.get_mut(&key) {
            channel.unread += 1;
            channel.highlights += u32::from(highlight);
            self.emit_channel(&key);
        } else if let Some(query) = self.queries.get_mut(&key) {
            query.unread += 1;
            self.emit_query(&key);
        }
    }

    pub(crate) fn emit(&mut self, event: IrcxEvent) {
        self.actions.push(Action::Emit(Box::new(event)));
    }
}

/// The `msgid` a `+reply` names. Both spellings are read: the tag is ratified
/// unprefixed, and clients written against the draft still send `+draft/reply`.
pub(crate) fn reply_to(source: &Message) -> Option<String> {
    tag_value(source, &["+draft/reply", "+reply"])
}

/// The `+draft/react` value and whether it is being added. `None` when the
/// message carries neither tag, or carries both: the specification forbids
/// that pairing, and a line doing it says nothing that can be acted on.
pub(crate) fn reaction(source: &Message) -> Option<(String, bool)> {
    let added = tag_value(source, &["+draft/react", "+react"]);
    let removed = tag_value(source, &["+draft/unreact", "+unreact"]);
    match (added, removed) {
        (Some(emoji), None) => Some((emoji, true)),
        (None, Some(emoji)) => Some((emoji, false)),
        _ => None,
    }
}

fn tag_value(source: &Message, names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| source.tag(name))
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("the current time is inside the range RFC 3339 can hold")
}
