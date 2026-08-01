use std::collections::HashMap;
use std::time::Instant;

use ircx_ipc::{
    Channel, ChannelListing, ChatMessage, ConnectionStatus, Delivery, IrcxEvent, Member,
    MessageKind, MessageSource, Network, NetworkConfig, NetworkId, Query, SaslMechanism,
    SaslStatus, Sender, Severity, TargetName, Topic,
};
use ircx_net::TlsInfo;
use ircx_plugin::ArrivedMessage;
use ircx_proto::{Command, Message, MessageBuilder, Prefix};
use ircx_store::OpenTarget;
use tracing::debug;

use crate::caps::Caps;
use crate::history;
use crate::isupport::ISupport;
use crate::numeric::{self, *};
use crate::sasl;
use crate::scram;
use crate::text;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// The network's own tab: connection notes, MOTD, WHOIS output, anything the
/// server said that was not about a channel.
pub const SERVER_TARGET: &str = "*";

/// How many channels a `LIST` may leave in memory. Libera answers with about
/// twenty-two thousand; the cap is here because the count comes from the server
/// and a hostile one could stream without end.
const MAX_LISTING: usize = 50_000;

#[derive(Debug)]
pub enum Action {
    Send(String),
    /// Boxed so an action is the size of a line, not of the largest event.
    Emit(Box<IrcxEvent>),
    /// The user is in this conversation. Kept across restarts so the next
    /// launch reopens it.
    Remember(OpenTarget),
    /// The user left this conversation or closed it; drop it from that set.
    Forget(TargetName),
    /// Ask the notification rules about these messages. Pushed after the
    /// `Emit` that draws them, because a rule runs on arrival rather than on
    /// draw and nothing waits for one.
    ///
    /// The batch is built here rather than by the caller because deciding who
    /// is worth asking needs the user's own nick, which is session state.
    Notify {
        target: TargetName,
        messages: Vec<ArrivedMessage>,
    },
    /// Close the connection and stop retrying. Whatever explains it has
    /// already been emitted.
    Close,
}

/// A conversation that was open when the app last ran, and where its record
/// left off. The timestamp is what separates coming back to a conversation from
/// meeting one: everything after it was missed rather than never seen.
#[derive(Debug, Clone)]
pub struct Restored {
    pub target: OpenTarget,
    pub newest: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SaslCredentials {
    pub mechanism: SaslMechanism,
    pub account: String,
    pub password: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub network: NetworkId,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub tls_verify: bool,
    pub nick: String,
    pub alt_nicks: Vec<String>,
    pub username: String,
    pub realname: String,
    pub sasl: Option<SaslCredentials>,
    pub connect_commands: Vec<String>,
    pub autojoin: Vec<String>,
}

impl SessionConfig {
    /// `password` comes from the keyring, which `NetworkConfig` deliberately
    /// cannot carry back out of the store.
    pub fn from_network(
        network: NetworkId,
        config: &NetworkConfig,
        password: Option<String>,
    ) -> Self {
        Self {
            network,
            name: config.name.clone(),
            host: config.host.clone(),
            port: config.port,
            tls: config.tls,
            tls_verify: config.tls_verify,
            nick: config.nick.clone(),
            alt_nicks: config.alt_nicks.clone(),
            username: config.username.clone(),
            realname: config.realname.clone(),
            sasl: config.sasl.as_ref().map(|sasl| SaslCredentials {
                mechanism: sasl.mechanism,
                account: sasl.account.clone(),
                password,
            }),
            connect_commands: config.connect_commands.clone(),
            autojoin: config.autojoin.clone(),
        }
    }
}

#[derive(Debug, Default, Clone)]
pub(crate) struct MemberState {
    pub(crate) nick: String,
    pub(crate) account: Option<String>,
    pub(crate) prefixes: Vec<String>,
    pub(crate) away: Option<String>,
}

#[derive(Debug, Default)]
pub(crate) struct ChannelState {
    pub(crate) name: TargetName,
    pub(crate) topic: Option<Topic>,
    pub(crate) modes: String,
    pub(crate) joined: bool,
    /// The user asked to be in here and has not left. Survives a reconnect,
    /// which `joined` cannot: it is what the next registration rejoins.
    pub(crate) rejoin: bool,
    pub(crate) members: HashMap<String, MemberState>,
    pub(crate) names: Vec<MemberState>,
    pub(crate) unread: u32,
    pub(crate) highlights: u32,
}

#[derive(Debug)]
pub(crate) struct QueryState {
    pub(crate) nick: TargetName,
    pub(crate) account: Option<String>,
    pub(crate) unread: u32,
    pub(crate) online: bool,
}

#[derive(Debug)]
pub(crate) struct BatchState {
    pub(crate) source: MessageSource,
    pub(crate) messages: Vec<ChatMessage>,
}

#[derive(Debug)]
struct PendingSend {
    label: Option<String>,
    message: ChatMessage,
}

pub struct SessionState {
    pub(crate) config: SessionConfig,
    pub(crate) isupport: ISupport,
    pub(crate) caps: Caps,
    pub(crate) nick: String,
    pub(crate) user: Option<String>,
    pub(crate) host: Option<String>,
    pub(crate) account: Option<String>,
    pub(crate) channels: HashMap<String, ChannelState>,
    pub(crate) queries: HashMap<String, QueryState>,
    pub(crate) batches: HashMap<String, BatchState>,
    pub(crate) actions: Vec<Action>,
    pub(crate) registered: bool,
    status: ConnectionStatus,
    sasl: SaslStatus,
    /// The SCRAM exchange in flight, and whatever of a challenge has arrived so
    /// far. Only SCRAM needs either: the other mechanisms answer in one
    /// message and have nothing to remember.
    scram: Option<scram::Scram>,
    challenge: String,
    cap_ended: bool,
    nick_attempt: usize,
    pending: Vec<PendingSend>,
    next_label: u64,
    ping: Option<(String, Instant)>,
    lag_ms: Option<u32>,
    /// Collected between `321` and `323`. A `LIST` is answered with one reply
    /// per channel and a network has tens of thousands, so they are gathered
    /// and sent once rather than becoming an event and a console line each.
    listing: Vec<ChannelListing>,
    /// Where each conversation's record left off, folded target to timestamp:
    /// seeded from the archive at restore and moved on by every message that
    /// arrives. It is what a `CHATHISTORY` request asks for everything after.
    pub(crate) archived: HashMap<String, String>,
    /// The near side of "while I was away": where this client's record left off
    /// the last time it had a connection.
    ///
    /// Separate from `archived`, which every arriving message moves — including
    /// the server's own welcome, which lands in the console before anything asks
    /// what was missed and would otherwise make the gap a millisecond wide.
    /// Nothing a live connection does may move it.
    ///
    /// It is taken twice: before the first socket is opened, and again when a
    /// connection ends. A reconnect is the same question as a relaunch with a
    /// smaller gap, and leaving this at the launch value asked every reconnect
    /// for the whole session — a window that only grows, against a `TARGETS`
    /// limit that does not. #246.
    away_since: Option<String>,
    /// Conversations whose outstanding request was for a gap rather than for a
    /// first page. What comes back for one of these was missed rather than
    /// merely never seen, which is the whole of the difference to the unread
    /// count.
    /// Conversations with an outstanding gap request, and how many pages of it
    /// have come back. A page that arrives full has more behind it.
    pub(crate) gap_fills: HashMap<String, u32>,
}

impl SessionState {
    pub fn new(config: SessionConfig) -> Self {
        let sasl = match config.sasl {
            Some(_) => SaslStatus::InProgress,
            None => SaslStatus::NotConfigured,
        };
        Self {
            nick: config.nick.clone(),
            config,
            isupport: ISupport::default(),
            caps: Caps::default(),
            user: None,
            host: None,
            account: None,
            channels: HashMap::new(),
            queries: HashMap::new(),
            batches: HashMap::new(),
            actions: Vec::new(),
            registered: false,
            status: ConnectionStatus::Disconnected,
            sasl,
            scram: None,
            challenge: String::new(),
            cap_ended: false,
            nick_attempt: 0,
            pending: Vec::new(),
            next_label: 1,
            ping: None,
            lag_ms: None,
            listing: Vec::new(),
            archived: HashMap::new(),
            away_since: None,
            gap_fills: HashMap::new(),
        }
    }

    pub fn network_id(&self) -> &NetworkId {
        &self.config.network
    }

    /// Puts back the conversations the last run had open, before the socket is
    /// dialled, so they are in the sidebar while the network is still
    /// connecting. Channels come back unjoined and marked to rejoin, which is
    /// the path a reconnect already takes.
    pub fn restore(&mut self, targets: Vec<Restored>) -> Vec<Action> {
        for restored in targets {
            let name = restored.target.name().to_string();
            let key = self.fold(&name);
            // Before the match: a query's history is worth asking for too, even
            // though nothing requests one yet.
            if let Some(newest) = restored.newest {
                self.archived.insert(key.clone(), newest);
            }
            match restored.target {
                OpenTarget::Channel(_) => {
                    self.channel_entry(&key, &name).rejoin = true;
                    self.emit_channel(&key);
                }
                OpenTarget::Query(nick) => self.touch_query(&nick, None),
            }
        }
        self.away_since = self.newest_held();
        self.drain()
    }

    pub fn snapshot(&self) -> Network {
        Network {
            id: self.config.network.clone(),
            name: self.config.name.clone(),
            host: self.config.host.clone(),
            port: self.config.port,
            tls: self.config.tls,
            status: self.status.clone(),
            current_nick: self.registered.then(|| self.nick.clone()),
            sasl: self.sasl.clone(),
            caps_enabled: self.caps.enabled(),
            lag_ms: self.lag_ms,
        }
    }

    pub fn channels(&self) -> Vec<Channel> {
        self.channels.keys().map(|key| self.channel(key)).collect()
    }

    pub fn queries(&self) -> Vec<Query> {
        self.queries.keys().map(|key| self.query(key)).collect()
    }

    pub fn members(&self, channel: &str) -> Vec<Member> {
        self.channels
            .get(&self.fold(channel))
            .map(|channel| self.member_list(channel))
            .unwrap_or_default()
    }

    /// The name a person would recognise: what `NETWORK` said, else what the
    /// user called it.
    pub fn network_name(&self) -> &str {
        self.isupport
            .network
            .as_deref()
            .unwrap_or(&self.config.name)
    }

    pub fn on_connecting(&mut self) -> Vec<Action> {
        self.set_status(ConnectionStatus::Connecting);
        self.drain()
    }

    pub fn on_reconnect_wait(&mut self, seconds: u32) -> Vec<Action> {
        self.set_status(ConnectionStatus::Reconnecting {
            in_seconds: seconds,
        });
        self.drain()
    }

    /// `tls` is what the handshake actually negotiated, and `None` means the
    /// socket is in the clear. Either way the user is told, in the network tab:
    /// a client that lets a network turn certificate verification off owes them
    /// a way to see what they got.
    pub fn on_connected(&mut self, tls: Option<TlsInfo>) -> Vec<Action> {
        self.reset_connection_state();
        self.set_status(ConnectionStatus::Registering);
        let host = self.config.host.clone();
        let text = match tls {
            Some(info) => format!("Connected to {host} over {info}"),
            None => format!("Connected to {host} without TLS"),
        };
        self.note(SERVER_TARGET, MessageKind::Client, text);

        self.send_line("CAP LS 302".into());
        self.send_command("NICK", &[&self.nick.clone()]);
        let username = self.config.username.clone();
        let realname = self.config.realname.clone();
        self.send_command("USER", &[&username, "0", "*", &realname]);
        self.drain()
    }

    pub fn on_disconnected(&mut self, reason: &str) -> Vec<Action> {
        // Where the record left off, taken while it is still true: nothing
        // arrives between here and the next welcome, so this is the moment the
        // gap starts.
        self.away_since = self.newest_held();
        self.reset_connection_state();
        self.set_status(ConnectionStatus::Disconnected);
        self.note(
            SERVER_TARGET,
            MessageKind::Client,
            format!("Disconnected from {} — {reason}", self.network_name()),
        );
        self.drain()
    }

    /// Reports a connection that will not be retried.
    pub fn on_failed(&mut self, message: String) -> Vec<Action> {
        self.reset_connection_state();
        self.note(SERVER_TARGET, MessageKind::Client, message.clone());
        self.set_status(ConnectionStatus::Failed { message });
        self.drain()
    }

    pub fn on_line(&mut self, line: &str) -> Vec<Action> {
        self.emit(IrcxEvent::RawLine {
            network: self.config.network.clone(),
            outgoing: false,
            line: line.to_string(),
        });
        match Message::parse(line) {
            Ok(message) => self.handle(&message),
            // A line we cannot parse is the server's problem, not the user's.
            Err(error) => debug!(%error, line, "dropped an unparseable line"),
        }
        self.drain()
    }

    /// Measures the round trip so the UI can show lag. A server that never
    /// answers simply leaves the last figure standing.
    pub fn keepalive(&mut self) -> Vec<Action> {
        if self.registered {
            let token = format!("ircx{}", self.next_label);
            self.next_label += 1;
            self.ping = Some((token.clone(), Instant::now()));
            self.send_command("PING", &[&token]);
        }
        self.drain()
    }

    /// A rule thought something in this conversation worth interrupting the
    /// user for, so the channel goes as loud as it would for their own nick.
    ///
    /// Additive only. A rule is never asked about a message that already
    /// mentions the user, so this cannot double-count one, and there is
    /// nothing it could be asked to take back.
    pub fn raise(&mut self, target: &str) -> Vec<Action> {
        let key = self.fold(target);
        if let Some(channel) = self.channels.get_mut(&key) {
            channel.highlights += 1;
            self.emit_channel(&key);
        }
        self.drain()
    }

    /// Says that a plugin stopped, in the console and once.
    ///
    /// A hook is dropped for the life of the connection, so the console note is
    /// what the user has left to find hours later: a plugin that has been
    /// switched off otherwise reads as a plugin with nothing to say.
    pub fn plugin_stopped(&mut self, text: String, detail: Option<String>) -> Vec<Action> {
        self.notice(
            Severity::Warning,
            text.clone(),
            detail.as_deref().unwrap_or_default(),
        );
        self.note(SERVER_TARGET, MessageKind::Client, text);
        self.drain()
    }

    pub fn mark_read(&mut self, target: &str) -> Vec<Action> {
        let key = self.fold(target);
        if let Some(channel) = self.channels.get_mut(&key) {
            if channel.unread != 0 || channel.highlights != 0 {
                channel.unread = 0;
                channel.highlights = 0;
                self.emit_channel(&key);
            }
        } else if let Some(query) = self.queries.get_mut(&key) {
            if query.unread != 0 {
                query.unread = 0;
                self.emit_query(&key);
            }
        }
        self.drain()
    }

    pub(crate) fn drain(&mut self) -> Vec<Action> {
        std::mem::take(&mut self.actions)
    }

    fn handle(&mut self, message: &Message) {
        match &message.command {
            Command::Named(name) => {
                let name = name.to_ascii_uppercase();
                match name.as_str() {
                    "PING" => {
                        let token = message.params.last().cloned().unwrap_or_default();
                        self.send_command("PONG", &[&token]);
                    }
                    "PONG" => self.handle_pong(message),
                    "CHATHISTORY" => self.handle_chathistory(message),
                    "ERROR" => {
                        let reason = message.params.last().cloned().unwrap_or_default();
                        self.notice(
                            Severity::Error,
                            format!("{} closed the connection — {reason}", self.network_name()),
                            &message.raw,
                        );
                    }
                    "CAP" => self.handle_cap(message),
                    "AUTHENTICATE" => self.handle_authenticate(message),
                    "PRIVMSG" | "NOTICE" => self.handle_privmsg(message, &name),
                    "TAGMSG" => self.handle_tagmsg(message),
                    "JOIN" => self.handle_join(message),
                    "PART" => self.handle_part(message),
                    "QUIT" => self.handle_quit(message),
                    "KICK" => self.handle_kick(message),
                    "NICK" => self.handle_nick(message),
                    "MODE" => self.handle_mode(message),
                    "TOPIC" => self.handle_topic(message),
                    "INVITE" => self.handle_invite(message),
                    "AWAY" => self.handle_away(message),
                    "ACCOUNT" => self.handle_account(message),
                    "CHGHOST" => self.handle_chghost(message),
                    "BATCH" => self.handle_batch(message),
                    "FAIL" | "WARN" | "NOTE" => self.handle_standard_reply(&name, message),
                    _ => debug!(command = name, "no handler for this command"),
                }
            }
            Command::Numeric(code) => self.handle_numeric(*code, message),
        }
    }

    fn handle_pong(&mut self, message: &Message) {
        let token = message
            .params
            .last()
            .map(String::as_str)
            .unwrap_or_default();
        let Some((expected, sent)) = self.ping.take() else {
            return;
        };
        if expected != token {
            self.ping = Some((expected, sent));
            return;
        }
        let lag_ms = sent.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;
        self.lag_ms = Some(lag_ms);
        self.emit(IrcxEvent::LagChanged {
            network: self.config.network.clone(),
            lag_ms,
        });
    }

    fn handle_cap(&mut self, message: &Message) {
        let subcommand = message.param(1).unwrap_or_default().to_ascii_uppercase();
        let list = message
            .params
            .last()
            .map(String::as_str)
            .unwrap_or_default();

        match subcommand.as_str() {
            "LS" => {
                let more = message.param(2) == Some("*");
                self.caps.record_available(list);
                if !more {
                    let lines = self.caps.request_lines();
                    if lines.is_empty() {
                        self.finish_negotiation();
                    }
                    for line in lines {
                        self.send_line(line);
                    }
                }
            }
            "ACK" => {
                self.caps.ack(list);
                self.emit_caps();
                if !self.caps.negotiating() {
                    self.finish_negotiation();
                }
            }
            "NAK" => {
                self.caps.nak();
                self.notice(
                    Severity::Info,
                    format!("{} turned down: {list}", self.network_name()),
                    &message.raw,
                );
                if !self.caps.negotiating() {
                    self.finish_negotiation();
                }
            }
            "NEW" => {
                self.caps.record_available(list);
                for line in self.caps.request_lines() {
                    self.send_line(line);
                }
            }
            "DEL" if !self.caps.remove(list).is_empty() => self.emit_caps(),
            _ => {}
        }
    }

    /// Registration cannot finish until SASL has, so `CAP END` waits for the
    /// exchange rather than racing it.
    fn finish_negotiation(&mut self) {
        if self.cap_ended {
            return;
        }
        match self.start_sasl() {
            true => {}
            false => self.end_negotiation(),
        }
    }

    fn end_negotiation(&mut self) {
        if !self.cap_ended {
            self.cap_ended = true;
            self.send_line("CAP END".into());
        }
    }

    /// `true` when an exchange is now in flight.
    fn start_sasl(&mut self) -> bool {
        let Some(credentials) = self.config.sasl.clone() else {
            return false;
        };
        if !self.caps.is_enabled("sasl") {
            self.fail_sasl(format!(
                "{} does not offer SASL, so ircx connected without authenticating",
                self.network_name()
            ));
            return false;
        }
        if !sasl::offers(self.caps.value("sasl"), credentials.mechanism) {
            self.fail_sasl(format!(
                "{} does not accept SASL {}",
                self.network_name(),
                sasl::mechanism_token(credentials.mechanism)
            ));
            return false;
        }

        self.set_sasl(SaslStatus::InProgress);
        self.send_command(
            "AUTHENTICATE",
            &[sasl::mechanism_token(credentials.mechanism)],
        );
        true
    }

    fn handle_authenticate(&mut self, message: &Message) {
        let Some(credentials) = self.config.sasl.clone() else {
            return;
        };
        let Some(param) = message.param(0) else {
            return;
        };

        // PLAIN and EXTERNAL answer the empty challenge and are done. SCRAM is
        // four messages, so everything after the first is data it has to read.
        let hash = match credentials.mechanism {
            SaslMechanism::ScramSha256 => Some(scram::Hash::Sha256),
            SaslMechanism::ScramSha512 => Some(scram::Hash::Sha512),
            _ => None,
        };

        let Some(hash) = hash else {
            if param != "+" {
                return;
            }
            let payload = match credentials.mechanism {
                SaslMechanism::Plain => sasl::plain_payload(
                    &credentials.account,
                    credentials.password.as_deref().unwrap_or_default(),
                ),
                _ => String::new(),
            };
            return self.send_payload(&payload);
        };

        if param == "+" && self.scram.is_none() {
            let (exchange, first) = scram::Scram::start(
                hash,
                &credentials.account,
                credentials.password.as_deref().unwrap_or_default(),
                &scram::nonce(&ring::rand::SystemRandom::new()),
            );
            self.scram = Some(exchange);
            return self.send_payload(&STANDARD.encode(first));
        }

        // A challenge longer than one line arrives in 400-byte pieces, and a
        // short piece is what ends it — the same rule the outgoing side keeps.
        // Nothing a real server sends here is that long, but a challenge read
        // half-way is a signature that fails for the wrong reason.
        if param != "+" {
            self.challenge.push_str(param);
            if param.len() == sasl::CHUNK {
                return;
            }
        }
        let challenge = std::mem::take(&mut self.challenge);
        let Ok(decoded) = STANDARD.decode(&challenge) else {
            return self.abort_scram(&scram::ScramError::Malformed("not base64"));
        };
        let Ok(decoded) = String::from_utf8(decoded) else {
            return self.abort_scram(&scram::ScramError::Malformed("not text"));
        };

        let Some(exchange) = self.scram.as_mut() else {
            return;
        };
        if exchange.expecting_signature() {
            match exchange.verify(&decoded) {
                // The server proved it knew the password too. The empty
                // response is what tells it we are done, and 903 follows.
                Ok(()) => self.send_payload(""),
                Err(why) => self.abort_scram(&why),
            }
            return;
        }
        match exchange.respond(&decoded) {
            Ok(reply) => self.send_payload(&STANDARD.encode(reply)),
            Err(why) => self.abort_scram(&why),
        }
    }

    fn send_payload(&mut self, payload: &str) {
        for chunk in sasl::chunks(payload) {
            self.send_command("AUTHENTICATE", &[&chunk]);
        }
    }

    /// A SCRAM exchange that cannot be finished stops the connection, as a
    /// rejected password does: carrying on would leave the user unauthenticated
    /// while the client acted as though they were signed in.
    ///
    /// `AUTHENTICATE *` first, which is how a client abandons an exchange —
    /// without it the server is left waiting on a response that is never coming.
    ///
    /// Which sentence the user gets turns on whose fault it was. Four of the
    /// five ways an exchange dies are the server answering wrongly, and ircx is
    /// the side that walked away — so saying the server "rejected the account"
    /// and to go and check the password is wrong twice over. Walked against a
    /// proxy that forged the server's signature: the window said something was
    /// answering for the account, and then sent the reader to the password
    /// field.
    fn abort_scram(&mut self, why: &scram::ScramError) {
        self.scram = None;
        self.challenge.clear();
        self.send_command("AUTHENTICATE", &["*"]);
        let said = why.to_string();
        let message = match why.is_the_credentials() {
            true => self.sasl_refused(&said),
            false => self.sasl_untrusted(&said),
        };
        self.abort_sasl(message);
    }

    /// A failure the user can fix by editing the network, so it stops the
    /// connection instead of quietly leaving them unauthenticated.
    /// What a rejected login says to the person who has to fix it.
    ///
    /// The server's own words go in the middle rather than at the end, because
    /// Libera answers `904` with "SASL authentication failed" and a sentence
    /// built around it read "SASL authentication with Libera.Chat failed —
    /// SASL authentication failed". Naming the account matters: it is as
    /// likely to be wrong as the password, and it is not on screen anywhere.
    fn sasl_refused(&self, reason: &str) -> String {
        let who = match self.sasl_account() {
            Some(account) => format!(" the account {account}"),
            None => String::new(),
        };
        let said = match reason.trim().is_empty() {
            true => String::new(),
            false => format!(" — {reason}"),
        };
        format!(
            "{} rejected{who}{said}. Check the account name and password in this network's settings.",
            self.network_name()
        )
    }

    /// What an exchange the *server* could not hold up its end of says.
    ///
    /// Nobody rejected anything here: ircx stopped, because a server that
    /// cannot prove it knows the password is not one to sign in to. The reason
    /// already says what went wrong, so this adds only where to look — and says
    /// plainly that the password is not it, because the sentence it replaces
    /// sent people there.
    fn sasl_untrusted(&self, reason: &str) -> String {
        let who = match self.sasl_account() {
            Some(account) => format!(" as {account}"),
            None => String::new(),
        };
        format!(
            "ircx stopped signing in to {}{who}: {reason}. The password is not what is wrong \
             here — check the address and port this network points at.",
            self.network_name()
        )
    }

    fn sasl_account(&self) -> Option<&str> {
        self.config
            .sasl
            .as_ref()
            .map(|sasl| sasl.account.as_str())
            .filter(|account| !account.is_empty())
    }

    fn abort_sasl(&mut self, message: String) {
        self.set_sasl(SaslStatus::Failed {
            message: message.clone(),
        });
        self.note(SERVER_TARGET, MessageKind::Client, message.clone());
        self.set_status(ConnectionStatus::Failed { message });
        self.actions.push(Action::Close);
    }

    /// A capability the server never offered is not an authentication failure:
    /// say so loudly and carry on as a plain connection.
    fn fail_sasl(&mut self, message: String) {
        self.set_sasl(SaslStatus::Failed {
            message: message.clone(),
        });
        self.notice(Severity::Warning, message.clone(), "");
        self.note(SERVER_TARGET, MessageKind::Client, message);
    }

    fn handle_numeric(&mut self, code: u16, message: &Message) {
        // The first parameter of a numeric is our own nick; nothing below
        // wants it.
        let params: Vec<String> = message.params.iter().skip(1).cloned().collect();

        match code {
            RPL_WELCOME => self.on_welcome(message),
            RPL_ISUPPORT => {
                let tokens = params
                    .split_last()
                    .map(|(_, tokens)| tokens.to_vec())
                    .unwrap_or_default();
                self.apply_isupport(&tokens);
            }
            RPL_LISTSTART => self.listing.clear(),
            RPL_LIST => self.on_list_reply(&params),
            RPL_LISTEND => self.on_list_end(),
            RPL_NAMREPLY => self.on_names(&params),
            RPL_ENDOFNAMES => self.on_end_of_names(&params),
            RPL_TOPIC => self.on_topic_reply(&params),
            RPL_NOTOPIC => self.on_no_topic(&params),
            RPL_TOPICWHOTIME => self.on_topic_who_time(&params),
            RPL_CREATIONTIME => self.on_creation_time(&params, message),
            RPL_LOCALUSERS | RPL_GLOBALUSERS => self.server_sentence(message),
            RPL_WHOISUSER | RPL_WHOISSERVER | RPL_WHOISIDLE | RPL_WHOISCHANNELS
            | RPL_WHOISACCOUNT => self.on_whois(code, &params, message),
            RPL_CHANNELMODEIS => self.on_channel_modes(&params),
            RPL_AWAY => self.on_away_reply(&params),
            ERR_NICKNAMEINUSE => self.on_nick_in_use(&params, message),
            RPL_LOGGEDIN => {
                let account = params.get(1).cloned().unwrap_or_default();
                self.account = Some(account.clone());
                self.set_sasl(SaslStatus::Authenticated { account });
            }
            RPL_SASLSUCCESS => self.end_negotiation(),
            ERR_SASLFAIL | ERR_SASLTOOLONG | ERR_SASLABORTED | ERR_NICKLOCKED => {
                let reason = params.last().cloned().unwrap_or_default();
                self.abort_sasl(self.sasl_refused(&reason));
            }
            ERR_SASLALREADY => self.end_negotiation(),
            RPL_SASLMECHS => {
                let list = params.first().cloned().unwrap_or_default();
                self.fail_sasl(format!(
                    "{} accepts only these SASL mechanisms: {list}",
                    self.network_name()
                ));
                self.end_negotiation();
            }
            _ => self.on_other_numeric(code, &params, message),
        }
    }

    fn on_welcome(&mut self, message: &Message) {
        self.registered = true;
        if let Some(nick) = message.param(0) {
            self.nick = nick.to_string();
        }
        self.set_status(ConnectionStatus::Connected);
        self.emit(IrcxEvent::NetworkUpdated {
            network: self.snapshot(),
        });
        self.server_words(SERVER_TARGET, message);

        if self.config.sasl.is_some() && !matches!(self.sasl, SaslStatus::Authenticated { .. }) {
            let name = self.network_name().to_string();
            self.notice(
                Severity::Warning,
                format!("Connected to {name} without authenticating"),
                "",
            );
        }

        // A command ircx answers itself means here what it means in the
        // composer, and everything else is still a protocol line to send.
        //
        // It did not, and `/msg nickserv identify …` — the commonest line
        // anybody puts here — went out as a literal `MSG`, which is not an IRC
        // command. Libera answered 421 and the identify never happened. #269.
        for command in self.config.connect_commands.clone() {
            match crate::dispatch::connect_builtin(&command) {
                Some(input) => {
                    self.dispatch(SERVER_TARGET, &input, None);
                }
                None => match crate::dispatch::connect_command(&command) {
                    Some(line) => self.send_line(line),
                    None => debug!(command, "skipped an unsendable connect command"),
                },
            }
        }
        for channel in self.channels_to_join() {
            self.send_command("JOIN", &[&channel]);
        }
        self.find_missed_queries();
    }

    /// Asks which conversations were spoken in while this client was away.
    ///
    /// Nobody joins a query — it exists because somebody spoke — so a private
    /// message sent while ircx was closed leaves nothing to ask about, and
    /// #220's on-join backfill never reaches it. This is the one request that
    /// can find it. #237.
    ///
    /// Only with an archive to ask from. Without one there is no gap, only a
    /// server's whole memory, and opening a conversation for everybody who ever
    /// messaged this nick is not what "what did I miss" means.
    fn find_missed_queries(&mut self) {
        if !self.caps.is_enabled("draft/chathistory") {
            return;
        }
        let Some(since) = self.away_since.clone() else {
            return;
        };
        if let Some(line) = history::targets(&since, &crate::message::now()) {
            self.send_line(line);
        }
    }

    /// One conversation named by a `TARGETS` answer.
    ///
    /// Channels are passed over: one this client joins is asked about on the
    /// way in, and being told a channel the user is not in has been busy is not
    /// the same as having missed something.
    fn handle_chathistory(&mut self, message: &Message) {
        if !message
            .param(0)
            .is_some_and(|word| word.eq_ignore_ascii_case("TARGETS"))
        {
            return;
        }
        let (Some(target), Some(spoken_at)) = (message.param(1), message.param(2)) else {
            return;
        };
        if self.isupport.is_channel(target) {
            return;
        }
        let (target, spoken_at) = (target.to_string(), spoken_at.to_string());
        let key = self.fold(&target);
        // Already current on this one: the archive holds something at least as
        // recent, so there is nothing here to fetch.
        if self
            .archived
            .get(&key)
            .is_some_and(|held| held.as_str() >= spoken_at.as_str())
        {
            return;
        }
        self.touch_query(&target, None);
        // Whatever comes back was missed. This conversation is here because the
        // server said somebody spoke in it while nobody was listening, so #223's
        // rule applies even where there is no archive to fill a gap between —
        // a first page of a conversation you were told you missed is not a
        // conversation you have only just met.
        if self.backfill(&target) {
            self.gap_fills.entry(key).or_insert(0);
        }
    }

    /// How much history one request may ask for: the smaller of what the server
    /// said it would answer with and the page this client reads.
    pub(crate) fn page_limit(&self) -> u32 {
        self.isupport
            .chathistory
            .map_or(history::PAGE, |max| max.min(history::PAGE))
    }

    /// Asks for the next page of a gap that has not been closed yet.
    ///
    /// `AFTER` answers oldest-first, so a full page is the *start* of what was
    /// missed and the rest is still out there. #239.
    ///
    /// `from` and `msgid` are the last message in the page that just arrived,
    /// and it has to be: the conversation's watermark moves with every message
    /// including the live ones, and a channel that says anything while a page is
    /// in flight pushes it to now — which asks for the gap from after the end of
    /// it and silently skips the rest. Found against a real server, where the
    /// second request went out stamped later than the whole backlog it was
    /// chasing.
    pub(crate) fn continue_gap(
        &mut self,
        target: &str,
        pages: u32,
        from: &str,
        msgid: Option<&str>,
    ) {
        let key = self.fold(target);
        if pages >= history::GAP_PAGES {
            self.gap_fills.remove(&key);
            // The one case where the client knows it is behind. Saying nothing
            // would leave the reader with the oldest of what they missed and no
            // reason to doubt it is all of it.
            self.note(
                target,
                MessageKind::Client,
                format!(
                    "This conversation moved faster than ircx caught up with: \
                     {} messages of it were fetched and there is more that was not.",
                    pages * self.page_limit()
                ),
            );
            return;
        }
        let limit = self.page_limit();
        let resume = history::Resume {
            timestamp: from,
            msgid,
        };
        let Some(line) = history::request(target, Some(resume), limit) else {
            self.gap_fills.remove(&key);
            return;
        };
        self.gap_fills.insert(key, pages);
        self.send_line(line);
    }

    /// The network's `autojoin`, then whatever the user had joined by hand when
    /// the connection went away. A channel joined by hand is remembered for the
    /// session only: `autojoin` is a saved preference and a dropped socket is
    /// not the user editing it.
    fn channels_to_join(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .config
            .autojoin
            .iter()
            .map(|channel| channel.trim().to_string())
            .filter(|channel| !channel.is_empty())
            .collect();

        let mut rejoin: Vec<String> = self
            .channels
            .values()
            .filter(|channel| channel.rejoin)
            .map(|channel| channel.name.clone())
            .collect();
        rejoin.sort();

        for name in rejoin {
            if !names.iter().any(|held| self.fold(held) == self.fold(&name)) {
                names.push(name);
            }
        }
        names
    }

    fn apply_isupport(&mut self, tokens: &[String]) {
        let previous = self.isupport.casemapping;
        self.isupport.apply(tokens);
        if previous != self.isupport.casemapping {
            self.rekey();
        }
    }

    /// Keys are folded names, so a late `CASEMAPPING` invalidates every one of
    /// them.
    fn rekey(&mut self) {
        let channels = std::mem::take(&mut self.channels);
        self.channels = channels
            .into_values()
            .map(|channel| (self.fold(&channel.name), channel))
            .collect();
        let queries = std::mem::take(&mut self.queries);
        self.queries = queries
            .into_values()
            .map(|query| (self.fold(&query.nick), query))
            .collect();
    }

    /// Like the other channel replies below it, this one only updates a channel
    /// the session already holds. `NAMES`, `TOPIC` and `MODE` can all be asked
    /// about a channel we are not in, and an answer to one of those is not a
    /// reason to put it in the user's channel list.
    fn on_names(&mut self, params: &[String]) {
        let Some(name) = params.get(1) else { return };
        let entries = params.get(2).cloned().unwrap_or_default();
        let key = self.fold(name);
        let members: Vec<MemberState> = entries
            .split_whitespace()
            .map(|entry| {
                let (prefixes, rest) = self.isupport.split_prefixes(entry);
                // `userhost-in-names` appends the rest of the mask.
                let nick = rest.split('!').next().unwrap_or(rest);
                MemberState {
                    nick: nick.to_string(),
                    account: None,
                    prefixes,
                    away: None,
                }
            })
            .collect();

        if let Some(channel) = self.channels.get_mut(&key) {
            channel.names.extend(members);
        }
    }

    fn on_end_of_names(&mut self, params: &[String]) {
        let Some(name) = params.first() else { return };
        let key = self.fold(name);
        let mapping = self.isupport.casemapping;
        let Some(channel) = self.channels.get_mut(&key) else {
            return;
        };
        channel.members = std::mem::take(&mut channel.names)
            .into_iter()
            .map(|member| (mapping.fold(&member.nick), member))
            .collect();
        self.emit_members(&key);
        self.emit_channel(&key);
    }

    /// The topic a channel already had, which arrives on every join.
    ///
    /// Said in the timeline rather than drawn as chrome: the header leaves the
    /// topic out on purpose, and a change to it already reads as a line in the
    /// conversation. Without this the topic of a channel you just joined is
    /// tracked and shown nowhere at all.
    fn on_topic_reply(&mut self, params: &[String]) {
        let (Some(name), Some(topic)) = (params.first(), params.get(1)) else {
            return;
        };
        let (name, key) = (name.clone(), self.fold(params[0].as_str()));
        let topic = topic.clone();
        let Some(channel) = self.channels.get_mut(&key) else {
            return;
        };
        channel.topic = Some(Topic {
            text: topic.clone(),
            set_by: None,
            set_at: None,
        });
        self.emit_channel(&key);

        if !topic.trim().is_empty() {
            self.note(
                &name,
                MessageKind::Topic,
                format!("The topic of {name} is: {topic}"),
            );
        }
    }

    fn on_no_topic(&mut self, params: &[String]) {
        let Some(name) = params.first() else { return };
        let key = self.fold(name);
        let Some(channel) = self.channels.get_mut(&key) else {
            return;
        };
        channel.topic = None;
        self.emit_channel(&key);
    }

    /// Who set that topic and when, which the server sends straight after it.
    ///
    /// The seconds are turned into the same RFC 3339 the live path stores from
    /// the `time` tag. They were kept as the raw epoch before, so one field
    /// held two formats and whichever drew it would have shown a number half
    /// the time.
    /// When a channel was made, in words. `329` is the channel and a unix
    /// timestamp and nothing else, so the fallback prints `#libera 1619211933`
    /// — two facts and no sentence between them.
    ///
    /// Goes to the channel it is about when we are in it, which is where the
    /// fallback was already putting it.
    fn on_creation_time(&mut self, params: &[String], message: &Message) {
        let Some(channel) = params.first() else {
            return;
        };
        let when = params
            .get(1)
            .and_then(|epoch| rfc3339(epoch))
            .as_deref()
            .and_then(readable);
        let Some(when) = when else {
            return self.server_words(SERVER_TARGET, message);
        };
        let target = match self.channels.contains_key(&self.fold(channel)) {
            true => channel.clone(),
            false => SERVER_TARGET.to_string(),
        };
        let sentence = format!("{channel} was created on {when}");
        let note = self.chat_message(message, &target, MessageKind::Server, sentence);
        self.append(note);
    }

    /// A numeric whose trailing text is already the whole sentence, and whose
    /// parameters are the same figures over again.
    ///
    /// `265` arrives as `2283 2496 :Current local users 2283, max 2496`, and
    /// joining the parameters onto the sentence prints every number twice:
    /// `2283 2496 Current local users 2283, max 2496`.
    fn server_sentence(&mut self, message: &Message) {
        let Some(text) = message.params.last() else {
            return;
        };
        if text.trim().is_empty() {
            return;
        }
        let note = self.chat_message(message, SERVER_TARGET, MessageKind::Server, text.clone());
        self.append(note);
    }

    /// A WHOIS reply, in a sentence rather than in the order it arrived.
    ///
    /// Every one of these puts its data before the server's trailing text, so
    /// the fallback every unhandled numeric takes — join the parameters, append
    /// the trailing — reads backwards. `330` came out as `syk brandn is logged
    /// in as`, and `317` as `syk 477 1785604113 seconds idle, signon time`: two
    /// unlabelled numbers, one of them a unix timestamp.
    ///
    /// Written here rather than in `numeric::describe` because the idle reply
    /// needs the same clock `on_topic_who_time` uses, and because these read as
    /// a block and are easier to keep consistent in one place.
    ///
    /// Anything not listed is left to the server's own words, which is the
    /// right answer where the trailing text is already the whole sentence:
    /// `671` says "is using a secure connection" and needs nothing from us.
    fn on_whois(&mut self, code: u16, params: &[String], message: &Message) {
        let Some(who) = params.first() else { return };
        let sentence = match code {
            RPL_WHOISUSER => {
                let user = params.get(1).map(String::as_str).unwrap_or("");
                let host = params.get(2).map(String::as_str).unwrap_or("");
                let real = params.get(4).map(String::as_str).unwrap_or("");
                // Servers overwhelmingly set the realname to the nick, and
                // saying it twice in one line is noise.
                match real.is_empty() || real.eq_ignore_ascii_case(who) {
                    true => format!("{who} is {user}@{host}"),
                    false => format!("{who} is {user}@{host}, calling themselves {real}"),
                }
            }
            RPL_WHOISSERVER => {
                let server = params.get(1).map(String::as_str).unwrap_or("");
                let about = params.get(2).map(String::as_str).unwrap_or("");
                match about.is_empty() {
                    true => format!("{who} is connected to {server}"),
                    false => format!("{who} is connected to {server} ({about})"),
                }
            }
            RPL_WHOISIDLE => {
                let idle = params.get(1).and_then(|s| s.trim().parse::<i64>().ok());
                let since = params.get(2).and_then(|epoch| rfc3339(epoch));
                let signed_on = since.as_deref().and_then(readable);
                match (idle, signed_on) {
                    (Some(idle), Some(when)) => {
                        format!(
                            "{who} has been idle {}, and signed on {when}",
                            idle_for(idle)
                        )
                    }
                    (Some(idle), None) => format!("{who} has been idle {}", idle_for(idle)),
                    (None, Some(when)) => format!("{who} signed on {when}"),
                    (None, None) => return self.server_words(SERVER_TARGET, message),
                }
            }
            RPL_WHOISCHANNELS => {
                let channels = params.get(1).map(String::as_str).unwrap_or("");
                if channels.trim().is_empty() {
                    return;
                }
                let listed: Vec<&str> = channels.split_whitespace().collect();
                format!("{who} is in {}", listed.join(", "))
            }
            RPL_WHOISACCOUNT => {
                let account = params.get(1).map(String::as_str).unwrap_or("");
                if account.is_empty() {
                    return self.server_words(SERVER_TARGET, message);
                }
                format!("{who} is logged in as {account}")
            }
            _ => return self.server_words(SERVER_TARGET, message),
        };
        let note = self.chat_message(message, SERVER_TARGET, MessageKind::Server, sentence);
        self.append(note);
    }

    fn on_topic_who_time(&mut self, params: &[String]) {
        let Some(name) = params.first() else { return };
        let (name, key) = (name.clone(), self.fold(name));
        // Ergo sends the whole `nick!user@host` here and Libera sends a bare
        // nick. The specification says "nick"; a mask in a sentence a person
        // reads is noise either way.
        let set_by = params
            .get(1)
            .map(|who| who.split('!').next().unwrap_or(who).to_string());
        let set_at = params.get(2).and_then(|epoch| rfc3339(epoch));
        let Some(channel) = self.channels.get_mut(&key) else {
            return;
        };
        if channel.topic.is_none() {
            return;
        }
        if let Some(topic) = channel.topic.as_mut() {
            topic.set_by.clone_from(&set_by);
            topic.set_at.clone_from(&set_at);
        }
        self.emit_channel(&key);

        if let Some(who) = set_by {
            let when = set_at
                .as_deref()
                .and_then(readable)
                .map(|when| format!(" on {when}"))
                .unwrap_or_default();
            self.note(&name, MessageKind::Topic, format!("Set by {who}{when}"));
        }
    }

    fn on_channel_modes(&mut self, params: &[String]) {
        let Some(name) = params.first() else { return };
        let modes = params
            .get(1)
            .map(|modes| modes.trim_start_matches('+').to_string())
            .unwrap_or_default();
        let key = self.fold(name);
        let Some(channel) = self.channels.get_mut(&key) else {
            return;
        };
        channel.modes = modes.clone();
        let name = channel.name.clone();
        self.emit_channel(&key);

        // Said in the conversation rather than drawn as chrome, which is where
        // the topic goes and for the same reason: it is a fact about the
        // channel, and a change to it already reads as a line. Without this the
        // modes were tracked, used to draw a lock in the sidebar, and shown
        // nowhere a reader could check the lock against. #243.
        let rules = channel_rules(modes.split(' ').next().unwrap_or_default());
        if !rules.is_empty() {
            self.note(
                &name,
                MessageKind::Server,
                format!("{name} is {}.", and_then(&rules)),
            );
        }
    }

    fn on_away_reply(&mut self, params: &[String]) {
        let (Some(nick), Some(reason)) = (params.first(), params.get(1)) else {
            return;
        };
        self.note(
            SERVER_TARGET,
            MessageKind::Server,
            format!("{nick} is away — {reason}"),
        );
    }

    fn on_nick_in_use(&mut self, params: &[String], message: &Message) {
        let taken = params.first().cloned().unwrap_or_default();
        let name = self.network_name().to_string();

        if self.registered {
            self.notice(
                Severity::Warning,
                format!("Nickname `{taken}` is taken on {name}"),
                &message.raw,
            );
            return;
        }

        match self.next_nick() {
            Some(next) => {
                self.notice(
                    Severity::Warning,
                    format!("Nickname `{taken}` is taken on {name} — trying `{next}`"),
                    &message.raw,
                );
                self.nick = next.clone();
                self.send_command("NICK", &[&next]);
            }
            None => {
                let message = format!(
                    "Every nickname configured for {name} is taken — edit the network and try again"
                );
                self.notice(Severity::Error, message.clone(), "");
                self.note(SERVER_TARGET, MessageKind::Client, message.clone());
                self.set_status(ConnectionStatus::Failed { message });
                self.actions.push(Action::Close);
            }
        }
    }

    fn next_nick(&mut self) -> Option<String> {
        self.nick_attempt += 1;
        if let Some(alt) = self.config.alt_nicks.get(self.nick_attempt - 1) {
            return Some(alt.clone());
        }
        let suffix = self.nick_attempt - self.config.alt_nicks.len();
        (suffix <= 3).then(|| format!("{}{}", self.config.nick, "_".repeat(suffix)))
    }

    /// `322 <me> <channel> <users> :<topic>`, with the leading target already
    /// stripped by the numeric dispatch — so the channel is the first parameter
    /// here, not the second.
    ///
    /// Collected rather than shown: the user asked to find a channel, not to
    /// read tens of thousands of lines.
    fn on_list_reply(&mut self, params: &[String]) {
        if self.listing.len() >= MAX_LISTING {
            return;
        }
        let Some(name) = params.first() else {
            return;
        };
        self.listing.push(ChannelListing {
            name: name.clone(),
            users: params.get(1).and_then(|n| n.parse().ok()).unwrap_or(0),
            topic: params.get(2).cloned().unwrap_or_default(),
        });
    }

    /// `323`. The whole list goes at once, which is the difference between one
    /// event and one per channel.
    fn on_list_end(&mut self) {
        let channels = std::mem::take(&mut self.listing);
        self.emit(IrcxEvent::ChannelsListed {
            network: self.config.network.clone(),
            truncated: channels.len() >= MAX_LISTING,
            channels,
        });
    }

    fn on_other_numeric(&mut self, code: u16, params: &[String], message: &Message) {
        let name = self.network_name().to_string();
        match numeric::describe(code, params, &name) {
            Some((severity, sentence)) => {
                let target = params
                    .first()
                    .filter(|first| self.isupport.is_channel(first))
                    .filter(|first| self.channels.contains_key(&self.fold(first)))
                    .cloned()
                    .unwrap_or_else(|| SERVER_TARGET.to_string());
                self.notice(severity, sentence.clone(), &message.raw);
                let note = self.chat_message(message, &target, MessageKind::Server, sentence);
                self.append(note);
            }
            None => self.server_words(SERVER_TARGET, message),
        }
    }

    /// Numerics ircx has nothing better to say about keep the server's own
    /// wording rather than becoming a code the user has to look up.
    fn server_words(&mut self, target: &str, message: &Message) {
        let text = message
            .params
            .iter()
            .skip(1)
            .cloned()
            .collect::<Vec<_>>()
            .join(" ");
        if text.trim().is_empty() {
            return;
        }
        let note = self.chat_message(message, target, MessageKind::Server, text);
        self.append(note);
    }

    fn handle_privmsg(&mut self, message: &Message, command: &str) {
        let Some(raw_target) = message.param(0) else {
            return;
        };
        let Some(body) = message.param(1) else { return };
        let sender = self.sender_of(message);

        // Our own echo of a private message names the other side, not us.
        let mut target = match self.isupport.is_channel(raw_target) || sender.is_self {
            true => raw_target.to_string(),
            false => sender.nick.clone(),
        };

        if self.isupport.is_channel(&target) {
            target = self.canonical(&target);
        }

        let (kind, text) = match text::ctcp(body) {
            Some(("ACTION", action)) => (MessageKind::Action, action.to_string()),
            Some((request, _)) => {
                let text = format!("{} asked for CTCP {request}", sender.nick);
                (MessageKind::Server, text)
            }
            None if command == "NOTICE" => (MessageKind::Notice, body.to_string()),
            None => (MessageKind::Privmsg, body.to_string()),
        };

        if let Some(label) = message.tag("label").map(str::to_string) {
            if self.deliver(message, Some(&label), &target, &text) {
                return;
            }
        }
        if sender.is_self
            && self.caps.is_enabled("echo-message")
            && self.deliver(message, None, &target, &text)
        {
            return;
        }

        // A notice from the server itself belongs in the network tab rather
        // than in a query with a hostname for a nick.
        if !matches!(message.prefix, Some(Prefix::User { .. }))
            && !self.isupport.is_channel(&target)
        {
            target = SERVER_TARGET.to_string();
        }

        if !self.isupport.is_channel(&target) && target != SERVER_TARGET {
            self.touch_query(&target, sender.account.clone());
            // After `touch_query`, so a first sighting names the conversation
            // and every later one is filed under that name rather than under
            // its own casing.
            target = self.canonical(&target);
            // Hearing from somebody is the only evidence this client gets that
            // they came back. Our own echo is not: sending to a nick says
            // nothing about whether anyone is there to read it.
            if !sender.is_self {
                self.mark_online(&target);
            }
        }
        let chat = self.chat_message(message, &target, kind, text);
        self.append(chat);
    }

    /// Matches a server echo to the optimistic copy already on screen. The id
    /// stays the local one so the frontend can find the message it drew, which
    /// leaves the echo's tags to carry the server's `msgid`. Something has to:
    /// it is what a later history replay of this message is recognised by, and
    /// without it the user's own history comes back doubled.
    fn deliver(&mut self, echo: &Message, label: Option<&str>, target: &str, text: &str) -> bool {
        let found = self.pending.iter().position(|pending| match label {
            Some(label) => pending.label.as_deref() == Some(label),
            None => {
                self.isupport
                    .casemapping
                    .equal(&pending.message.target, target)
                    && pending.message.text == text
            }
        });
        let Some(index) = found else { return false };

        let mut message = self.pending.remove(index).message;
        message.delivery = Delivery::Delivered;
        message.tags = echo.tags.clone();
        message.raw = echo.raw.clone();
        if let Some(time) = echo.tag("time").filter(|time| !time.is_empty()) {
            message.timestamp = time.to_string();
            message.timestamp_is_local = false;
        }
        self.emit(IrcxEvent::MessageUpdated {
            message: Box::new(message),
        });
        true
    }

    fn handle_tagmsg(&mut self, message: &Message) {
        let sender = self.sender_of(message);
        let Some(raw_target) = message.param(0) else {
            return;
        };
        let target = if self.isupport.is_channel(raw_target) {
            raw_target.to_string()
        } else {
            sender.nick.clone()
        };

        if let Some(state) = message.tag("+typing").or_else(|| message.tag("typing")) {
            self.emit(IrcxEvent::TypingChanged {
                network: self.config.network.clone(),
                target: target.clone(),
                nick: sender.nick.clone(),
                active: state.eq_ignore_ascii_case("active"),
            });
        }

        // A reaction means nothing apart from the message it answers, which is
        // why the specification makes `+reply` mandatory alongside it. A line
        // without one names nothing and is dropped.
        if let Some((emoji, active)) = crate::message::reaction(message) {
            if let Some(id) = crate::message::reply_to(message) {
                self.emit(IrcxEvent::ReactionChanged {
                    network: self.config.network.clone(),
                    target,
                    message: id,
                    nick: sender.nick,
                    emoji,
                    active,
                });
            }
        }
    }

    fn handle_join(&mut self, message: &Message) {
        let Some(name) = message.param(0).map(str::to_string) else {
            return;
        };
        let sender = self.sender_of(message);
        let key = self.fold(&name);
        // `extended-join` adds the account and the real name.
        let account = message
            .param(1)
            .filter(|account| *account != "*" && !account.is_empty())
            .map(str::to_string)
            .or(sender.account.clone());

        if sender.is_self {
            self.user = sender.user.clone().or(self.user.clone());
            self.host = sender.host.clone().or(self.host.clone());
            let channel = self.channel_entry(&key, &name);
            channel.joined = true;
            channel.rejoin = true;
            channel.members.clear();
            self.send_command("MODE", &[&name]);
            self.actions
                .push(Action::Remember(OpenTarget::Channel(name.clone())));
            self.backfill(&name);
        } else {
            let nick = sender.nick.clone();
            let member = MemberState {
                nick: nick.clone(),
                account,
                prefixes: Vec::new(),
                away: None,
            };
            let folded = self.fold(&nick);
            self.channel_entry(&key, &name)
                .members
                .insert(folded.clone(), member);
            self.emit_member(&key, &folded);
        }

        let text = format!("{} joined {name}", sender.nick);
        let chat = self.chat_message(message, &name, MessageKind::Join, text);
        self.append(chat);
        self.emit_channel(&key);
    }

    /// A server that did not grant the capability is asked for nothing, and the
    /// archive stays the whole history there is.
    ///
    /// Asking for the gap and asking for a first page are different questions
    /// with different answers, and the difference is remembered: what fills a
    /// gap was missed, and what arrives on a first sight of a conversation was
    /// never anybody's to miss. #223.
    fn backfill(&mut self, target: &str) -> bool {
        if !self.caps.is_enabled("draft/chathistory") {
            return false;
        }
        let limit = self.page_limit();
        // A server can say it will answer with nothing, and asking anyway is a
        // request that can only be refused.
        if limit == 0 {
            return false;
        }
        let key = self.fold(target);
        let since = self.archived.get(&key).cloned();
        // A timestamp even where the archive holds a msgid for that message: the
        // watermark can be old enough that the server no longer has the message
        // it names, and an unknown msgid is a request that answers with nothing
        // where a timestamp always resolves to a place in the history.
        let resume = since.as_deref().map(|timestamp| history::Resume {
            timestamp,
            msgid: None,
        });
        let Some(line) = history::request(target, resume, limit) else {
            return false;
        };
        match since {
            // `or_insert` rather than `insert`: a second page of the same gap
            // keeps the count of what has already come back.
            Some(_) => {
                self.gap_fills.entry(key).or_insert(0);
            }
            None => {
                self.gap_fills.remove(&key);
            }
        }
        self.send_line(line);
        true
    }

    fn handle_part(&mut self, message: &Message) {
        let Some(name) = message.param(0).map(str::to_string) else {
            return;
        };
        let sender = self.sender_of(message);
        let key = self.fold(&name);
        let reason = message.param(1).unwrap_or_default().to_string();
        let text = match reason.is_empty() {
            true => format!("{} left {name}", sender.nick),
            false => format!("{} left {name} — {reason}", sender.nick),
        };
        let chat = self.chat_message(message, &name, MessageKind::Part, text);
        self.append(chat);

        if sender.is_self {
            if let Some(channel) = self.channels.get_mut(&key) {
                channel.joined = false;
                channel.rejoin = false;
                channel.members.clear();
            }
            // The tab stays for this session, but a channel the user walked
            // out of is not one to walk back into on the next launch.
            self.actions.push(Action::Forget(name.clone()));
            self.emit_channel(&key);
        } else {
            self.remove_member(&key, &sender.nick);
            self.emit_channel(&key);
        }
    }

    fn handle_quit(&mut self, message: &Message) {
        let sender = self.sender_of(message);
        let reason = message.param(0).unwrap_or_default().to_string();
        let text = match reason.is_empty() {
            true => format!("{} quit", sender.nick),
            false => format!("{} quit — {reason}", sender.nick),
        };

        let folded = self.fold(&sender.nick);
        let shared: Vec<(String, String)> = self
            .channels
            .iter()
            .filter(|(_, channel)| channel.members.contains_key(&folded))
            .map(|(key, channel)| (key.clone(), channel.name.clone()))
            .collect();

        for (key, name) in shared {
            let chat = self.chat_message(message, &name, MessageKind::Quit, text.clone());
            self.append(chat);
            self.remove_member(&key, &sender.nick);
            self.emit_channel(&key);
        }
        if let Some(query) = self.queries.get_mut(&folded) {
            query.online = false;
            self.emit_query(&folded);
        }
    }

    fn handle_kick(&mut self, message: &Message) {
        let (Some(name), Some(nick)) = (
            message.param(0).map(str::to_string),
            message.param(1).map(str::to_string),
        ) else {
            return;
        };
        let sender = self.sender_of(message);
        let key = self.fold(&name);
        let reason = message.param(2).unwrap_or_default().to_string();
        let text = match reason.is_empty() {
            true => format!("{} kicked {nick} from {name}", sender.nick),
            false => format!("{} kicked {nick} from {name} — {reason}", sender.nick),
        };
        let chat = self.chat_message(message, &name, MessageKind::Kick, text);
        self.append(chat);

        if self.is_me(&nick) {
            // Being kicked is being told to leave, so the next reconnect does
            // not walk back in.
            if let Some(channel) = self.channels.get_mut(&key) {
                channel.joined = false;
                channel.rejoin = false;
                channel.members.clear();
            }
            self.actions.push(Action::Forget(name.clone()));
        } else {
            self.remove_member(&key, &nick);
        }
        self.emit_channel(&key);
    }

    fn handle_nick(&mut self, message: &Message) {
        let Some(new_nick) = message.param(0).map(str::to_string) else {
            return;
        };
        let sender = self.sender_of(message);
        let old = self.fold(&sender.nick);
        let text = format!("{} is now known as {new_nick}", sender.nick);

        let shared: Vec<(String, String)> = self
            .channels
            .iter()
            .filter(|(_, channel)| channel.members.contains_key(&old))
            .map(|(key, channel)| (key.clone(), channel.name.clone()))
            .collect();

        for (key, name) in shared {
            let chat = self.chat_message(message, &name, MessageKind::Nick, text.clone());
            self.append(chat);
            if let Some(channel) = self.channels.get_mut(&key) {
                if let Some(mut member) = channel.members.remove(&old) {
                    let was = std::mem::replace(&mut member.nick, new_nick.clone());
                    let folded = self.isupport.casemapping.fold(&new_nick);
                    channel.members.insert(folded.clone(), member);
                    // The roster is a list of names, so re-keying it here is
                    // only half the change: without this the old name is left
                    // beside the new one, and the part or quit that follows
                    // names the new one and takes only that away.
                    self.emit(IrcxEvent::MemberRemoved {
                        network: self.config.network.clone(),
                        channel: name.clone(),
                        nick: was,
                    });
                    self.emit_member(&key, &folded);
                }
            }
            self.emit_channel(&key);
        }

        if let Some(mut query) = self.queries.remove(&old) {
            // Before the nick is overwritten: the conversation is moved by the
            // name it was under, and this is the last place that holds it.
            let was = std::mem::replace(&mut query.nick, new_nick.clone());
            let folded = self.fold(&new_nick);
            self.queries.insert(folded.clone(), query);
            self.emit(IrcxEvent::QueryRenamed {
                network: self.config.network.clone(),
                from: was,
                to: new_nick.clone(),
            });
            self.emit_query(&folded);
        }

        if sender.is_self {
            self.nick = new_nick;
            self.emit(IrcxEvent::NetworkUpdated {
                network: self.snapshot(),
            });
        }
    }

    fn handle_mode(&mut self, message: &Message) {
        let Some(target) = message.param(0).map(str::to_string) else {
            return;
        };
        let sender = self.sender_of(message);
        let arguments: Vec<String> = message.params.iter().skip(1).cloned().collect();

        if !self.isupport.is_channel(&target) {
            // Without the nick, which the row draws from the sender: a mode on
            // yourself is noted as your own message.
            let text = format!("set {}", arguments.join(" "));
            self.note(SERVER_TARGET, MessageKind::Mode, text);
            return;
        }

        let key = self.fold(&target);
        let mut rest = arguments.iter().skip(1);
        let mut adding = true;
        let mut touched = Vec::new();
        // What to say, and about whom. A standing on a member is about that
        // member: the digest counts "1 took ops" and the reader wants to know
        // who now holds it, not who handed it over. Everything else is about
        // the channel and stays with whoever changed it.
        let mut said: Vec<(Sender, String)> = Vec::new();
        let mut channel_modes: Vec<(char, bool)> = Vec::new();

        for letter in arguments
            .first()
            .map(String::as_str)
            .unwrap_or_default()
            .chars()
        {
            match letter {
                '+' => adding = true,
                '-' => adding = false,
                _ => {
                    let argument = self
                        .isupport
                        .takes_argument(letter, adding)
                        .then(|| rest.next())
                        .flatten();
                    match (self.isupport.prefix_for_mode(letter), argument) {
                        (Some(prefix), Some(nick)) => {
                            let folded = self.fold(nick);
                            if let Some(member) = self
                                .channels
                                .get_mut(&key)
                                .and_then(|channel| channel.members.get_mut(&folded))
                            {
                                set_prefix(member, prefix, adding);
                                touched.push(folded);
                            }
                            said.push((self.member_sender(nick), standing(letter, adding)));
                        }
                        _ => {
                            self.set_channel_mode(&key, letter, adding);
                            channel_modes.push((letter, adding));
                        }
                    }
                }
            }
        }

        for letter in channel_modes {
            said.push((sender.clone(), channel_rule(letter.0, letter.1)));
        }
        // A MODE line carrying nothing this client could read still happened,
        // and saying so beats drawing the channel changing with no line for it.
        if said.is_empty() {
            said.push((sender, format!("set {}", arguments.join(" "))));
        }

        for (who, what) in said {
            let mut chat = self.chat_message(message, &target, MessageKind::Mode, what);
            chat.sender = who;
            self.append(chat);
        }
        for folded in touched {
            self.sort_member_prefixes(&key, &folded);
            self.emit_member(&key, &folded);
        }
        self.emit_channel(&key);
    }

    /// Somebody a mode was set on, named the way the roster names them.
    fn member_sender(&self, nick: &str) -> Sender {
        Sender {
            nick: nick.to_string(),
            user: None,
            host: None,
            account: self.known_account(nick),
            is_self: self.is_me(nick),
        }
    }

    fn set_channel_mode(&mut self, key: &str, letter: char, adding: bool) {
        let Some(channel) = self.channels.get_mut(key) else {
            return;
        };
        match adding {
            true if !channel.modes.contains(letter) => channel.modes.push(letter),
            false => channel.modes.retain(|current| current != letter),
            true => {}
        }
    }

    fn handle_topic(&mut self, message: &Message) {
        let Some(name) = message.param(0).map(str::to_string) else {
            return;
        };
        let sender = self.sender_of(message);
        let topic = message.param(1).unwrap_or_default().to_string();
        let key = self.fold(&name);
        let text = match topic.is_empty() {
            true => format!("{} cleared the topic of {name}", sender.nick),
            false => format!("{} set the topic of {name} to {topic}", sender.nick),
        };

        let set_at = message.tag("time").map(str::to_string);
        let channel = self.channel_entry(&key, &name);
        channel.topic = (!topic.is_empty()).then(|| Topic {
            text: topic,
            set_by: Some(sender.nick.clone()),
            set_at,
        });

        let chat = self.chat_message(message, &name, MessageKind::Topic, text);
        self.append(chat);
        self.emit_channel(&key);
    }

    fn handle_invite(&mut self, message: &Message) {
        let sender = self.sender_of(message);
        let Some(channel) = message.params.last() else {
            return;
        };
        self.notice(
            Severity::Info,
            format!("{} invited you to {channel}", sender.nick),
            &message.raw,
        );
    }

    fn handle_away(&mut self, message: &Message) {
        let sender = self.sender_of(message);
        let reason = message.param(0).map(str::to_string);
        let folded = self.fold(&sender.nick);
        let keys: Vec<String> = self
            .channels
            .iter()
            .filter(|(_, channel)| channel.members.contains_key(&folded))
            .map(|(key, _)| key.clone())
            .collect();

        for key in keys {
            if let Some(member) = self
                .channels
                .get_mut(&key)
                .and_then(|channel| channel.members.get_mut(&folded))
            {
                member.away = reason.clone();
            }
            self.emit_member(&key, &folded);
        }
    }

    fn handle_account(&mut self, message: &Message) {
        let sender = self.sender_of(message);
        let account = message
            .param(0)
            .filter(|account| *account != "*")
            .map(str::to_string);
        let folded = self.fold(&sender.nick);
        let keys: Vec<String> = self
            .channels
            .iter()
            .filter(|(_, channel)| channel.members.contains_key(&folded))
            .map(|(key, _)| key.clone())
            .collect();

        for key in keys {
            if let Some(member) = self
                .channels
                .get_mut(&key)
                .and_then(|channel| channel.members.get_mut(&folded))
            {
                member.account = account.clone();
            }
            self.emit_member(&key, &folded);
        }
        if let Some(query) = self.queries.get_mut(&folded) {
            query.account = account;
            self.emit_query(&folded);
        }
    }

    fn handle_chghost(&mut self, message: &Message) {
        let sender = self.sender_of(message);
        if sender.is_self {
            self.user = message.param(0).map(str::to_string);
            self.host = message.param(1).map(str::to_string);
        }
    }

    fn handle_batch(&mut self, message: &Message) {
        let Some(reference) = message.param(0) else {
            return;
        };
        match reference.split_at(1) {
            ("+", reference) => {
                let kind = message.param(1).unwrap_or_default().to_string();
                self.open_batch(reference, &kind);
            }
            ("-", reference) => self.close_batch(reference),
            _ => {}
        }
    }

    /// Records that this nick was heard from, which is what takes back a quit.
    ///
    /// `online` latched: it was set once when the query was created and
    /// cleared on `QUIT`, so somebody who quit and came back stayed marked
    /// gone for the rest of the session. It is only ever false because a quit
    /// was seen and nothing has been heard since — a restored query has no
    /// evidence either way and is not called offline on a guess.
    fn mark_online(&mut self, nick: &str) {
        let key = self.fold(nick);
        let Some(query) = self.queries.get_mut(&key) else {
            return;
        };
        if query.online {
            return;
        }
        query.online = true;
        self.emit_query(&key);
    }

    pub(crate) fn touch_query(&mut self, nick: &str, account: Option<String>) {
        let key = self.fold(nick);
        let fresh = !self.queries.contains_key(&key);
        let query = self
            .queries
            .entry(key.clone())
            .or_insert_with(|| QueryState {
                nick: nick.to_string(),
                account: None,
                unread: 0,
                online: true,
            });
        if account.is_some() {
            query.account = account;
        }
        if fresh {
            self.actions
                .push(Action::Remember(OpenTarget::Query(nick.to_string())));
            self.emit_query(&key);
        }
    }

    fn remove_member(&mut self, key: &str, nick: &str) {
        let folded = self.fold(nick);
        let removed = self
            .channels
            .get_mut(key)
            .is_some_and(|channel| channel.members.remove(&folded).is_some());
        if removed {
            self.emit(IrcxEvent::MemberRemoved {
                network: self.config.network.clone(),
                channel: self.channel_name(key),
                nick: nick.to_string(),
            });
        }
    }

    fn sort_member_prefixes(&mut self, key: &str, folded: &str) {
        let ranks: Vec<(String, usize)> = self
            .isupport
            .prefixes
            .iter()
            .enumerate()
            .map(|(rank, (_, prefix))| (prefix.to_string(), rank))
            .collect();
        if let Some(member) = self
            .channels
            .get_mut(key)
            .and_then(|channel| channel.members.get_mut(folded))
        {
            member.prefixes.sort_by_key(|prefix| {
                ranks
                    .iter()
                    .find(|(known, _)| known == prefix)
                    .map(|(_, rank)| *rank)
                    .unwrap_or(usize::MAX)
            });
        }
    }

    fn channel_entry(&mut self, key: &str, name: &str) -> &mut ChannelState {
        self.channels
            .entry(key.to_string())
            .or_insert_with(|| ChannelState {
                name: name.to_string(),
                ..ChannelState::default()
            })
    }

    fn channel_name(&self, key: &str) -> TargetName {
        self.channels
            .get(key)
            .map(|channel| channel.name.clone())
            .unwrap_or_else(|| key.to_string())
    }

    pub(crate) fn channel(&self, key: &str) -> Channel {
        let state = self.channels.get(key);
        Channel {
            network: self.config.network.clone(),
            name: state.map(|c| c.name.clone()).unwrap_or_default(),
            topic: state.and_then(|c| c.topic.clone()),
            modes: state.map(|c| c.modes.clone()).unwrap_or_default(),
            joined: state.is_some_and(|c| c.joined),
            member_count: state.map(|c| c.members.len() as u32).unwrap_or_default(),
            unread: state.map(|c| c.unread).unwrap_or_default(),
            highlights: state.map(|c| c.highlights).unwrap_or_default(),
        }
    }

    pub(crate) fn query(&self, key: &str) -> Query {
        let state = self.queries.get(key);
        Query {
            network: self.config.network.clone(),
            nick: state.map(|q| q.nick.clone()).unwrap_or_default(),
            account: state.and_then(|q| q.account.clone()),
            unread: state.map(|q| q.unread).unwrap_or_default(),
            online: state.is_some_and(|q| q.online),
        }
    }

    fn member_list(&self, channel: &ChannelState) -> Vec<Member> {
        let mut members: Vec<&MemberState> = channel.members.values().collect();
        members.sort_by_key(|member| {
            let rank = member
                .prefixes
                .first()
                .and_then(|prefix| prefix.chars().next())
                .map(|prefix| self.isupport.rank(prefix))
                .unwrap_or(usize::MAX);
            (rank, self.fold(&member.nick))
        });
        members
            .into_iter()
            .map(|member| Member {
                nick: member.nick.clone(),
                account: member.account.clone(),
                prefixes: member.prefixes.clone(),
                away: member.away.clone(),
            })
            .collect()
    }

    pub(crate) fn emit_channel(&mut self, key: &str) {
        let channel = self.channel(key);
        self.emit(IrcxEvent::ChannelUpdated { channel });
    }

    pub(crate) fn emit_query(&mut self, key: &str) {
        let query = self.query(key);
        self.emit(IrcxEvent::QueryUpdated { query });
    }

    fn emit_members(&mut self, key: &str) {
        let Some(channel) = self.channels.get(key) else {
            return;
        };
        let members = self.member_list(channel);
        let name = channel.name.clone();
        self.emit(IrcxEvent::MembersReplaced {
            network: self.config.network.clone(),
            channel: name,
            members,
        });
    }

    fn emit_member(&mut self, key: &str, folded: &str) {
        let Some(channel) = self.channels.get(key) else {
            return;
        };
        let (Some(member), name) = (channel.members.get(folded), channel.name.clone()) else {
            return;
        };
        let member = Member {
            nick: member.nick.clone(),
            account: member.account.clone(),
            prefixes: member.prefixes.clone(),
            away: member.away.clone(),
        };
        self.emit(IrcxEvent::MemberUpdated {
            network: self.config.network.clone(),
            channel: name,
            member,
        });
    }

    fn emit_caps(&mut self) {
        self.emit(IrcxEvent::CapsChanged {
            network: self.config.network.clone(),
            enabled: self.caps.enabled(),
        });
    }

    /// An IRCv3 standard reply: the server explaining itself in a sentence
    /// meant for a person, with a machine-readable code beside it.
    ///
    /// ```text
    /// FAIL <command> <code> [<context>...] :<description>
    /// ```
    ///
    /// The description is the only part written for the user, so it is the only
    /// part shown; the command, the code and any context stay in the raw line,
    /// which the detail carries. Dropping these — which is what happened before
    /// this — throws away the one sentence a server wrote to explain itself,
    /// and leaves a command that did nothing with no reason attached.
    fn handle_standard_reply(&mut self, kind: &str, message: &Message) {
        let severity = match kind {
            "FAIL" => Severity::Error,
            "WARN" => Severity::Warning,
            _ => Severity::Info,
        };
        let command = message.param(0).unwrap_or("*");
        let code = message.param(1).unwrap_or_default();
        // Below three parameters there is no description, only the code: the
        // reply is malformed, and the code is all there is to pass on.
        let described = message.params.len() >= 3;
        let text = match (described, message.params.last()) {
            (true, Some(description)) if !description.trim().is_empty() => description.clone(),
            _ if command == "*" => format!("{} sent {code}", self.network_name()),
            _ => format!("{} sent {code} about {command}", self.network_name()),
        };

        self.notice(severity, text.clone(), &message.raw);
        self.note(SERVER_TARGET, MessageKind::Client, text);
    }

    pub(crate) fn notice(&mut self, severity: Severity, text: String, detail: &str) {
        self.emit(IrcxEvent::Notice {
            network: Some(self.config.network.clone()),
            severity,
            text,
            detail: (!detail.is_empty()).then(|| detail.to_string()),
        });
    }

    fn set_status(&mut self, status: ConnectionStatus) {
        self.status = status.clone();
        self.emit(IrcxEvent::ConnectionChanged {
            network: self.config.network.clone(),
            status,
        });
    }

    fn set_sasl(&mut self, status: SaslStatus) {
        self.sasl = status.clone();
        self.emit(IrcxEvent::SaslChanged {
            network: self.config.network.clone(),
            status,
        });
    }

    /// The newest thing any conversation holds, the console included — the
    /// console's last line is a server timestamp too, and at the moment a
    /// connection ends it is the closest thing to when it ended.
    fn newest_held(&self) -> Option<String> {
        self.archived.values().max().cloned()
    }

    fn reset_connection_state(&mut self) {
        self.caps.forget_all();
        self.isupport = ISupport::default();
        self.registered = false;
        self.cap_ended = false;
        self.nick_attempt = 0;
        self.nick = self.config.nick.clone();
        self.user = None;
        self.host = None;
        self.account = None;
        self.batches.clear();
        self.pending.clear();
        self.ping = None;
        self.lag_ms = None;
        self.sasl = match self.config.sasl {
            Some(_) => SaslStatus::InProgress,
            None => SaslStatus::NotConfigured,
        };

        let keys: Vec<String> = self.channels.keys().cloned().collect();
        for key in keys {
            if let Some(channel) = self.channels.get_mut(&key) {
                channel.joined = false;
                channel.members.clear();
                channel.names.clear();
            }
        }
    }

    pub(crate) fn is_me(&self, nick: &str) -> bool {
        self.isupport.casemapping.equal(nick, &self.nick)
    }

    /// The name this conversation is already known by, for a target that may
    /// have arrived under a different casing.
    ///
    /// IRC compares targets case-insensitively and the casing is display only,
    /// so `nickserv` and `NickServ` are one conversation. Everything below this
    /// point keys on the string — the archive row, the event, the window's
    /// timeline map — so a message filed under the casing it happened to arrive
    /// with becomes a second conversation nobody is reading. #190.
    ///
    /// A target nothing is open for keeps the casing it came with: that is the
    /// first sighting, and it is what the display name is taken from.
    pub(crate) fn canonical(&self, target: &str) -> String {
        let key = self.fold(target);
        if let Some(channel) = self.channels.get(&key) {
            return channel.name.clone();
        }
        if let Some(query) = self.queries.get(&key) {
            return query.nick.clone();
        }
        target.to_string()
    }

    pub(crate) fn fold(&self, name: &str) -> String {
        self.isupport.casemapping.fold(name)
    }

    pub(crate) fn known_account(&self, nick: &str) -> Option<String> {
        let folded = self.fold(nick);
        self.channels
            .values()
            .find_map(|channel| channel.members.get(&folded))
            .and_then(|member| member.account.clone())
    }

    pub(crate) fn send_line(&mut self, line: String) {
        self.emit(IrcxEvent::RawLine {
            network: self.config.network.clone(),
            outgoing: true,
            line: redact(&line),
        });
        self.actions.push(Action::Send(line));
    }

    pub(crate) fn send_command(&mut self, command: &str, params: &[&str]) {
        match build(command, params) {
            Some(line) => self.send_line(line),
            None => debug!(command, "refused to send a malformed command"),
        }
    }

    pub(crate) fn track_pending(&mut self, label: Option<String>, message: ChatMessage) {
        self.pending.push(PendingSend { label, message });
        // A server that never echoes would grow this list forever.
        if self.pending.len() > 64 {
            self.pending.remove(0);
        }
    }

    pub(crate) fn next_label(&mut self) -> String {
        let label = format!("ircx-{}", self.next_label);
        self.next_label += 1;
        label
    }
}

/// `333` carries the time as whole seconds since the epoch. The live path
/// stores RFC 3339 from the `time` tag, so this is what keeps one field in one
/// format.
fn rfc3339(epoch: &str) -> Option<String> {
    let seconds: i64 = epoch.trim().parse().ok()?;
    time::OffsetDateTime::from_unix_timestamp(seconds)
        .ok()?
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// A date a person can read, for a sentence a person will read. The timeline
/// formats the times it draws in its own gutter; this one is inside prose that
/// core writes, like every other system line.
fn readable(rfc3339: &str) -> Option<String> {
    let at = time::OffsetDateTime::parse(rfc3339, &time::format_description::well_known::Rfc3339)
        .ok()?;
    Some(format!(
        "{}-{:02}-{:02} at {:02}:{:02} UTC",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
    ))
}

/// How long somebody has been quiet, coarsely. A WHOIS says 477 and means
/// eight minutes; nobody reading it wants the seconds.
fn idle_for(seconds: i64) -> String {
    match seconds {
        s if s < 0 => "an unknown time".to_string(),
        s if s < 90 => format!("{s} seconds"),
        s if s < 90 * 60 => format!("{} minutes", s / 60),
        s if s < 48 * 3600 => format!("{} hours", s / 3600),
        s => format!("{} days", s / 86_400),
    }
}

fn set_prefix(member: &mut MemberState, prefix: char, adding: bool) {
    let prefix = prefix.to_string();
    match adding {
        true if !member.prefixes.contains(&prefix) => member.prefixes.push(prefix),
        false => member.prefixes.retain(|held| *held != prefix),
        true => {}
    }
}

/// What a channel mode does, as a change somebody made.
///
/// Two phrasings per mode rather than a name and a rule for bending it: the
/// removals are not the additions with a word in front, and writing both out is
/// shorter than the machinery for deriving one from the other.
///
/// A mode with no name here keeps its letter, which is the rule `standing`
/// follows and is still shorter than what it replaces.
fn channel_rule(letter: char, adding: bool) -> String {
    match (letter, adding) {
        ('m', true) => "moderated the channel".into(),
        ('m', false) => "took moderation off the channel".into(),
        ('i', true) => "made the channel invite only".into(),
        ('i', false) => "took invite-only off the channel".into(),
        ('k', true) => "put a key on the channel".into(),
        ('k', false) => "took the key off the channel".into(),
        ('t', true) => "locked the topic to ops".into(),
        ('t', false) => "let anybody set the topic".into(),
        ('n', true) => "blocked messages from outside the channel".into(),
        ('n', false) => "allowed messages from outside the channel".into(),
        ('s', true) => "made the channel secret".into(),
        ('s', false) => "took secrecy off the channel".into(),
        ('l', true) => "put a size limit on the channel".into(),
        ('l', false) => "took the size limit off the channel".into(),
        (other, true) => format!("set +{other} on the channel"),
        (other, false) => format!("took -{other} off the channel"),
    }
}

/// The same modes as a description of what a channel is, for the line said on
/// the way in. Anything unnamed is left out rather than spelled: a reader who
/// wants the letters has the raw log, and a sentence ending in "and +C" helps
/// nobody.
fn channel_rules(flags: &str) -> Vec<&'static str> {
    flags
        .chars()
        .filter_map(|letter| match letter {
            'm' => Some("moderated"),
            'i' => Some("invite only"),
            'k' => Some("behind a key"),
            't' => Some("topic-locked to ops"),
            'n' => Some("closed to messages from outside"),
            's' => Some("secret"),
            'l' => Some("size-limited"),
            _ => None,
        })
        .collect()
}

/// `a`, `a and b`, `a, b and c`.
fn and_then(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [only] => (*only).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// What a membership mode is called, for a reader rather than for a log.
///
/// Only the letters `PREFIX` gives a standing for reach this, so the fallback
/// is a mode this network names and this client has never heard of. Saying
/// `took +y` is still shorter than the letters it replaces, and still true.
fn standing(letter: char, adding: bool) -> String {
    let name = match letter {
        'q' => "owner".to_string(),
        'a' => "admin".to_string(),
        'o' => "ops".to_string(),
        'h' => "half-ops".to_string(),
        'v' => "voice".to_string(),
        other => format!("+{other}"),
    };
    match adding {
        true => format!("took {name}"),
        false => format!("lost {name}"),
    }
}

pub(crate) fn build(command: &str, params: &[&str]) -> Option<String> {
    let mut builder = MessageBuilder::new(command);
    for param in params {
        builder = builder.param(*param);
    }
    builder.build().ok().map(|message| message.to_line())
}

/// What somebody tells a service to prove who they are. The verb comes first in
/// every one of these, and everything after it is the secret.
const CREDENTIAL_VERBS: &[&str] = &[
    "identify", "id", "register", "setpass", "ghost", "release", "regain", "login", "auth",
];

/// The raw log is a UI surface, so what is only ever a password does not reach
/// it. Three shapes are, and the third is the one that cost something.
///
/// `AUTHENTICATE` was here first: its payload is the password in base64.
/// `PASS` and `OPER` are the same case with no argument worth showing.
///
/// The third is a message to a service — `identify`, `ghost`, `setpass` and the
/// rest. It is redacted only when it is not addressed to a channel, because the
/// wire log exists to show messages and hiding them by sniffing their text is
/// exactly what it should not do. Nobody identifies to a channel; somebody may
/// well type "identify yourself" in one. #269, found when a connect command put
/// a NickServ password in a log that was then pasted into a bug report.
fn redact(line: &str) -> String {
    if let Some(rest) = line.strip_prefix("AUTHENTICATE ") {
        return match rest {
            "+" | "PLAIN" | "EXTERNAL" => line.to_string(),
            _ => "AUTHENTICATE <credentials>".to_string(),
        };
    }
    for command in ["PASS", "OPER"] {
        if line
            .strip_prefix(command)
            .is_some_and(|r| r.starts_with(' '))
        {
            return format!("{command} <credentials>");
        }
    }
    redact_service_message(line).unwrap_or_else(|| line.to_string())
}

/// `PRIVMSG nickserv :identify hunter2` and its relatives, with the secret
/// taken out and the verb left in, so the log still says what was attempted.
fn redact_service_message(line: &str) -> Option<String> {
    let (command, rest) = line.split_once(' ')?;
    if !matches!(command, "PRIVMSG" | "NOTICE") {
        return None;
    }
    let (target, text) = rest.split_once(" :")?;
    if target.starts_with('#') || target.starts_with('&') {
        return None;
    }
    let (verb, secret) = text.split_once(' ')?;
    let known = CREDENTIAL_VERBS
        .iter()
        .any(|candidate| verb.eq_ignore_ascii_case(candidate));
    (known && !secret.is_empty()).then(|| format!("{command} {target} :{verb} <credentials>"))
}

#[cfg(test)]
mod redaction {
    use super::redact;

    #[test]
    fn keeps_a_line_that_carries_no_secret() {
        assert_eq!(redact("PRIVMSG #ircx :hello"), "PRIVMSG #ircx :hello");
        assert_eq!(redact("AUTHENTICATE PLAIN"), "AUTHENTICATE PLAIN");
        assert_eq!(redact("AUTHENTICATE +"), "AUTHENTICATE +");
        assert_eq!(redact("PASSWORD_RESET foo"), "PASSWORD_RESET foo");
    }

    #[test]
    fn takes_out_a_payload_that_is_only_ever_a_password() {
        assert_eq!(
            redact("AUTHENTICATE aGVsbG8="),
            "AUTHENTICATE <credentials>"
        );
        assert_eq!(redact("PASS hunter2"), "PASS <credentials>");
        assert_eq!(redact("OPER syk hunter2"), "OPER <credentials>");
    }

    /// #269: a connect command put one of these in a log that was then pasted
    /// into a bug report. The verb stays, so the log still says what was tried.
    #[test]
    fn takes_out_what_a_service_was_told() {
        assert_eq!(
            redact("PRIVMSG nickserv :identify hunter2"),
            "PRIVMSG nickserv :identify <credentials>"
        );
        assert_eq!(
            redact("PRIVMSG NickServ :GHOST syk hunter2"),
            "PRIVMSG NickServ :GHOST <credentials>"
        );
        assert_eq!(
            redact("NOTICE nickserv :setpass syk key new"),
            "NOTICE nickserv :setpass <credentials>"
        );
    }

    /// The log exists to show messages, so hiding one by sniffing its text is
    /// the thing it must not do. Nobody identifies to a channel.
    #[test]
    fn leaves_a_channel_alone_however_it_reads() {
        assert_eq!(
            redact("PRIVMSG #ircx :identify yourself"),
            "PRIVMSG #ircx :identify yourself"
        );
        assert_eq!(
            redact("PRIVMSG &local :register your account"),
            "PRIVMSG &local :register your account"
        );
    }

    /// A verb with nothing after it is somebody asking for the syntax.
    #[test]
    fn leaves_a_verb_with_no_secret_after_it() {
        assert_eq!(
            redact("PRIVMSG nickserv :identify"),
            "PRIVMSG nickserv :identify"
        );
        assert_eq!(redact("PRIVMSG nickserv :help"), "PRIVMSG nickserv :help");
    }
}
