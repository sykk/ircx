use ircx_ipc::{ChatMessage, CommandOutcome, Delivery, MessageKind, Query, SaslMechanism};
use ircx_proto::{MessageBuilder, MAX_MESSAGE_BYTES};
use uuid::Uuid;

use crate::multiline;
use crate::session::{build, Action, AwaySource, SaslCredentials, SessionState, SERVER_TARGET};
use crate::text;

/// What a bare `/away` says on a network that has no default of its own.
///
/// A reason is not optional the way `PART`'s and `QUIT`'s are: `AWAY` with an
/// empty trailing parameter is how several servers read "back", so there is
/// nothing to send that means away and says nothing.
pub(crate) const DEFAULT_AWAY: &str = "Away";

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
/redact <msgid> [reason]  withdraw a message you sent
/nick <nick>              change your nickname
/setname <text>           change the real name a whois shows
/topic [text]             read or set the topic
/mode [target] <modes>    read or set modes
/kick <nick> [reason]     remove someone from the channel
/kickban <nick> [reason]  ban the nick and remove them
/op <nick>...             give channel operator
/deop <nick>...           take it away
/voice <nick>...          give voice
/devoice <nick>...        take it away
/ban [nick|mask]...       ban, or read the list with no argument
/unban <mask>...          lift a ban
/names [#channel]         who is in it, as the server has it
/cycle [#channel]         leave and come straight back
/knock <#channel> [text]  ask to be let into an invite-only channel
/oper <name> <password>   take server operator
/list [pattern]           find channels, filtered by the server
/invite <nick> [#channel] invite someone in
/whois <nick>             look someone up
/whowas <nick>            look up somebody who has gone
/verify [account] <code>  finish registering an account
/away [reason]            mark yourself away
/back                     come back
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

    /// Keeps the key for reconnect and `/cycle`. The keyring is updated only
    /// when the server confirms the join; a rejected key must not replace the
    /// last one that worked.
    pub(crate) fn send_join(&mut self, channel: &str, key: Option<&str>) {
        let folded = self.fold(channel);
        match key {
            Some(key) => self.channel_keys.insert(folded.clone(), key.to_string()),
            None => self.channel_keys.remove(&folded),
        };
        match key {
            Some(key) => self.send_command("JOIN", &[channel, key]),
            None => self.send_command("JOIN", &[channel]),
        }
    }

    /// The key this session last joined a channel with, if it has one.
    fn channel_key(&self, channel: &str) -> Option<String> {
        self.channel_keys.get(&self.fold(channel)).cloned()
    }

    /// The network's own default stands in for a reason nobody typed, and no
    /// reason at all is what is sent when it has none either. `PART` and `QUIT`
    /// are both allowed to carry nothing, and a client that supplies its own
    /// name there — which this one did — signs everybody off with an
    /// advertisement they did not write.
    fn send_part(&mut self, channel: &str, reason: Option<&str>) {
        let default = self.config.part_message.clone();
        match reason.or(default.as_deref()) {
            Some(reason) => self.send_command("PART", &[channel, reason]),
            None => self.send_command("PART", &[channel]),
        }
    }

    fn send_quit(&mut self, reason: Option<&str>) {
        let default = self.config.quit_message.clone();
        match reason.or(default.as_deref()) {
            Some(reason) => self.send_command("QUIT", &[reason]),
            None => self.send_command("QUIT", &[]),
        }
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
                // Through `send_part`, because leaving is leaving: the channel
                // sees the same line whether the reader typed `/part` or closed
                // the conversation.
                self.send_part(&channel.name, None);
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

    /// Registers an account with the network: by the capability where there is
    /// one, and by NickServ where there is not.
    ///
    /// `draft/account-registration` is the same act the guided Libera flow was
    /// already performing by hand. What it changes is who knows the rules — the
    /// server says whether it takes registrations at all, whether an account may
    /// be named anything but the current nick, and whether it wants an email,
    /// instead of this client holding one network's answers to those. Where the
    /// capability is absent the message to NickServ is still what works, which
    /// is the ordinary bargain: a missing capability reduces what is offered
    /// rather than failing.
    ///
    /// Either way the SASL PLAIN login is saved, because registering an account
    /// this client then cannot sign in with is half a job.
    pub fn register_account(
        &mut self,
        account: &str,
        password: &str,
        email: &str,
    ) -> Result<Vec<Action>, String> {
        if password.is_empty() {
            return Err(format!(
                "Enter a password for the {} account",
                self.network_name()
            ));
        }
        if !self.registered {
            return Err(format!(
                "{} is not ready yet — wait until it is connected",
                self.network_name()
            ));
        }

        if self.caps.is_enabled(REGISTRATION) {
            let offered = self.caps.value(REGISTRATION);
            if !offers(offered, "custom-account-name") && !self.is_me(account) {
                return Err(self.must_be_the_nick());
            }
            if offers(offered, "email-required") && email.is_empty() {
                return Err(format!(
                    "{} needs an email address to register an account",
                    self.network_name()
                ));
            }
            self.remember_registration(account, password, email);
            // `*` is the spelling for an email the server did not ask for.
            let address = match email.is_empty() {
                true => "*",
                false => email,
            };
            self.send_command("REGISTER", &[account, address, password]);
            return Ok(self.drain());
        }

        // No capability, so the account service is the only way in. Atheme's
        // syntax, which is what Libera and the networks like it answer; a
        // server running something else says so in its own words and the reply
        // is drawn like any other.
        if email.is_empty() {
            return Err(format!(
                "Enter an email address for the {} account",
                self.network_name()
            ));
        }
        if !self.is_me(account) {
            return Err(self.must_be_the_nick());
        }
        self.remember_registration(account, password, email);
        self.send_command(
            "PRIVMSG",
            &["NickServ", &format!("REGISTER {password} {email}")],
        );
        Ok(self.drain())
    }

    fn must_be_the_nick(&self) -> String {
        format!(
            "{} registers the nick currently in use ({}). Enter that nick or change it first.",
            self.network_name(),
            self.nick
        )
    }

    /// Saves the login the registration is for, and holds the two values a
    /// reply may echo so the raw log does not carry them.
    fn remember_registration(&mut self, account: &str, password: &str, email: &str) {
        self.config.sasl = Some(SaslCredentials {
            mechanism: SaslMechanism::Plain,
            account: account.to_string(),
            password: Some(password.to_string()),
        });
        self.registration_secrets = Some((password.to_string(), email.to_string()));
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
            "redact" => self.cmd_redact(target, args),
            "me" => self.cmd_me(target, args, reply_to),
            "query" => self.cmd_query(args),
            "nick" => self.one_argument("NICK", args, "/nick <nickname>"),
            "setname" => self.cmd_setname(args),
            "topic" => self.cmd_topic(target, args),
            "mode" => self.cmd_mode(target, args),
            "kick" => self.cmd_kick(target, args),
            "kickban" => self.cmd_kickban(target, args),
            "op" => self.cmd_status(target, args, "+o", "/op <nick>..."),
            "deop" => self.cmd_status(target, args, "-o", "/deop <nick>..."),
            "voice" => self.cmd_status(target, args, "+v", "/voice <nick>..."),
            "devoice" => self.cmd_status(target, args, "-v", "/devoice <nick>..."),
            "ban" => self.cmd_ban(target, args, true),
            "unban" => self.cmd_ban(target, args, false),
            "names" => self.cmd_names(target, args),
            "cycle" => self.cmd_cycle(target, args),
            "knock" => self.cmd_knock(args),
            "oper" => self.cmd_oper(args),
            "invite" => self.cmd_invite(target, args),
            "list" => self.cmd_list(args),
            "whois" => self.one_argument("WHOIS", args, "/whois <nickname>"),
            "whowas" => self.one_argument("WHOWAS", args, "/whowas <nickname>"),
            "verify" => self.cmd_verify(args),
            "away" => self.cmd_away(args),
            "back" => self.cmd_back(),
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

    /// Refused rather than sent where the capability is off: a `SETNAME` the
    /// server has no command for comes back as an unknown-command numeric that
    /// names it and explains nothing about the name.
    fn cmd_setname(&mut self, args: &str) -> CommandOutcome {
        if args.is_empty() {
            return CommandOutcome::Rejected("`/setname <text>` needs a name".into());
        }
        if !self.caps.is_enabled("setname") {
            return CommandOutcome::Rejected(format!(
                "{} does not offer setname. Change the real name in this network's settings and reconnect.",
                self.network_name()
            ));
        }
        self.send_command("SETNAME", &[args]);
        CommandOutcome::Handled
    }

    /// Finishes a registration the server sent a code out for.
    ///
    /// A command rather than another field on the form, because the code
    /// arrives by email some minutes later and the settings dialog is shut by
    /// then. The account is optional and defaults to the nick, which is what it
    /// is on every server that does not offer `custom-account-name`.
    ///
    /// There is no `/register` beside it on purpose: a command typed into the
    /// composer is kept by the recall list, and a password does not belong
    /// there. Registering stays on the form, which holds neither.
    fn cmd_verify(&mut self, args: &str) -> CommandOutcome {
        if !self.caps.is_enabled(REGISTRATION) {
            return CommandOutcome::Rejected(format!(
                "{} does not verify accounts from the client. Follow what it sent you instead.",
                self.network_name()
            ));
        }
        let (account, code) = match args.split_once(char::is_whitespace) {
            Some((account, code)) => (account.to_string(), code.trim()),
            None => (self.nick.clone(), args),
        };
        if code.is_empty() {
            return CommandOutcome::Rejected("`/verify [account] <code>` needs a code".into());
        }
        self.send_command("VERIFY", &[&account, code]);
        CommandOutcome::Handled
    }

    /// `+o`, `-o`, `+v`, `-v` for each name given.
    ///
    /// One `MODE` per name rather than the several a server would take at
    /// once. How many that is is `MODES` in `ISUPPORT`, which this client does
    /// not read, and the number below it is three — so a line packing four
    /// would be refused on the servers that say the least about themselves.
    /// Two lines that work beat one that might not.
    fn cmd_status(&mut self, target: &str, args: &str, mode: &str, usage: &str) -> CommandOutcome {
        if !self.isupport.is_channel(target) {
            return CommandOutcome::Rejected(format!("`{usage}` only works in a channel"));
        }
        let nicks: Vec<&str> = args.split_whitespace().collect();
        if nicks.is_empty() {
            return CommandOutcome::Rejected(format!("`{usage}` needs a name"));
        }
        for nick in nicks {
            self.send_command("MODE", &[target, mode, nick]);
        }
        CommandOutcome::Handled
    }

    /// Bans, lifts them, and with no argument asks who is banned.
    ///
    /// The bare form is the question `/ignore` answers the same way, and the
    /// server answers it: `MODE #channel +b` with nothing after it is how the
    /// list is asked for, and the reply already draws.
    fn cmd_ban(&mut self, target: &str, args: &str, adding: bool) -> CommandOutcome {
        let usage = match adding {
            true => "/ban [nick|mask]...",
            false => "/unban <mask>...",
        };
        if !self.isupport.is_channel(target) {
            return CommandOutcome::Rejected(format!("`{usage}` only works in a channel"));
        }
        let masks: Vec<String> = args.split_whitespace().map(ban_mask).collect();
        if masks.is_empty() {
            if !adding {
                return CommandOutcome::Rejected(format!("`{usage}` needs a mask"));
            }
            self.send_command("MODE", &[target, "+b"]);
            return CommandOutcome::Handled;
        }
        let mode = match adding {
            true => "+b",
            false => "-b",
        };
        for mask in masks {
            self.send_command("MODE", &[target, mode, &mask]);
        }
        CommandOutcome::Handled
    }

    /// The ban goes first, so the door is shut before they are put through it.
    /// The other order is a race the kicked party can win.
    fn cmd_kickban(&mut self, target: &str, args: &str) -> CommandOutcome {
        if !self.isupport.is_channel(target) {
            return CommandOutcome::Rejected("`/kickban` only works in a channel".into());
        }
        let (nick, reason) = args.split_once(' ').unwrap_or((args, ""));
        if nick.is_empty() {
            return CommandOutcome::Rejected("`/kickban <nick> [reason]` needs a name".into());
        }
        self.send_command("MODE", &[target, "+b", &ban_mask(nick)]);
        match reason.trim().is_empty() {
            true => self.send_command("KICK", &[target, nick]),
            false => self.send_command("KICK", &[target, nick, reason.trim()]),
        }
        CommandOutcome::Handled
    }

    /// Asks who is in a channel and draws the answer.
    ///
    /// The member list beside the conversation is the same fact continuously,
    /// so this is not how anybody finds out who is here. What it is for is the
    /// two lists disagreeing: this asks the server again and writes down what
    /// it said, which is the only way to see that they have.
    fn cmd_names(&mut self, target: &str, args: &str) -> CommandOutcome {
        let channel = match self.isupport.is_channel(args) {
            true => args.to_string(),
            false => target.to_string(),
        };
        if !self.isupport.is_channel(&channel) {
            return CommandOutcome::Rejected("`/names [#channel]` only works in a channel".into());
        }
        self.named.insert(self.fold(&channel));
        self.send_command("NAMES", &[&channel]);
        CommandOutcome::Handled
    }

    /// Leaves and rejoins, which is what clears a mode somebody set on you.
    ///
    /// No key is sent, the same as the rejoin after a reconnect: this client
    /// does not keep the one a channel was joined with, so a `+k` channel is
    /// left rather than cycled. That is a gap in both paths and is not this
    /// command's to close.
    fn cmd_cycle(&mut self, target: &str, args: &str) -> CommandOutcome {
        let channel = match self.isupport.is_channel(args) {
            true => args.to_string(),
            false => target.to_string(),
        };
        if !self.isupport.is_channel(&channel) {
            return CommandOutcome::Rejected("`/cycle [#channel]` only works in a channel".into());
        }
        // Read before the part, and handed back to the join: without it a
        // `+k` channel is left rather than cycled, which is the whole of what
        // this command must not do.
        let key = self.channel_key(&channel);
        self.send_part(&channel, None);
        self.send_join(&channel, key.as_deref());
        CommandOutcome::Handled
    }

    /// Asks to be let into a channel. Named explicitly, because knocking is
    /// what you do at one you are not in.
    fn cmd_knock(&mut self, args: &str) -> CommandOutcome {
        let (channel, reason) = args.split_once(' ').unwrap_or((args, ""));
        if !self.isupport.is_channel(channel) {
            return CommandOutcome::Rejected("`/knock <#channel> [text]` needs a channel".into());
        }
        match reason.trim().is_empty() {
            true => self.send_command("KNOCK", &[channel]),
            false => self.send_command("KNOCK", &[channel, reason.trim()]),
        }
        CommandOutcome::Handled
    }

    /// Takes server operator.
    ///
    /// The password is a positional argument, so this is the one command here
    /// that carries a secret. `redact` keeps it out of the raw log, and
    /// `carriesACredential` in the composer keeps the line out of the recall
    /// list, which is the same leak by a shorter route.
    fn cmd_oper(&mut self, args: &str) -> CommandOutcome {
        let Some((name, password)) = args.split_once(' ') else {
            return CommandOutcome::Rejected("`/oper <name> <password>` needs both".into());
        };
        let password = password.trim();
        if name.is_empty() || password.is_empty() {
            return CommandOutcome::Rejected("`/oper <name> <password>` needs both".into());
        }
        self.send_command("OPER", &[name, password]);
        CommandOutcome::Handled
    }

    /// Withdraws a message.
    ///
    /// Whether it may be withdrawn is the server's answer and not this
    /// client's: an operator may take away somebody else's line, a window may
    /// have closed on your own, and both come back as a `FAIL REDACT` that
    /// already draws. So nothing here checks who sent what — sending the line
    /// and reading the refusal is the only account of the rules that is not a
    /// guess about them.
    fn cmd_redact(&mut self, target: &str, args: &str) -> CommandOutcome {
        let (msgid, reason) = args.split_once(' ').unwrap_or((args, ""));
        if msgid.is_empty() {
            return CommandOutcome::Rejected("`/redact <msgid> [reason]` needs a message".into());
        }
        if target == SERVER_TARGET {
            return CommandOutcome::Rejected(
                "This tab is the server's, not a conversation. A redaction is addressed to the channel or person the message was in.".into(),
            );
        }
        if !self.caps.is_enabled(REDACTION) {
            return CommandOutcome::Rejected(format!(
                "{} does not offer message redaction, so a message cannot be withdrawn here.",
                self.network_name()
            ));
        }
        let reason = reason.trim();
        match reason.is_empty() {
            true => self.send_command("REDACT", &[target, msgid]),
            false => self.send_command("REDACT", &[target, msgid, reason]),
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

    /// `/away` marks you away and `/back` is the only thing that clears it.
    ///
    /// Bare `/away` used to mean "back", which is how irssi and weechat read
    /// it and is one command rather than two. It cannot stay that way and also
    /// have a default reason: a client says it is back by sending `AWAY` with
    /// nothing after it, so the bare form has to be one or the other. It is
    /// the away half, because that is the one somebody types twenty times a
    /// day and the one a stored reason is for.
    fn cmd_away(&mut self, args: &str) -> CommandOutcome {
        let reason = match args.is_empty() {
            false => args.to_string(),
            true => self
                .config
                .away_message
                .clone()
                .unwrap_or_else(|| DEFAULT_AWAY.to_string()),
        };
        self.send_command("AWAY", &[&reason]);
        self.set_away_source(Some(AwaySource::Reader));
        CommandOutcome::Handled
    }

    fn cmd_back(&mut self) -> CommandOutcome {
        self.send_command("AWAY", &[]);
        self.set_away_source(None);
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

/// Named once, because the command, the form behind it and the reply handler
/// all ask about the same capability.
pub(crate) const REGISTRATION: &str = "draft/account-registration";

/// Named once, for the command and the reply handler both.
pub(crate) const REDACTION: &str = "draft/message-redaction";

/// Whether the capability's value carries this key. The value is a
/// comma-separated list whose items are a bare key or `key=value`.
fn offers(value: Option<&str>, key: &str) -> bool {
    let Some(value) = value else {
        return false;
    };
    value.split(',').any(|item| {
        let name = item.split_once('=').map_or(item, |(name, _)| name);
        name.trim().eq_ignore_ascii_case(key)
    })
}

/// A nickname becomes the mask that bans whoever is answering to it. Anything
/// already carrying `!`, `@` or `*` is a mask somebody wrote out, and is theirs
/// rather than this function's to get right.
fn ban_mask(argument: &str) -> String {
    match argument.contains(['!', '@', '*']) {
        true => argument.to_string(),
        false => format!("{argument}!*@*"),
    }
}

/// The commands ircx answers itself. A plugin cannot take one of these over:
/// the routing in `plugins.rs` looks here first. Every name in the match in
/// `dispatch` belongs in this list, or a plugin declaring that name steals it.
pub(crate) const BUILTIN: &[&str] = &[
    "join", "j", "part", "leave", "msg", "notice", "ctcp", "react", "unreact", "me", "query",
    "nick", "topic", "mode", "kick", "invite", "list", "whois", "whowas", "away", "ignore",
    "unignore", "watch", "quit", "raw", "quote", "close", "help", "back", "verify", "kickban",
    "redact", "op", "deop", "voice", "devoice", "ban", "unban", "names", "cycle", "knock", "oper",
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
