use std::collections::HashMap;

use ircx_ipc::{
    ChatMessage, Delivery, EncryptionState, IrcxEvent, MessageKind, MessageSource, Sender,
};
use ircx_proto::{Message, Prefix};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::plugins;
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
            annotations: Vec::new(),
            raised_by: Vec::new(),
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
            annotations: Vec::new(),
            raised_by: Vec::new(),
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
        let counted = self.count_towards_unread(&message);
        self.remember_newest(&message);
        let target = message.target.clone();
        // Some(false) is speech from somebody else that mentions nobody — the
        // one case a rule could still raise. The host already raised the rest.
        let ask = match counted {
            Some(false) => vec![plugins::arrived(&message)],
            _ => Vec::new(),
        };
        self.emit(IrcxEvent::MessagesAppended {
            network: self.config.network.clone(),
            target: target.clone(),
            messages: vec![message],
        });
        // After the emit, so the conversation is drawn before any rule runs.
        if !ask.is_empty() {
            self.actions.push(Action::Notify {
                target,
                messages: ask,
            });
        }
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
        let live = batch.source == MessageSource::Live;
        // Every conversation this batch touched and how much of it arrived, so
        // each gap is closed once rather than per message — and a page that came
        // back full is a page with more behind it.
        let mut filled: Vec<(String, u32, String, Option<String>)> = Vec::new();
        // What each conversation already held when this batch began, kept
        // because the loop below moves the mark forward as it goes and the
        // question is about the mark before any of it arrived. See `was_missed`.
        let held_before: HashMap<String, Option<String>> = batch
            .messages
            .iter()
            .map(|message| {
                let key = self.fold(&message.target);
                let held = self.archived.get(&key).cloned();
                (key, held)
            })
            .collect();
        for message in batch.messages {
            // A first page is not an interruption: it is a conversation the
            // user has only just met, and none of it was theirs to miss. What
            // fills a gap is the opposite — it is what they were not here for,
            // which is what unread means. #223.
            let missed = !live && self.fills_a_gap(&message.target);
            // In a replay, only somebody in the conversation adds to what there
            // is to read — the same sentence the mention gate uses, and for the
            // same case. Ergo narrates the reader's own comings and goings as
            // messages from a service, and a badge counting those says five
            // where three things were said. #221.
            if live
                || (missed
                    && self.in_conversation(&message.target, &message.sender.nick)
                    && self.was_missed(&message, &held_before))
            {
                self.count_towards_unread(&message);
            }
            if missed {
                // A server msgid names one message; an id minted here names
                // nothing a server can resolve, so a page without one resumes on
                // its timestamp. #253.
                let msgid = (!message.id_is_local).then(|| message.id.clone());
                match filled
                    .iter_mut()
                    .find(|(target, ..)| target == &message.target)
                {
                    Some((_, arrived, newest, last)) => {
                        *arrived += 1;
                        // `>=`, because several messages can share a millisecond
                        // and the one to carry on from is the last of them.
                        if message.timestamp >= *newest {
                            newest.clone_from(&message.timestamp);
                            *last = msgid;
                        }
                    }
                    None => {
                        filled.push((message.target.clone(), 1, message.timestamp.clone(), msgid));
                    }
                }
            }
            self.remember_newest(&message);
            if run.last().is_some_and(|last| last.target != message.target) {
                self.flush_run(&mut run, live);
            }
            run.push(message);
        }
        self.flush_run(&mut run, live);
        let limit = self.page_limit();
        for (target, arrived, newest, msgid) in filled {
            let key = self.fold(&target);
            let pages = self.gap_fills.get(&key).copied().unwrap_or(0) + 1;
            // Short of the limit is the end of the gap. Exactly the limit is the
            // start of one that did not fit. #239.
            match arrived >= limit {
                true => self.continue_gap(&target, pages, &newest, msgid.as_deref()),
                false => {
                    self.gap_fills.remove(&key);
                }
            }
        }
    }

    /// Whether what is arriving for this conversation is the gap the client
    /// asked for rather than a first page of one it has never held.
    fn fills_a_gap(&self, target: &str) -> bool {
        self.gap_fills.contains_key(&self.fold(target))
    }

    /// Whether this nick is in the conversation. A roster that has not arrived
    /// is not a channel nobody is in, so it answers yes; so does anything that
    /// is not a channel, a query having only its two ends.
    fn in_conversation(&self, target: &str, nick: &str) -> bool {
        let Some(channel) = self.channels.get(&self.fold(target)) else {
            return true;
        };
        channel.members.is_empty() || channel.members.contains_key(&self.fold(nick))
    }

    /// Moves this conversation's watermark, which is where the next request for
    /// its gap starts.
    ///
    /// Only a message the server stamped moves it. The watermark is a point in
    /// the server's own record and a client-stamped line is a point in this
    /// machine's clock; letting one move the other means a fast clock asks for
    /// the gap from after the messages in it, and they are missed for good.
    /// Asking from too far back only re-fetches what the archive then refuses.
    /// Whether a replayed message is one the reader was not here for, rather
    /// than one they already have.
    ///
    /// A gap is asked for from the newest thing the conversation holds, and
    /// `history::at` truncates that to the milliseconds the resume format
    /// carries — deliberately, since "at worst asks again for a message already
    /// held". The archive refuses the duplicate on the way in. The unread count
    /// did not, so every reconnect handed the reader back the last thing they
    /// had read and put a badge on it. #379.
    ///
    /// Strictly newer, which cuts the other way for a message sharing the exact
    /// server timestamp of the last one read: it arrives, it is drawn, and it
    /// is not counted. That is a millisecond collision against a badge that was
    /// wrong on every reconnect, and it is the trade this takes.
    fn was_missed(
        &self,
        message: &ChatMessage,
        held_before: &HashMap<String, Option<String>>,
    ) -> bool {
        // A conversation with nothing behind it cannot have handed anything
        // back, and a locally-stamped message is not on the server's clock at
        // all, so neither is measured against a watermark.
        if message.timestamp_is_local {
            return true;
        }
        match held_before.get(&self.fold(&message.target)) {
            Some(Some(held)) => message.timestamp.as_str() > held.as_str(),
            _ => true,
        }
    }

    fn remember_newest(&mut self, message: &ChatMessage) {
        if message.timestamp_is_local {
            return;
        }
        let key = self.fold(&message.target);
        let newer = self
            .archived
            .get(&key)
            .is_none_or(|held| held.as_str() < message.timestamp.as_str());
        if newer {
            self.archived.insert(key, message.timestamp.clone());
        }
    }

    fn flush_run(&mut self, run: &mut Vec<ChatMessage>, live: bool) {
        let Some(target) = run.first().map(|message| message.target.clone()) else {
            return;
        };
        let messages = std::mem::take(run);
        // Which messages a rule is worth asking about, worked out before the
        // batch is given away.
        let ask = match live {
            true => plugins::worth_raising(&messages, &self.nick, &self.highlight_words),
            false => Vec::new(),
        };
        self.emit(IrcxEvent::MessagesAppended {
            network: self.config.network.clone(),
            target: target.clone(),
            messages,
        });
        // After the emit, so the conversation is drawn before any rule runs.
        if !ask.is_empty() {
            self.actions.push(Action::Notify {
                target,
                messages: ask,
            });
        }
    }

    /// `Some(highlight)` for speech from somebody else, `None` for the rest —
    /// which is exactly the split `plugins::worth_raising` would recompute.
    fn count_towards_unread(&mut self, message: &ChatMessage) -> Option<bool> {
        if message.sender.is_self
            || !matches!(
                message.kind,
                MessageKind::Privmsg | MessageKind::Notice | MessageKind::Action
            )
        {
            return None;
        }

        let highlight = text::raises(&message.text, &self.nick, &self.highlight_words);
        let key = self.fold(&message.target);
        if let Some(channel) = self.channels.get_mut(&key) {
            channel.unread += 1;
            channel.highlights += u32::from(highlight);
            self.emit_channel(&key);
        } else if let Some(query) = self.queries.get_mut(&key) {
            query.unread += 1;
            self.emit_query(&key);
        }
        Some(highlight)
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
