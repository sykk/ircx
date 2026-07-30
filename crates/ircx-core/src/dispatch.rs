use ircx_ipc::{ChatMessage, CommandOutcome, Delivery, MessageKind, Query};
use ircx_proto::{MessageBuilder, MAX_MESSAGE_BYTES};

use crate::session::{build, Action, SessionState, SERVER_TARGET};
use crate::text;

const HELP: &str = "\
/join #channel [key]      join a channel
/part [#channel] [reason] leave it
/msg <target> <text>      send without opening a tab
/query <nick> [text]      open a tab for one person
/me <action>              speak in the third person
/notice <target> <text>   send a notice
/nick <nick>              change your nickname
/topic [text]             read or set the topic
/mode [target] <modes>    read or set modes
/kick <nick> [reason]     remove someone from the channel
/whois <nick>             look someone up
/away [reason]            mark yourself away, or back
/quit [reason]            disconnect
/raw <line>               send a line to the server untouched
/help                     this list";

impl SessionState {
    /// Composer input: a slash command, or text to say in `target`.
    pub fn submit(&mut self, target: &str, input: &str) -> (CommandOutcome, Vec<Action>) {
        let outcome = self.dispatch(target, input);
        (outcome, self.drain())
    }

    pub fn join(&mut self, channel: &str, key: Option<&str>) -> Vec<Action> {
        self.send_join(channel, key);
        self.drain()
    }

    pub fn part(&mut self, channel: &str, reason: Option<&str>) -> Vec<Action> {
        self.send_part(channel, reason);
        self.drain()
    }

    pub fn open_query(&mut self, nick: &str) -> (Query, Vec<Action>) {
        self.touch_query(nick, None);
        let key = self.fold(nick);
        (self.query(&key), self.drain())
    }

    fn send_join(&mut self, channel: &str, key: Option<&str>) {
        match key {
            Some(key) => self.send_command("JOIN", &[channel, key]),
            None => self.send_command("JOIN", &[channel]),
        }
    }

    fn send_part(&mut self, channel: &str, reason: Option<&str>) {
        match reason {
            Some(reason) => self.send_command("PART", &[channel, reason]),
            None => self.send_command("PART", &[channel]),
        }
    }

    fn send_quit(&mut self, reason: Option<&str>) {
        self.send_command("QUIT", &[reason.unwrap_or("ircx")]);
        self.actions.push(Action::Close);
    }

    /// Leaves the channel if we are still in it and drops what we held for it.
    pub fn close_target(&mut self, target: &str) -> Vec<Action> {
        let key = self.fold(target);
        if let Some(channel) = self.channels.remove(&key) {
            if channel.joined {
                self.send_command("PART", &[&channel.name]);
            }
            self.emit(ircx_ipc::IrcxEvent::ChannelRemoved {
                network: self.network_id().clone(),
                name: channel.name,
            });
        }
        self.queries.remove(&key);
        self.drain()
    }

    pub fn raw(&mut self, line: &str) -> Vec<Action> {
        self.cmd_raw(line);
        self.drain()
    }

    pub fn quit(&mut self, reason: Option<&str>) -> Vec<Action> {
        self.send_quit(reason);
        self.drain()
    }

    /// Silent without `message-tags`: typing is a courtesy, not an error.
    pub fn set_typing(&mut self, target: &str, active: bool) -> Vec<Action> {
        if self.caps.is_enabled("message-tags") {
            let state = if active { "active" } else { "done" };
            if let Ok(message) = MessageBuilder::new("TAGMSG")
                .tag("+typing", Some(state.into()))
                .param(target)
                .build()
            {
                self.send_line(message.to_line());
            }
        }
        self.drain()
    }

    fn dispatch(&mut self, target: &str, input: &str) -> CommandOutcome {
        let Some(rest) = input.strip_prefix('/') else {
            return self.say_here(target, input, MessageKind::Privmsg);
        };
        // `//` is how you start a message with a slash.
        if let Some(text) = rest.strip_prefix('/') {
            return self.say_here(target, &format!("/{text}"), MessageKind::Privmsg);
        }

        let (name, args) = rest.split_once(' ').unwrap_or((rest, ""));
        let args = args.trim();
        let name = name.to_ascii_lowercase();
        // Everything else needs a server that has finished registering us.
        if !self.registered && !matches!(name.as_str(), "help" | "raw" | "quote" | "quit") {
            return CommandOutcome::Rejected(format!(
                "Not connected to {} yet",
                self.network_name()
            ));
        }
        match name.as_str() {
            "join" | "j" => self.cmd_join(args),
            "part" | "leave" => self.cmd_part(target, args),
            "msg" => self.cmd_msg(args, MessageKind::Privmsg),
            "notice" => self.cmd_msg(args, MessageKind::Notice),
            "me" => self.cmd_me(target, args),
            "query" => self.cmd_query(args),
            "nick" => self.one_argument("NICK", args, "/nick <nickname>"),
            "topic" => self.cmd_topic(target, args),
            "mode" => self.cmd_mode(target, args),
            "kick" => self.cmd_kick(target, args),
            "whois" => self.one_argument("WHOIS", args, "/whois <nickname>"),
            "away" => self.cmd_away(args),
            "quit" => {
                self.send_quit((!args.is_empty()).then_some(args));
                CommandOutcome::Handled
            }
            "raw" | "quote" => self.cmd_raw(args),
            "help" => CommandOutcome::Output(HELP.to_string()),
            other => CommandOutcome::Rejected(format!(
                "`/{other}` is not a command ircx knows. `/help` lists the ones it does."
            )),
        }
    }

    fn cmd_join(&mut self, args: &str) -> CommandOutcome {
        let mut parts = args.split_whitespace();
        let Some(channel) = parts.next() else {
            return CommandOutcome::Rejected("`/join #channel [key]` needs a channel".into());
        };
        let channel = self.qualify_channel(channel);
        self.send_join(&channel, parts.next());
        CommandOutcome::Handled
    }

    fn cmd_part(&mut self, target: &str, args: &str) -> CommandOutcome {
        let (channel, reason) = match args.split_once(' ') {
            Some((first, rest)) if self.isupport.is_channel(first) => (first.to_string(), rest),
            _ if self.isupport.is_channel(args) => (args.to_string(), ""),
            _ => (target.to_string(), args),
        };
        if !self.isupport.is_channel(&channel) {
            return CommandOutcome::Rejected("`/part` only works in a channel".into());
        }
        self.send_part(&channel, (!reason.is_empty()).then_some(reason));
        CommandOutcome::Handled
    }

    fn cmd_msg(&mut self, args: &str, kind: MessageKind) -> CommandOutcome {
        let Some((target, text)) = args.split_once(' ') else {
            return CommandOutcome::Rejected("`/msg <target> <message>` needs both".into());
        };
        if text.trim().is_empty() {
            return CommandOutcome::Rejected("`/msg <target> <message>` needs both".into());
        }
        if !self.isupport.is_channel(target) {
            self.touch_query(target, None);
        }
        for message in self.say(target, text, kind) {
            self.append(message);
        }
        CommandOutcome::Handled
    }

    fn cmd_me(&mut self, target: &str, args: &str) -> CommandOutcome {
        if args.is_empty() {
            return CommandOutcome::Rejected("`/me <action>` needs something to do".into());
        }
        self.say_here(target, args, MessageKind::Action)
    }

    fn cmd_query(&mut self, args: &str) -> CommandOutcome {
        let (nick, text) = args.split_once(' ').unwrap_or((args, ""));
        if nick.is_empty() {
            return CommandOutcome::Rejected("`/query <nickname>` needs a nickname".into());
        }
        self.touch_query(nick, None);
        if !text.trim().is_empty() {
            for message in self.say(nick, text, MessageKind::Privmsg) {
                self.append(message);
            }
        }
        CommandOutcome::Handled
    }

    fn cmd_topic(&mut self, target: &str, args: &str) -> CommandOutcome {
        if !self.isupport.is_channel(target) {
            return CommandOutcome::Rejected("`/topic` only works in a channel".into());
        }
        match args.is_empty() {
            true => self.send_command("TOPIC", &[target]),
            false => self.send_command("TOPIC", &[target, args]),
        }
        CommandOutcome::Handled
    }

    fn cmd_mode(&mut self, target: &str, args: &str) -> CommandOutcome {
        let mut params: Vec<&str> = args.split_whitespace().collect();
        let first_is_target = params
            .first()
            .is_some_and(|first| self.isupport.is_channel(first) || self.is_me(first));
        if !first_is_target {
            params.insert(0, target);
        }
        if params.len() == 1 && !self.isupport.is_channel(params[0]) {
            return CommandOutcome::Rejected("`/mode [target] <modes>` needs modes".into());
        }
        self.send_command("MODE", &params);
        CommandOutcome::Handled
    }

    fn cmd_kick(&mut self, target: &str, args: &str) -> CommandOutcome {
        if !self.isupport.is_channel(target) {
            return CommandOutcome::Rejected("`/kick` only works in a channel".into());
        }
        let (nick, reason) = args.split_once(' ').unwrap_or((args, ""));
        if nick.is_empty() {
            return CommandOutcome::Rejected("`/kick <nickname> [reason]` needs a name".into());
        }
        match reason.is_empty() {
            true => self.send_command("KICK", &[target, nick]),
            false => self.send_command("KICK", &[target, nick, reason]),
        }
        CommandOutcome::Handled
    }

    fn cmd_away(&mut self, args: &str) -> CommandOutcome {
        match args.is_empty() {
            true => self.send_command("AWAY", &[]),
            false => self.send_command("AWAY", &[args]),
        }
        CommandOutcome::Handled
    }

    fn cmd_raw(&mut self, args: &str) -> CommandOutcome {
        if args.is_empty() {
            return CommandOutcome::Rejected("`/raw <line>` needs a line".into());
        }
        if args.len() + 2 > MAX_MESSAGE_BYTES {
            return CommandOutcome::Rejected(format!(
                "That line is {} bytes; the protocol allows {}.",
                args.len() + 2,
                MAX_MESSAGE_BYTES
            ));
        }
        self.send_line(args.to_string());
        CommandOutcome::Handled
    }

    fn one_argument(&mut self, command: &str, args: &str, usage: &str) -> CommandOutcome {
        let argument = args.split_whitespace().next().unwrap_or_default();
        if argument.is_empty() {
            return CommandOutcome::Rejected(format!("`{usage}` needs an argument"));
        }
        self.send_command(command, &[argument]);
        CommandOutcome::Handled
    }

    /// Text typed into a tab. The first piece goes back as the optimistic copy
    /// the caller renders; anything the split produced beyond it is appended
    /// like any other arrival.
    fn say_here(&mut self, target: &str, text: &str, kind: MessageKind) -> CommandOutcome {
        if text.trim().is_empty() {
            return CommandOutcome::Handled;
        }
        if target == SERVER_TARGET {
            return CommandOutcome::Rejected(
                "This tab is the server's, not a conversation. Try `/msg <target> <message>`."
                    .into(),
            );
        }
        let mut messages = self.say(target, text, kind).into_iter();
        let Some(first) = messages.next() else {
            return CommandOutcome::Rejected(format!(
                "`{target}` is not a target ircx can send to"
            ));
        };
        for message in messages {
            self.append(message);
        }
        CommandOutcome::Sent(Box::new(first))
    }

    /// Splits `text` to fit the wire, sends it, and returns the local copies.
    fn say(&mut self, target: &str, text: &str, kind: MessageKind) -> Vec<ChatMessage> {
        let command = match kind {
            MessageKind::Notice => "NOTICE",
            _ => "PRIVMSG",
        };
        let action = kind == MessageKind::Action;
        let budget = self.wire_budget(command, target, action);
        let echoes = self.caps.is_enabled("echo-message");
        let labels = self.caps.is_enabled("labeled-response");

        let mut copies = Vec::new();
        for piece in text::split_for_wire(text, budget) {
            let body = match action {
                true => format!("\u{1}ACTION {piece}\u{1}"),
                false => piece.clone(),
            };
            let label = labels.then(|| self.next_label());
            let mut builder = MessageBuilder::new(command).param(target).param(body);
            if let Some(label) = label.clone() {
                builder = builder.tag("label", Some(label));
            }
            let Ok(line) = builder.build() else { continue };
            self.send_line(line.to_line());

            let mut message = self.local_message(target, kind, piece);
            message.delivery = match echoes {
                true => Delivery::Pending,
                false => Delivery::Sent,
            };
            self.track_pending(label, message.clone());
            copies.push(message);
        }
        copies
    }

    /// How many bytes of text fit once the server has prepended the mask it
    /// will put on the copy everyone else receives.
    fn wire_budget(&self, command: &str, target: &str, action: bool) -> usize {
        let user = self.user.as_deref().map_or(10, str::len);
        let host = self.host.as_deref().map_or(63, str::len);
        let prefix = 1 + self.nick.len() + 1 + user + 1 + host + 1;
        let envelope = command.len() + 1 + target.len() + 2 + 2;
        let ctcp = if action { "\u{1}ACTION \u{1}".len() } else { 0 };
        MAX_MESSAGE_BYTES
            .saturating_sub(prefix + envelope + ctcp)
            .max(1)
    }

    fn qualify_channel(&self, name: &str) -> String {
        match self.isupport.is_channel(name) {
            true => name.to_string(),
            false => {
                let marker = self.isupport.chantypes.chars().next().unwrap_or('#');
                format!("{marker}{name}")
            }
        }
    }
}

/// Sends whatever the user configured as a connect command, taking a leading
/// slash off so `/mode sykk +i` and `MODE sykk +i` both work.
pub(crate) fn connect_command(line: &str) -> Option<String> {
    let line = line.trim().trim_start_matches('/');
    if line.is_empty() {
        return None;
    }
    let (command, args) = line.split_once(' ').unwrap_or((line, ""));
    let params: Vec<&str> = match args.split_once(" :") {
        Some((head, trailing)) => head
            .split_whitespace()
            .chain(std::iter::once(trailing))
            .collect(),
        None => args.split_whitespace().collect(),
    };
    build(&command.to_ascii_uppercase(), &params)
}
