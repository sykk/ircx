use ircx_ipc::{ChatMessage, CommandOutcome, Delivery, MessageKind, Query};
use ircx_proto::{MessageBuilder, MAX_MESSAGE_BYTES};
use uuid::Uuid;

use crate::multiline;
use crate::session::{build, Action, SessionState, SERVER_TARGET};
use crate::text;

/// What `/help` prints. It lists `/connect` and `/disconnect` although this
/// table answers to neither: they act on the connection rather than travelling
/// over it, so the window performs them, and a reader asking what ircx knows
/// does not care which layer answers.
const HELP: &str = "\
/join #channel [key]      join a channel
/part [#channel] [reason] leave it
/msg <target> <text>      send without opening a tab
/query <nick> [text]      open a tab for one person
/me <action>              speak in the third person
/notice <target> <text>   send a notice
/ctcp <nick> <cmd> [args] send a CTCP query
/react <msgid> <value>    react to a message
/unreact <msgid> <value>  take that reaction back
/nick <nick>              change your nickname
/topic [text]             read or set the topic
/mode [target] <modes>    read or set modes
/kick <nick> [reason]     remove someone from the channel
/list [pattern]           find channels, filtered by the server
/invite <nick> [#channel] invite someone in
/whois <nick>             look someone up
/away [reason]            mark yourself away, or back
/ignore [nick]            stop hearing from somebody, or list who is ignored
/unignore <nick>          hear from them again
/watch [nick|-nick]       follow a nickname, remove with -nick, or list
/quit [reason]            disconnect
/raw <line>               send a line to the server untouched
/close [target]           close a conversation and forget it
/connect                  connect this network
/disconnect [reason]      disconnect it, leaving its conversations open
/help                     this list";

impl SessionState {
    /// Composer input: a slash command, or text to say in `target`.
    ///
    /// `reply_to` is the server `msgid` of the message being answered, which
    /// only the arms that say something use. `/msg` and `/query` address
    /// somebody else, so a parent staged in this conversation does not follow
    /// them there.
    pub fn submit(
        &mut self,
        target: &str,
        input: &str,
        reply_to: Option<&str>,
    ) -> (CommandOutcome, Vec<Action>) {
        let outcome = self.dispatch(target, input, reply_to);
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

    /// Leaves the channel if we are still in it and drops what we held for it,
    /// including its place in the set of conversations a restart reopens.
    pub fn close_target(&mut self, target: &str) -> Vec<Action> {
        self.cmd_close(target);
        self.drain()
    }

    fn cmd_close(&mut self, target: &str) {
        let key = self.fold(target);
        self.read_markers.remove(&key);
        self.unread_at.remove(&key);
        if let Some(channel) = self.channels.remove(&key) {
            if channel.joined {
                self.send_command("PART", &[&channel.name]);
            }
            self.actions.push(Action::Forget(channel.name.clone()));
            self.emit(ircx_ipc::IrcxEvent::ChannelRemoved {
                network: self.network_id().clone(),
                name: channel.name,
            });
        }
        if let Some(query) = self.queries.remove(&key) {
            self.unmonitor(&key, &query.nick);
            self.actions.push(Action::Forget(query.nick.clone()));
            self.emit(ircx_ipc::IrcxEvent::QueryRemoved {
                network: self.network_id().clone(),
                nick: query.nick,
            });
            self.sync_monitor();
        }
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
    ///
    /// Labelled where the server will carry one, and the label is the whole of
    /// #591: a channel that refuses the notification answers with a `404`, and
    /// an answer that cannot be told from the answer to a message was described
    /// to the reader as their message having been refused — twice a line,
    /// before they had sent one. What this client labels, it can recognise.
    ///
    /// The cost is an `ACK` where the server has `labeled-response` and not
    /// `echo-message`, which is the only answer a notification draws when it is
    /// taken. Nothing is drawn for one, and it is the price of not lying about
    /// the refusal.
    pub fn set_typing(&mut self, target: &str, active: bool) -> Vec<Action> {
        if self.caps.is_enabled("message-tags") {
            let state = if active { "active" } else { "done" };
            let label = self
                .caps
                .is_enabled("labeled-response")
                .then(|| self.next_label());
            let mut builder = MessageBuilder::new("TAGMSG")
                .tag("+typing", Some(state.into()))
                .param(target);
            if let Some(label) = label.clone() {
                builder = builder.tag("label", Some(label));
            }
            if let Ok(message) = builder.build() {
                self.send_line(message.to_line());
                if let Some(label) = label {
                    self.sent_typing_as(label);
                }
            }
        }
        self.drain()
    }

    /// Reacts to `message`, or takes that reaction back. `message` is a server
    /// `msgid`; a locally minted id names nothing anyone else can resolve.
    ///
    /// Silent without `message-tags`, like typing above it. The sender's own
    /// copy is emitted here rather than waited for: only `echo-message` would
    /// bring one back, and a reaction everyone sees except the person who sent
    /// it is worse than none.
    pub fn react(&mut self, target: &str, message: &str, emoji: &str, active: bool) -> Vec<Action> {
        if self.caps.is_enabled("message-tags") {
            self.send_react(target, message, emoji, active);
        }
        self.drain()
    }

    /// The capability check belongs to the callers: `react` above is silent
    /// without `message-tags` because nothing asked for it, while `/react`
    /// below says why, because someone typed it.
    fn send_react(&mut self, target: &str, message: &str, emoji: &str, active: bool) {
        if message.is_empty() || emoji.is_empty() {
            return;
        }
        let tag = match active {
            true => "+draft/react",
            false => "+draft/unreact",
        };
        if let Ok(line) = MessageBuilder::new("TAGMSG")
            .tag("+reply", Some(message.to_string()))
            .tag(tag, Some(emoji.to_string()))
            .param(target)
            .build()
        {
            self.send_line(line.to_line());
            self.emit(ircx_ipc::IrcxEvent::ReactionChanged {
                network: self.network_id().clone(),
                target: target.to_string(),
                message: message.to_string(),
                nick: self.nick.clone(),
                emoji: emoji.to_string(),
                active,
            });
        }
    }

    pub(crate) fn dispatch(
        &mut self,
        target: &str,
        input: &str,
        reply_to: Option<&str>,
    ) -> CommandOutcome {
        if !self.registered && (!input.starts_with('/') || input.starts_with("//")) {
            return CommandOutcome::Rejected(format!(
                "Not connected to {} yet",
                self.network_name()
            ));
        }
        let Some(rest) = input.strip_prefix('/') else {
            return self.say_here(target, input, MessageKind::Privmsg, reply_to);
        };
        // `//` is how you start a message with a slash.
        if let Some(text) = rest.strip_prefix('/') {
            return self.say_here(target, &format!("/{text}"), MessageKind::Privmsg, reply_to);
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
            "ctcp" => self.cmd_ctcp(target, args),
            "react" => self.cmd_react(target, args, true),
            "unreact" => self.cmd_react(target, args, false),
            "me" => self.cmd_me(target, args, reply_to),
            "query" => self.cmd_query(args),
            "nick" => self.one_argument("NICK", args, "/nick <nickname>"),
            "topic" => self.cmd_topic(target, args),
            "mode" => self.cmd_mode(target, args),
            "kick" => self.cmd_kick(target, args),
            "invite" => self.cmd_invite(target, args),
            "list" => self.cmd_list(args),
            "whois" => self.one_argument("WHOIS", args, "/whois <nickname>"),
            "away" => self.cmd_away(args),
            "ignore" => self.cmd_ignore(target, args),
            "unignore" => self.cmd_unignore(target, args),
            "watch" => self.cmd_watch(target, args),
            "quit" => {
                self.send_quit((!args.is_empty()).then_some(args));
                CommandOutcome::Handled
            }
            "raw" | "quote" => self.cmd_raw(args),
            "close" => self.cmd_close_here(target, args),
            "help" => self.cmd_help(target),
            other => CommandOutcome::Rejected(format!(
                "`/{other}` is not a command ircx knows. `/help` lists the ones it does."
            )),
        }
    }

    /// Closes a conversation and forgets it, so a restart does not reopen it.
    ///
    /// The window has had this since #121, by right-clicking the sidebar row;
    /// #158 is that the typed form was offered by the palette and did not
    /// exist. Naming one is for closing a conversation you are not looking at.
    fn cmd_close_here(&mut self, target: &str, args: &str) -> CommandOutcome {
        let named = args.split_whitespace().next().unwrap_or(target);
        if named == SERVER_TARGET {
            return CommandOutcome::Rejected(
                "This tab is the server's, and closing it would leave the network with nowhere to speak.".into(),
            );
        }
        let key = self.fold(named);
        if !self.channels.contains_key(&key) && !self.queries.contains_key(&key) {
            return CommandOutcome::Rejected(format!(
                "`{named}` is not a conversation that is open"
            ));
        }
        self.cmd_close(named);
        CommandOutcome::Handled
    }

    /// The list goes into the tab it was asked for, as client notes, so it
    /// lands where the user is looking and scrolls like everything else there.
    fn cmd_help(&mut self, target: &str) -> CommandOutcome {
        self.note_block(target, HELP);
        CommandOutcome::Handled
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
        for message in self.say(target, text, kind, None) {
            self.append(message);
        }
        CommandOutcome::Handled
    }

    /// `/ctcp sable version` sends `\x01VERSION\x01` in a private message. In a
    /// query tab, `/ctcp version` uses the person being spoken with.
    fn cmd_ctcp(&mut self, target: &str, args: &str) -> CommandOutcome {
        let args = args.trim();
        if args.is_empty() {
            return CommandOutcome::Rejected(
                "`/ctcp <nick> <command> [args]` needs a nick and a command".into(),
            );
        }

        let (nick, command, parameter) = {
            let mut words = args.splitn(3, ' ');
            let first = words.next().unwrap_or("").trim();
            let second = words.next();
            let third = words.next().unwrap_or("").trim();

            match second {
                Some(command) => (
                    first.to_string(),
                    command.trim().to_string(),
                    third.to_string(),
                ),
                None if target != SERVER_TARGET && !self.isupport.is_channel(target) => {
                    (target.to_string(), first.to_string(), String::new())
                }
                None => {
                    return CommandOutcome::Rejected(
                        "`/ctcp <nick> <command> [args]` needs a nick and a command".into(),
                    );
                }
            }
        };

        if nick.is_empty() || command.is_empty() {
            return CommandOutcome::Rejected(
                "`/ctcp <nick> <command> [args]` needs a nick and a command".into(),
            );
        }
        if command.contains('\0') || parameter.contains('\0') {
            return CommandOutcome::Rejected("CTCP cannot carry a null byte".into());
        }

        if !self.isupport.is_channel(&nick) {
            self.touch_query(&nick, None);
        }

        let body = text::ctcp_wrap(&command.to_ascii_uppercase(), parameter.trim());
        match MessageBuilder::new("PRIVMSG")
            .param(&nick)
            .param(body)
            .build()
        {
            Ok(message) => {
                self.send_line(message.to_line());
            }
            Err(_) => {
                return CommandOutcome::Rejected(format!(
                    "`{nick}` is not a target ircx can send to"
                ));
            }
        }
        CommandOutcome::Handled
    }

    /// The timeline sends every reaction through here, spelling the msgid it
    /// already holds, so a click and a typed line take one path. The value is
    /// the rest of the line rather than one word: the `react` tag puts no
    /// restriction on it, and `hear hear` is a reaction.
    fn cmd_react(&mut self, target: &str, args: &str, active: bool) -> CommandOutcome {
        let verb = if active { "react" } else { "unreact" };
        let usage = format!("`/{verb} <msgid> <value>` needs both");

        let Some((message, value)) = args.split_once(' ') else {
            return CommandOutcome::Rejected(usage);
        };
        let value = value.trim();
        if message.is_empty() || value.is_empty() {
            return CommandOutcome::Rejected(usage);
        }
        if target == SERVER_TARGET {
            return CommandOutcome::Rejected(
                "This tab is the server's, not a conversation. A reaction is addressed to the channel or person the message was in.".into(),
            );
        }
        if !self.caps.is_enabled("message-tags") {
            return CommandOutcome::Rejected(format!(
                "{} does not offer message-tags, so reactions cannot be sent here.",
                self.network_name()
            ));
        }

        self.send_react(target, message, value, active);
        CommandOutcome::Handled
    }

    fn cmd_me(&mut self, target: &str, args: &str, reply_to: Option<&str>) -> CommandOutcome {
        if args.is_empty() {
            return CommandOutcome::Rejected("`/me <action>` needs something to do".into());
        }
        self.say_here(target, args, MessageKind::Action, reply_to)
    }

    fn cmd_query(&mut self, args: &str) -> CommandOutcome {
        let (nick, text) = args.split_once(' ').unwrap_or((args, ""));
        if nick.is_empty() {
            return CommandOutcome::Rejected("`/query <nickname>` needs a nickname".into());
        }
        self.touch_query(nick, None);
        if !text.trim().is_empty() {
            for message in self.say(nick, text, MessageKind::Privmsg, None) {
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

    /// The channel is the tab it was typed in unless a second word names one,
    /// which is how the header's invite control spells it.
    fn cmd_invite(&mut self, target: &str, args: &str) -> CommandOutcome {
        let mut parts = args.split_whitespace();
        let Some(nick) = parts.next() else {
            return CommandOutcome::Rejected("`/invite <nickname> [#channel]` needs a name".into());
        };
        let channel = parts.next().unwrap_or(target);
        if !self.isupport.is_channel(channel) {
            return CommandOutcome::Rejected(
                "`/invite` needs a channel: name one, or run it in the channel's tab".into(),
            );
        }
        self.send_command("INVITE", &[nick, channel]);
        CommandOutcome::Handled
    }

    /// A pattern is worth passing on: it is the difference between the handful
    /// of channels somebody is looking for and the twenty thousand a network
    /// has. What comes back is collected rather than printed — see #125.
    fn cmd_list(&mut self, args: &str) -> CommandOutcome {
        match args.is_empty() {
            true => self.send_command("LIST", &[]),
            false => self.send_command("LIST", &[args]),
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

    /// Stops hearing from somebody, or says who is already ignored.
    ///
    /// The list is the answer to no argument because that is the question a
    /// bare `/ignore` asks. It is the one of the two that goes to the server
    /// tab: who is ignored is a fact about the network, and the same list typed
    /// in four channels would leave four copies of it in the archive. The
    /// confirmation goes where it was typed, because the person who typed it is
    /// reading there and the whole of what they will see otherwise is somebody
    /// they were talking to going quiet.
    fn cmd_ignore(&mut self, target: &str, args: &str) -> CommandOutcome {
        let Some(nick) = args.split_whitespace().next() else {
            let mut nicks = self.ignored.clone();
            nicks.sort_by_key(|nick| nick.to_lowercase());
            let text = match nicks.is_empty() {
                true => "Nobody is ignored on this network.".to_string(),
                false => format!("Ignored on this network: {}", nicks.join(", ")),
            };
            self.note(SERVER_TARGET, MessageKind::Client, text);
            return CommandOutcome::Handled;
        };
        if self.fold(nick) == self.fold(&self.nick) {
            return CommandOutcome::Rejected("You cannot ignore yourself.".into());
        }
        if self.is_ignored(nick) {
            return CommandOutcome::Rejected(format!("{nick} is already ignored."));
        }
        self.ignore(nick, true);
        self.note(
            target,
            MessageKind::Client,
            format!("Ignoring {nick}. Nothing they say from now on is kept."),
        );
        CommandOutcome::Handled
    }

    /// Hears from somebody again. What they said while ignored is gone rather
    /// than hidden, so the note says so: nothing comes back.
    fn cmd_unignore(&mut self, target: &str, args: &str) -> CommandOutcome {
        let Some(nick) = args.split_whitespace().next() else {
            return CommandOutcome::Rejected("`/unignore <nick>` needs a nickname".into());
        };
        if !self.is_ignored(nick) {
            return CommandOutcome::Rejected(format!("{nick} is not ignored."));
        }
        self.ignore(nick, false);
        // In the conversation, unlike the list: this one answers something the
        // reader just typed there, and there is one of it.
        self.note(
            target,
            MessageKind::Client,
            format!("No longer ignoring {nick}. What they said meanwhile was not kept."),
        );
        CommandOutcome::Handled
    }

    fn cmd_watch(&mut self, target: &str, args: &str) -> CommandOutcome {
        let Some(argument) = args.split_whitespace().next() else {
            let mut nicks = self.watched.clone();
            nicks.sort_by_key(|nick| nick.to_lowercase());
            let text = match nicks.is_empty() {
                true => "Nobody is watched on this network.".to_string(),
                false => format!("Watched on this network: {}", nicks.join(", ")),
            };
            self.note(SERVER_TARGET, MessageKind::Client, text);
            return CommandOutcome::Handled;
        };
        let (nick, watched) = match argument.strip_prefix('-') {
            Some("") => {
                return CommandOutcome::Rejected(
                    "`/watch -<nick>` needs a nickname after the hyphen".into(),
                );
            }
            Some(nick) => (nick, false),
            None => (argument, true),
        };
        if self.fold(nick) == self.fold(&self.nick) {
            return CommandOutcome::Rejected("You cannot watch yourself.".into());
        }
        if self.is_watched(nick) == watched {
            return CommandOutcome::Rejected(match watched {
                true => format!("{nick} is already watched."),
                false => format!("{nick} is not watched."),
            });
        }
        self.watch(nick, watched);
        self.note(
            target,
            MessageKind::Client,
            match watched {
                true => format!("Watching {nick}."),
                false => format!("No longer watching {nick}."),
            },
        );
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
    fn say_here(
        &mut self,
        target: &str,
        text: &str,
        kind: MessageKind,
        reply_to: Option<&str>,
    ) -> CommandOutcome {
        if text.trim().is_empty() {
            return CommandOutcome::Handled;
        }
        if target == SERVER_TARGET {
            return CommandOutcome::Rejected(
                "This tab is the server's, not a conversation. Try `/msg <target> <message>`."
                    .into(),
            );
        }
        let mut messages = self.say(target, text, kind, reply_to).into_iter();
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
    pub(crate) fn say(
        &mut self,
        target: &str,
        text: &str,
        kind: MessageKind,
        reply_to: Option<&str>,
    ) -> Vec<ChatMessage> {
        // What the user typed names the conversation; the conversation names
        // the message. Typing `/msg nickserv` at an open `NickServ` query would
        // otherwise file the outgoing copy where the replies are not. #190. The
        // line on the wire keeps what was typed: the server does its own
        // folding, and a target it does not know is its answer to give.
        let filed = self.canonical(target);

        let command = match kind {
            MessageKind::Notice => "NOTICE",
            _ => "PRIVMSG",
        };
        let action = kind == MessageKind::Action;
        let budget = self.wire_budget(command, target, action);
        let labels = self.caps.is_enabled("labeled-response");
        // Without `message-tags` the tag cannot travel, and a quote drawn only
        // here names a parent nobody else was shown.
        let parent = reply_to.filter(|_| self.caps.is_enabled("message-tags"));

        if !action && self.caps.is_enabled("batch") && self.caps.is_enabled("draft/multiline") {
            if let Some(limits) = self
                .caps
                .value("draft/multiline")
                .and_then(multiline::limits)
            {
                if let Some((text, components)) = multiline::components(text, budget, limits) {
                    let reference = Uuid::new_v4().simple().to_string();
                    let label = labels.then(|| self.next_label());
                    let mut opening = MessageBuilder::new("BATCH")
                        .param(format!("+{reference}"))
                        .param("draft/multiline")
                        .param(target);
                    if let Some(label) = label.clone() {
                        opening = opening.tag("label", Some(label));
                    }
                    if let Some(parent) = parent {
                        opening = opening.tag("+reply", Some(parent.to_string()));
                    }
                    let Ok(opening) = opening.build() else {
                        return Vec::new();
                    };
                    self.send_line(opening.to_line());

                    for component in components {
                        let mut builder = MessageBuilder::new(command)
                            .tag("batch", Some(reference.clone()))
                            .param(target)
                            .param(component.text);
                        if component.concat {
                            builder = builder.tag("draft/multiline-concat", None);
                        }
                        let Ok(line) = builder.build() else {
                            return Vec::new();
                        };
                        self.send_line(line.to_line());
                    }
                    let Ok(closing) = MessageBuilder::new("BATCH")
                        .param(format!("-{reference}"))
                        .build()
                    else {
                        return Vec::new();
                    };
                    let ticket = self.send_line(closing.to_line());

                    let mut message = self.local_message(&filed, kind, text);
                    message.reply_to = parent.map(str::to_string);
                    message.delivery = Delivery::Pending;
                    self.track_pending(ticket, label, message.clone());
                    return vec![message];
                }
            }
        }

        // A line break cannot travel inside a parameter — it would end the line
        // early and let what follows be read as another command — so each line
        // goes as its own message. `lines` takes the CR of a paste from another
        // window with it; IRC has no empty message, and a NUL cannot be sent.
        let pieces: Vec<String> = text
            .lines()
            .map(|line| line.replace('\0', ""))
            .filter(|line| !line.trim().is_empty())
            .flat_map(|line| text::split_for_wire(&line, budget))
            .collect();

        let mut copies = Vec::new();
        for piece in pieces {
            let body = match action {
                true => format!("\u{1}ACTION {piece}\u{1}"),
                false => piece.clone(),
            };
            let label = labels.then(|| self.next_label());
            let mut builder = MessageBuilder::new(command).param(target).param(body);
            if let Some(label) = label.clone() {
                builder = builder.tag("label", Some(label));
            }
            // Every piece of a split answers the same message. Tagging only the
            // first would leave the rest looking like they answered nothing.
            if let Some(parent) = parent {
                builder = builder.tag("+reply", Some(parent.to_string()));
            }
            let Ok(line) = builder.build() else { continue };
            let ticket = self.send_line(line.to_line());

            let mut message = self.local_message(&filed, kind, piece);
            message.reply_to = parent.map(str::to_string);
            // Queued is not sent. The rate limiter can hold this line for the
            // better part of a minute behind a paste, and `on_written` is what
            // says it left — on a server that echoes and on one that does not.
            message.delivery = Delivery::Pending;
            self.track_pending(ticket, label, message.clone());
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

/// The commands ircx answers itself. A plugin cannot take one of these over:
/// the routing in `plugins.rs` looks here first. Every name in the match in
/// `dispatch` belongs in this list, or a plugin declaring that name steals it.
pub(crate) const BUILTIN: &[&str] = &[
    "join", "j", "part", "leave", "msg", "notice", "ctcp", "react", "unreact", "me", "query",
    "nick", "topic", "mode", "kick", "invite", "list", "whois", "away", "ignore", "unignore",
    "watch", "quit", "raw", "quote", "close", "help",
];

pub(crate) fn is_builtin(name: &str) -> bool {
    BUILTIN.contains(&name)
}

/// The command and arguments in `/name args`, lowercased as `dispatch` reads
/// them. `None` for ordinary text and for `//` — an escaped leading slash.
pub(crate) fn slash_command(input: &str) -> Option<(String, &str)> {
    let rest = input.strip_prefix('/')?;
    if rest.starts_with('/') {
        return None;
    }
    let (name, args) = rest.split_once(' ').unwrap_or((rest, ""));
    match name.is_empty() {
        true => None,
        false => Some((name.to_ascii_lowercase(), args.trim())),
    }
}

/// A connect command that names something ircx answers itself, as composer
/// input — or `None` for the rest, which stay protocol lines.
///
/// Both spellings reach the same place, because both are written: a perform
/// list is where people paste `/msg nickserv identify …` from another client,
/// and where they write bare `MODE syk +i` because it is a protocol line.
///
/// Only builtins are taken. A perform list is also where raw lines live, and
/// sending those through `dispatch` would have it reject every command it has
/// no arm for — which is most of IRC.
pub(crate) fn connect_builtin(line: &str) -> Option<String> {
    let line = line.trim().trim_start_matches('/');
    let (name, _) = line.split_once(' ').unwrap_or((line, ""));
    is_builtin(&name.to_ascii_lowercase()).then(|| format!("/{line}"))
}

/// A configured connect command as the protocol line to send, taking a leading
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
