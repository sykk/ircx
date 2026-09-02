use std::collections::{HashMap, HashSet, VecDeque};
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
use time::OffsetDateTime;
use tracing::debug;

use crate::caps::Caps;
use crate::casemap::CaseMapping;
use crate::client;
use crate::history;
use crate::isupport::ISupport;
use crate::numeric::{self, *};
use crate::sasl;
use crate::scram;
use crate::sts;
use crate::text;
use crate::transfers::{TransferJob, TransferRecord};
use crate::who;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;

/// The network's own tab: connection notes, MOTD, WHOIS output, anything the
/// server said that was not about a channel.
pub const SERVER_TARGET: &str = "*";

/// How many channels a `LIST` may leave in memory. Libera answers with about
/// twenty-two thousand; the cap is here because the count comes from the server
/// and a hostile one could stream without end.
const MAX_LISTING: usize = 50_000;

/// Who decided this client is away. The distinction is the whole of what
/// makes an idle timer safe to run: it may only take back what it said itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AwaySource {
    /// `/away`, typed by the reader.
    Reader,
    /// The idle timer.
    Idle,
}

#[derive(Debug)]
pub enum Action {
    /// `ticket` is what the transport reports back once the line is written.
    Send {
        line: String,
        ticket: u64,
    },
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
    /// The answer to one reader's `page_back` arrived. `more` is whether the
    /// page came back full, which is the server saying there is another behind
    /// it; the messages themselves went out as `MessagesAppended` and are
    /// already drawn and archived by the time this is read.
    PagedBack {
        label: String,
        more: bool,
    },
    StsPolicy {
        host: String,
        port: Option<u16>,
        duration: u64,
    },
    StsUpgrade {
        port: u16,
    },
    /// The connection is still open as far as the socket knows and is not
    /// carrying anything. Drop it and reconnect; `reason` is what the user is
    /// told the connection ended for.
    Stalled {
        reason: String,
    },
    /// Write an ignore down, or take it away.
    ///
    /// The session has already applied it — this is durability, so the next
    /// launch starts out not hearing from them either. A rename is two of
    /// these, the old name and the new one, in one drain.
    Ignore {
        nick: String,
        ignored: bool,
    },
    Watch {
        nick: String,
        watched: bool,
    },
    /// The real name the server accepted. The session registers with it again
    /// on its own; this is durability, so the next launch does too.
    Realname {
        text: String,
    },
    /// Open the connection this transfer needs and move the file. Everything
    /// the task layer has to decide is settled in here; what it reports back
    /// are the port it opened, how far it has got, and how it ended.
    RunTransfer(Box<TransferJob>),
    /// Stop a transfer's task wherever it got to. What is on disk stays there,
    /// which is what a later resume is built on.
    StopTransfer {
        id: String,
    },
    /// A resume this client agreed to, for a job already waiting to send. It
    /// arrives before the connection does, because the other side dials only
    /// after reading the agreement.
    ResumeTransferAt {
        id: String,
        from: u64,
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
    pub socks5_proxy: Option<String>,
    /// The PEM this network presents, if SASL EXTERNAL is to have anything to
    /// authenticate with.
    pub client_certificate: Option<String>,
    pub nick: String,
    pub alt_nicks: Vec<String>,
    pub username: String,
    pub realname: String,
    pub sasl: Option<SaslCredentials>,
    pub connect_commands: Vec<String>,
    pub autojoin: Vec<String>,
    /// What is said on the way out when nothing else is. `dispatch.rs` reads
    /// all three.
    pub quit_message: Option<String>,
    pub part_message: Option<String>,
    pub away_message: Option<String>,
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
            socks5_proxy: config.socks5_proxy.clone(),
            client_certificate: config.client_certificate.clone(),
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
            quit_message: config.quit_message.clone(),
            part_message: config.part_message.clone(),
            away_message: config.away_message.clone(),
        }
    }
}

#[derive(Debug, Default, Clone)]
pub(crate) struct MemberState {
    pub(crate) nick: String,
    pub(crate) account: Option<String>,
    pub(crate) prefixes: Vec<String>,
    pub(crate) away: Option<String>,
    pub(crate) realname: Option<String>,
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
pub(crate) struct UnreadAt {
    pub(crate) timestamp: OffsetDateTime,
    pub(crate) highlight: bool,
}

/// What became of a reader's ask for the page behind what they hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageBack {
    /// It went out under this label, and the batch carrying that label is the
    /// answer.
    Asked(String),
    /// Nothing went out and nothing will: a server that granted neither
    /// capability, one that said it would answer with nothing, or a message
    /// whose timestamp will not parse. There is no more to reach, which for
    /// every one of those is what it means here.
    Refused,
    /// Nothing went out because the conversation's own first page is already
    /// coming. That page is behind what the reader holds — it is the whole of
    /// what they hold — so asking again would fetch it twice. Whether anything
    /// is behind *it* is not known yet, and the reader is told there may be:
    /// the alternative is a pane that says the history has run out on the
    /// evidence of a request it declined to make.
    Deferred,
}

/// How far one conversation's gap fill has got, and which way it is walking.
///
/// The walk runs forward from the archive's watermark until half the budget is
/// spent, then turns round and works back from now. `frontier` is what it
/// fetched last on the way out: a page whose oldest message is no newer than
/// that has met the forward half, and there is no hole between them. #520.
#[derive(Debug, Default)]
pub(crate) struct GapFill {
    pages: u32,
    /// `None` while the walk is still going forward.
    frontier: Option<String>,
}

/// The two ends of a page of a gap, which is what decides the next request:
/// walking forward carries on from the newest of it, walking back from the
/// oldest.
///
/// A msgid beside each because `AFTER` and `BEFORE` are both exclusive and a
/// millisecond is not a unique key, so a timestamp steps over everything
/// sharing it. #253.
pub(crate) struct GapPage {
    pub(crate) newest: String,
    pub(crate) newest_msgid: Option<String>,
    pub(crate) oldest: String,
    pub(crate) oldest_msgid: Option<String>,
}

#[derive(Debug)]
pub(crate) struct BatchState {
    pub(crate) kind: String,
    pub(crate) opening: Message,
    pub(crate) source: MessageSource,
    /// The `label` of the request this batch answers, where the server sent one.
    /// It is how a page a reader is waiting for is told from a gap fill of the
    /// same conversation.
    pub(crate) label: Option<String>,
    /// The conversation the batch names, taken from its own parameter rather
    /// than from what arrives inside it. A `chathistory` batch that answers
    /// with nothing still says which conversation it answered for, and that is
    /// the one case where the messages cannot say it.
    pub(crate) target: Option<String>,
    pub(crate) messages: Vec<ChatMessage>,
}

#[derive(Debug)]
struct PendingSend {
    /// What the transport calls the line this message went out on. It is how a
    /// write is matched back when there is no label to match on, which is every
    /// server without `labeled-response`.
    ticket: u64,
    label: Option<String>,
    message: ChatMessage,
}

pub struct SessionState {
    pub(crate) config: SessionConfig,
    pub(crate) isupport: ISupport,
    pub(crate) caps: Caps,
    pub(crate) nick: String,
    /// What raises a conversation beside the nick. Read from the store when the
    /// session starts and replaced whenever the settings window writes it, so a
    /// word added mid-conversation counts from the next line rather than from
    /// the next launch.
    pub(crate) highlight_words: Vec<String>,
    /// Whose lines never raise one, whatever they say. The inverse of the words
    /// above and read the same way, so a name added mid-conversation takes
    /// effect on the next line.
    ///
    /// Compared without case and without the network's casemapping: the
    /// frontend answers this question too, for the notification a query would
    /// otherwise raise, and it has no CASEMAPPING to fold with. Two rules that
    /// disagreed about who is hushed would be worse than one that treats
    /// `sykk[m]` and `sykk{m}` as two names — which the reader can write both
    /// of, and which no service nick has ever needed.
    pub(crate) hushed_nicks: Vec<String>,
    /// Conversations that may not interrupt the reader, as the store holds
    /// them: an empty string among them is the whole network.
    ///
    /// Held unfolded and compared through `fold`, because this is seeded before
    /// the connection has said what its CASEMAPPING is — folding on receipt
    /// would settle `#Foo` against the wrong rule for the rest of the session.
    /// The list is a handful of names, so the walk costs nothing worth keeping
    /// a second copy to avoid.
    pub(crate) muted: Vec<TargetName>,
    /// People the reader does not want to hear from, as the store holds them.
    ///
    /// Held unfolded and compared through `fold` for the reason `muted` above
    /// gives: it is seeded before the connection has said what its CASEMAPPING
    /// is, and folding on receipt would settle a nick against the wrong rule
    /// for the rest of the session.
    pub(crate) ignored: Vec<String>,
    pub(crate) watched: Vec<String>,
    pub(crate) user: Option<String>,
    pub(crate) host: Option<String>,
    pub(crate) account: Option<String>,
    pub(crate) channels: HashMap<String, ChannelState>,
    pub(crate) queries: HashMap<String, QueryState>,
    /// Folded nick to the spelling sent to the server.
    monitored: HashMap<String, String>,
    /// Nicks a whois is outstanding for that nobody typed: the inspector asks
    /// for one when it is opened on somebody whose real name is not known.
    quiet_whois: HashSet<String>,
    /// Channels whose `NAMES` was asked for by hand, folded. The reply arrives
    /// on a join as well, where it fills the member list and says nothing, so
    /// what tells the two apart is which of them somebody asked for.
    pub(crate) named: HashSet<String>,
    /// Nicks a quiet whois has already gone out for on this connection, asked
    /// or answered. The inspector asks about somebody signed in to nothing as
    /// readily as about somebody it has not heard of, and a server with no
    /// account to report answers with no `330` at all — so without this the
    /// panel asked again every time it was opened on the same person.
    looked_up: HashSet<String>,
    /// Channels a `WHO` is outstanding for, folded. It is what tells this
    /// client's own roster question from a `WHO` somebody typed: replies under
    /// a channel in here fill the member list and go no further, and every
    /// other one is the server answering a person and is drawn as it always
    /// was.
    pending_who: HashSet<String>,
    /// Last status heard for a watched nick. An absent value is the initial
    /// MONITOR reply, which must not announce everybody already online.
    watch_status: HashMap<String, bool>,
    /// Nicks a `WHOWAS` block is open for and has said something about,
    /// folded. It answers two questions: whether a `312` or a `338` is about
    /// somebody gone or somebody here, and whether the end of the block is
    /// speaking for a nickname the server remembered nothing of.
    whowas: HashSet<String>,
    /// Which of a channel's mode lists an entry has arrived under, folded
    /// channel and list. A server sends nothing at all for an empty list, so
    /// its end numeric is the only place that can say it was empty, and this
    /// is how it knows.
    mode_lists_answered: HashSet<(String, ModeList)>,
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
    sts_verified_transport: bool,
    sts_upgrade_port: Option<u16>,
    nick_attempt: usize,
    pending: Vec<PendingSend>,
    /// Numbers every line handed to the transport. Never reset: a ticket from
    /// a connection that has ended must not name a line on the next one.
    next_ticket: u64,
    /// The highest ticket the transport has reported writing.
    written: u64,
    next_label: u64,
    /// Whether this client has told the server it is away, and who decided
    /// it. Only what the idle timer said does the idle timer take back: an
    /// away the reader typed outlives their keyboard going quiet.
    away: Option<AwaySource>,
    /// The last thing the window said about whether the reader is at it.
    ///
    /// Kept across a reconnect, unlike `away`. A keyboard does not know a
    /// socket dropped, so nothing would report it again, and a reader who
    /// walked away before the reconnect would come back present without having
    /// come back.
    idle: bool,
    ping: Option<(String, Instant)>,
    /// When a line last arrived from the server, which is what `keepalive`
    /// judges the connection by. A line is the far end talking whatever it
    /// says, so a server whose `PONG` this client cannot match against a token
    /// is still audibly there.
    last_heard: Instant,
    lag_ms: Option<u32>,
    /// Collected between `321` and `323`. A `LIST` is answered with one reply
    /// per channel and a network has tens of thousands, so they are gathered
    /// and sent once rather than becoming an event and a console line each.
    listing: Vec<ChannelListing>,
    /// Where each conversation's record left off, folded target to timestamp:
    /// seeded from the archive at restore and moved on by every message that
    /// arrives. It is what a `CHATHISTORY` request asks for everything after.
    pub(crate) archived: HashMap<String, String>,
    pub(crate) read_markers: HashMap<String, OffsetDateTime>,
    pub(crate) unread_at: HashMap<String, Vec<UnreadAt>>,
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
    /// Conversations with an outstanding gap request, and how far each has got.
    /// A page that arrives full has more behind it; what comes back was missed
    /// rather than merely never seen, which is the whole of the difference to
    /// the unread count.
    pub(crate) gap_fills: HashMap<String, GapFill>,
    /// The page-back requests still waiting for a batch, by the label that will
    /// name the answer. Labels rather than conversations, because two panes on
    /// one channel can be scrolled back at once and each is waiting for its own
    /// answer — and one pane can have two outstanding, having given up on the
    /// first and asked again (#540).
    ///
    /// The value is what the reader called the ask. It means nothing here; it
    /// goes back out on the batch that answers, which is the only place the two
    /// can be told apart.
    pub(crate) page_backs: HashMap<String, String>,
    /// Labels the typing notifications this client sent on its own went out
    /// under, so an answer to one can be told from an answer to something the
    /// reader said (#591).
    ///
    /// A few, and the oldest goes when a newer one arrives: one notification is
    /// outstanding per conversation at a time and its answer comes within a
    /// round trip, so this holds enough for several conversations at once and
    /// nothing for a server that never answers.
    typing_labels: VecDeque<String>,
    /// The password and email a guided registration was given. A service or a
    /// `REGISTER` reply may echo either one, so they are removed before the raw
    /// line is emitted or parsed into a message.
    pub(crate) registration_secrets: Option<(String, String)>,
    /// Conversations whose first page of history has been asked for and not
    /// answered yet, folded.
    ///
    /// A join asks for the most recent page, and until it comes back the only
    /// thing a pane holds is what this client wrote on the way in — its own
    /// join line and the two notices behind it, archived within the same
    /// second. A reader's pane reads those back, finds a page shorter than
    /// one, and asks the server for what is behind the oldest of them: the
    /// most recent page, which is the one already on its way. #486.
    pub(crate) first_pages: HashSet<String>,
    /// Files moving between this session and one other person, oldest first.
    ///
    /// A list rather than a map because a transfer is looked up three ways —
    /// by its own id, by the port a handshake line names, and by the token a
    /// passive offer carries — and a map keyed on one of them would be searched
    /// for the other two anyway. There are never many.
    pub(crate) transfers: Vec<TransferRecord>,
    /// Names the next passive offer this client makes. Only has to be unique
    /// among the offers outstanding with one person at one time; a counter is
    /// what every client uses and what their parsers expect.
    pub(crate) next_transfer_token: u64,
}

impl SessionState {
    pub fn new(config: SessionConfig) -> Self {
        let sasl = match config.sasl {
            Some(_) => SaslStatus::InProgress,
            None => SaslStatus::NotConfigured,
        };
        Self {
            nick: config.nick.clone(),
            highlight_words: Vec::new(),
            hushed_nicks: Vec::new(),
            muted: Vec::new(),
            ignored: Vec::new(),
            watched: Vec::new(),
            config,
            isupport: ISupport::default(),
            caps: Caps::default(),
            user: None,
            host: None,
            account: None,
            channels: HashMap::new(),
            queries: HashMap::new(),
            monitored: HashMap::new(),
            quiet_whois: HashSet::new(),
            named: HashSet::new(),
            looked_up: HashSet::new(),
            pending_who: HashSet::new(),
            watch_status: HashMap::new(),
            whowas: HashSet::new(),
            mode_lists_answered: HashSet::new(),
            batches: HashMap::new(),
            actions: Vec::new(),
            registered: false,
            status: ConnectionStatus::Disconnected,
            sasl,
            scram: None,
            challenge: String::new(),
            cap_ended: false,
            sts_verified_transport: false,
            sts_upgrade_port: None,
            nick_attempt: 0,
            pending: Vec::new(),
            next_ticket: 1,
            written: 0,
            next_label: 1,
            away: None,
            idle: false,
            ping: None,
            last_heard: Instant::now(),
            lag_ms: None,
            listing: Vec::new(),
            archived: HashMap::new(),
            read_markers: HashMap::new(),
            unread_at: HashMap::new(),
            away_since: None,
            gap_fills: HashMap::new(),
            page_backs: HashMap::new(),
            typing_labels: VecDeque::new(),
            registration_secrets: None,
            first_pages: HashSet::new(),
            transfers: Vec::new(),
            next_transfer_token: 0,
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
            configured_nick: self.config.nick.clone(),
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

    pub fn enforce_sts(&mut self, port: u16) {
        self.config.port = port;
        self.config.tls = true;
        self.config.tls_verify = true;
        self.sts_upgrade_port = Some(port);
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
        self.sts_verified_transport = tls.is_some() && self.config.tls_verify;
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
        // Before the parse, because a line this client cannot read is still
        // the server having said something.
        self.last_heard = Instant::now();
        let line = self.redact_registration(line);
        self.emit(IrcxEvent::RawLine {
            network: self.config.network.clone(),
            outgoing: false,
            line: line.clone(),
        });
        match Message::parse(&line) {
            Ok(message) => self.handle(&message),
            // A line we cannot parse is the server's problem, not the user's.
            Err(error) => debug!(%error, line, "dropped an unparseable line"),
        }
        self.drain()
    }

    fn redact_registration(&self, line: &str) -> String {
        let Some((password, email)) = &self.registration_secrets else {
            return line.to_string();
        };
        // An empty needle matches between every pair of characters, and a
        // registration with no email address holds one: `REGISTER` sends `*`
        // where the server does not ask for one.
        let line = match email.is_empty() {
            true => line.to_string(),
            false => line.replace(email, "<email>"),
        };
        match password.is_empty() {
            true => line,
            false => line.replace(password, "<credentials>"),
        }
    }

    /// Measures the round trip so the UI can show lag, and gives up on a
    /// connection that has gone quiet.
    ///
    /// The test is not whether the last `PING` was answered but whether
    /// anything at all arrived after it went out, so a server with its own idea
    /// of what a `PONG` looks like is not disconnected for talking. Silence
    /// across a whole interval is the far end having forgotten the socket:
    /// nothing else notices until the kernel stops retransmitting, which is a
    /// quarter of an hour of typing into a connection nobody is reading.
    ///
    /// Only once registered, because `ping` is only set once registered. A
    /// connection that hangs before it is a different failure.
    pub fn keepalive(&mut self) -> Vec<Action> {
        if !self.registered {
            return self.drain();
        }
        if let Some((_, sent)) = &self.ping {
            if self.last_heard < *sent {
                self.actions.push(Action::Stalled {
                    reason: "the server stopped answering".into(),
                });
                return self.drain();
            }
        }
        let token = format!("ircx{}", self.next_label);
        self.next_label += 1;
        self.ping = Some((token.clone(), Instant::now()));
        self.send_command("PING", &[&token]);
        self.drain()
    }

    /// The window reporting whether the reader is still at it.
    ///
    /// What counts as being at it is the window's question — it is where the
    /// keyboard is — and what to do about the answer is this one's.
    pub fn on_idle(&mut self, idle: bool) -> Vec<Action> {
        self.idle = idle;
        self.follow_idle();
        self.drain()
    }

    /// Says away, or comes back, where the idle timer is what decided it.
    ///
    /// An away the reader typed is left alone in both directions: going idle
    /// does not overwrite the reason they wrote, and touching the keyboard
    /// afterwards does not cancel it. `/back` while still idle is the same
    /// bargain read the other way — it is an explicit "I am here", so this
    /// leaves them here until they go idle again.
    fn follow_idle(&mut self) {
        if !self.registered {
            return;
        }
        match (self.idle, self.away) {
            (true, None) => {
                let reason = self
                    .config
                    .away_message
                    .clone()
                    .unwrap_or_else(|| crate::dispatch::DEFAULT_AWAY.to_string());
                self.send_command("AWAY", &[&reason]);
                self.away = Some(AwaySource::Idle);
            }
            (false, Some(AwaySource::Idle)) => {
                self.send_command("AWAY", &[]);
                self.away = None;
            }
            _ => {}
        }
    }

    pub(crate) fn set_away_source(&mut self, source: Option<AwaySource>) {
        self.away = source;
    }

    /// Replaces the words that raise a conversation beside the nick.
    ///
    /// Counts from the next message rather than backwards over the ones already
    /// here: a badge is a record of what arrived while you were away, and
    /// rewriting it when a word is added would report a channel as having
    /// interrupted you at a time when it did not.
    pub fn set_highlight_words(&mut self, words: Vec<String>) {
        self.highlight_words = words;
    }

    pub fn set_hushed_nicks(&mut self, nicks: Vec<String>) {
        self.hushed_nicks = nicks;
    }

    /// Whether this sender's lines are allowed to interrupt. `text::hushes` is
    /// the rule, and says why it folds the way it does.
    pub(crate) fn is_hushed(&self, nick: &str) -> bool {
        crate::text::hushes(nick, &self.hushed_nicks)
    }

    /// A rule thought something in this conversation worth interrupting the
    /// user for, so the channel goes as loud as it would for their own nick.
    ///
    /// Additive only. A rule is never asked about a message that already
    /// mentions the user, so this cannot double-count one, and there is
    /// nothing it could be asked to take back.
    pub fn raise(&mut self, target: &str) -> Vec<Action> {
        let key = self.fold(target);
        // Mute is applied here rather than by not asking the rule. By now the
        // rule has answered, the archive holds the raise and the message draws
        // the line naming what raised it — which is the record, and a
        // conversation unmuted next week still shows it. What mute takes away
        // is the interruption, and the badge is the whole of that.
        if self.is_muted(&key) {
            return self.drain();
        }
        // A query has no counter to reach, and deliberately none: its badge is
        // already the loud one, because somebody opened a conversation with the
        // reader and nobody else. A rule can raise in one and this will not
        // move. What the raise leaves there is the archive row and the line
        // under the message.
        if let Some(channel) = self.channels.get_mut(&key) {
            channel.highlights += 1;
            self.emit_channel(&key);
        }
        self.drain()
    }

    /// Whether this conversation may interrupt the reader. `key` is folded, as
    /// every caller of this already holds one.
    pub(crate) fn is_muted(&self, key: &str) -> bool {
        self.muted
            .iter()
            .any(|muted| muted.is_empty() || self.fold(muted) == key)
    }

    /// Replaces what is muted, and says so about every conversation on the
    /// screen.
    ///
    /// All of them rather than the ones that changed: the mark in the sidebar
    /// is drawn from the conversation, and working out which rows moved costs
    /// more than re-stating a list somebody is looking at.
    pub fn set_muted(&mut self, muted: Vec<TargetName>) -> Vec<Action> {
        self.muted = muted;
        let channels: Vec<String> = self.channels.keys().cloned().collect();
        for key in channels {
            self.emit_channel(&key);
        }
        let queries: Vec<String> = self.queries.keys().cloned().collect();
        for key in queries {
            self.emit_query(&key);
        }
        self.drain()
    }

    /// Whether this is somebody the reader asked not to hear from.
    ///
    /// The nick is raw, because every caller holds one off the wire rather
    /// than a folded key.
    pub(crate) fn is_ignored(&self, nick: &str) -> bool {
        let folded = self.fold(nick);
        self.ignored.iter().any(|name| self.fold(name) == folded)
    }

    /// Replaces who is ignored: the whole set, as the store holds it.
    ///
    /// This is the connect-time seed and the answer to a change made from the
    /// settings window. What `/ignore` does is below, and applies to the next
    /// line rather than to the next round trip.
    pub fn set_ignored(&mut self, ignored: Vec<String>) -> Vec<Action> {
        self.ignored = ignored;
        self.say_who_is_ignored();
        self.drain()
    }

    /// Starts or stops ignoring one person, from the composer or a rename.
    ///
    /// The set moves here and the store is told afterwards, so the very next
    /// line from them is already gone. Nothing is emitted about the messages
    /// this silences: they were never drawn, and there is no row to take back.
    pub(crate) fn ignore(&mut self, nick: &str, ignored: bool) {
        let already = self.is_ignored(nick);
        if already == ignored {
            return;
        }
        match ignored {
            true => self.ignored.push(nick.to_string()),
            false => {
                let folded = self.fold(nick);
                self.ignored = self
                    .ignored
                    .iter()
                    .filter(|name| self.fold(name) != folded)
                    .cloned()
                    .collect();
            }
        }
        self.say_who_is_ignored();
        self.actions.push(Action::Ignore {
            nick: nick.to_string(),
            ignored,
        });
    }

    /// The whole set, every time it moves. It is a handful of names, and a
    /// delta would have to survive the reload a reconnect brings with it.
    fn say_who_is_ignored(&mut self) {
        self.emit(IrcxEvent::IgnoredChanged {
            network: self.config.network.clone(),
            nicks: self.ignored.clone(),
        });
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
        let mut conversation = None;
        if let Some(channel) = self.channels.get_mut(&key) {
            conversation = Some(channel.name.clone());
            if channel.unread != 0 || channel.highlights != 0 {
                channel.unread = 0;
                channel.highlights = 0;
                self.emit_channel(&key);
            }
        } else if let Some(query) = self.queries.get_mut(&key) {
            conversation = Some(query.nick.clone());
            if query.unread != 0 {
                query.unread = 0;
                self.emit_query(&key);
            }
        }
        self.unread_at.remove(&key);
        if let Some((target, timestamp, parameter)) = conversation
            .filter(|_| self.caps.is_enabled("draft/read-marker"))
            .and_then(|target| {
                let value = self.archived.get(&key)?;
                Some((
                    target,
                    crate::read_marker::timestamp(value)?,
                    crate::read_marker::parameter(value)?,
                ))
            })
            .filter(|(_, timestamp, _)| {
                self.read_markers
                    .get(&key)
                    .is_none_or(|read| read < timestamp)
            })
        {
            self.read_markers.insert(key, timestamp);
            self.send_command("MARKREAD", &[&target, &parameter]);
        }
        self.drain()
    }

    /// Applies a fact about a person to every roster they are in, and emits
    /// where it changed something. A member is held per channel, so a fact
    /// about the person is a fact in all of them.
    fn update_member(&mut self, nick: &str, mut change: impl FnMut(&mut MemberState) -> bool) {
        let folded = self.fold(nick);
        let keys: Vec<String> = self
            .channels
            .iter()
            .filter(|(_, channel)| channel.members.contains_key(&folded))
            .map(|(key, _)| key.clone())
            .collect();
        for key in keys {
            let changed = self
                .channels
                .get_mut(&key)
                .and_then(|channel| channel.members.get_mut(&folded))
                .is_some_and(&mut change);
            if changed {
                self.emit_member(&key, &folded);
            }
        }
    }

    fn set_realname(&mut self, nick: &str, realname: String) {
        self.update_member(nick, |member| {
            match member.realname.as_deref() == Some(realname.as_str()) {
                true => false,
                false => {
                    member.realname = Some(realname.clone());
                    true
                }
            }
        });
    }

    /// Asks the server about somebody without drawing the answer.
    ///
    /// The inspector calls this when it is opened on a member whose real name
    /// or account it does not have. That used to be everybody who was already
    /// in the channel when the reader arrived; the `WHO` a join sends answers
    /// for most of them now (#677), and what is left is what that reply could
    /// not carry — a `352` has no account field at all, so on a server with no
    /// `WHOX` this is still the only thing that fills one in; and a server with
    /// no `extended-join` says nothing about anybody who arrives after the
    /// `WHO` has run.
    ///
    /// Once per person per connection. It stays a request the reader caused by
    /// looking, which is the same bargain the preview fetch makes, and a reader
    /// who opens the same panel twice is not two questions.
    pub fn look_up(&mut self, nick: &str) -> Vec<Action> {
        let folded = self.fold(nick);
        if self.registered && self.looked_up.insert(folded.clone()) {
            self.quiet_whois.insert(folded);
            self.send_command("WHOIS", &[nick]);
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
                    "SETNAME" => self.handle_setname(message),
                    "MODE" => self.handle_mode(message),
                    "TOPIC" => self.handle_topic(message),
                    "INVITE" => self.handle_invite(message),
                    "AWAY" => self.handle_away(message),
                    "ACCOUNT" => self.handle_account(message),
                    "CHGHOST" => self.handle_chghost(message),
                    "BATCH" => self.handle_batch(message),
                    "MARKREAD" => self.handle_markread(message),
                    "REGISTER" | "VERIFY" => self.handle_registration(&name, message),
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
                    if self.handle_sts() {
                        return;
                    }
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
                let had_read_marker = self.caps.is_enabled("draft/read-marker");
                self.caps.ack(list);
                if self.registered && !had_read_marker && self.caps.is_enabled("draft/read-marker")
                {
                    self.request_query_markers();
                }
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
                let includes_sts = list.split_whitespace().any(|entry| {
                    entry
                        .split_once('=')
                        .map_or(entry, |(name, _)| name)
                        .eq_ignore_ascii_case("sts")
                });
                self.caps.record_available(list);
                if includes_sts && self.handle_sts() {
                    return;
                }
                for line in self.caps.request_lines() {
                    self.send_line(line);
                }
            }
            "DEL" => {
                let removable = list
                    .split_whitespace()
                    .filter(|cap| !cap.eq_ignore_ascii_case("sts"))
                    .collect::<Vec<_>>()
                    .join(" ");
                if !self.caps.remove(&removable).is_empty() {
                    self.emit_caps();
                }
            }
            _ => {}
        }
    }

    fn handle_sts(&mut self) -> bool {
        let Some(advertisement) = self.caps.value("sts").and_then(sts::parse) else {
            return false;
        };

        if !self.sts_verified_transport {
            if self.config.tls {
                return false;
            }
            if let Some(port) = advertisement.port {
                self.actions.push(Action::StsUpgrade { port });
                return true;
            }
            return false;
        }

        if let Some(duration) = advertisement.duration {
            self.actions.push(Action::StsPolicy {
                host: self.config.host.clone(),
                port: self.sts_upgrade_port,
                duration,
            });
        }
        false
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
        // EXTERNAL authenticates with the credentials of the layer underneath,
        // which for IRC is the TLS client certificate. Refused where there is
        // none to present rather than sent anyway: the 904 that comes back
        // otherwise is answered with a sentence about a password, and EXTERNAL
        // has no password in it. #373, #401.
        if credentials.mechanism == SaslMechanism::External
            && self.config.client_certificate.is_none()
        {
            self.fail_sasl(
                "SASL EXTERNAL authenticates with a client certificate, and this network has \
                 none set. Choose a certificate file in this network's settings, or another \
                 mechanism."
                    .to_owned(),
            );
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
        // EXTERNAL has no password to be wrong, and the thing that is wrong is
        // not in this network's settings at all: the certificate is fine, the
        // account simply does not claim it. #401 — and the same complaint #373
        // made about the sentence sent before one was ever sent.
        let fix = match self.config.sasl.as_ref().map(|sasl| sasl.mechanism) {
            Some(SaslMechanism::External) => {
                "Register this certificate's fingerprint with the account — on the network, \
                 not here."
            }
            _ => "Check the account name and password in this network's settings.",
        };
        format!("{} rejected{who}{said}. {fix}", self.network_name())
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

    /// A failure the user can fix by editing the network, so it stops the
    /// connection instead of quietly leaving them unauthenticated.
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
        // An answer to a typing notification is not an answer to the reader,
        // and the label is what says which it is: a moderated channel refuses
        // the notification the composer sends as they type, and `404` was being
        // described as their message having been refused — twice a line, before
        // they had sent one (#591).
        //
        // Only what this client labelled is claimed here. Without
        // `labeled-response` a typing notification carries no label, nothing
        // can be matched to it, and the sentence stays as it was.
        if message
            .tag("label")
            .is_some_and(|label| self.was_typing_notification(label))
        {
            return;
        }

        // A refusal wearing a send's label belongs on the message it refuses,
        // where the row draws the reason and offers the retry. It is not also a
        // system row: that is the same sentence twice in one conversation, the
        // second time detached from the line it is about — and where the
        // message is a query's, the system row went to the server tab instead,
        // so the conversation it failed in said nothing at all.
        if self.fail_labelled_send(code, message) {
            return;
        }

        // The first parameter of a numeric is our own nick; nothing below
        // wants it. Borrowed, not cloned: a /list is tens of thousands of
        // numerics through here.
        let params = message.params.get(1..).unwrap_or_default();

        // A whois nobody typed answers a panel rather than the server tab.
        // What is wanted out of it is taken before this returns.
        if self.quiet_whois(code, params) {
            return;
        }

        match code {
            RPL_WELCOME => self.on_welcome(message),
            RPL_ISUPPORT => {
                let tokens = params.split_last().map_or(&[][..], |(_, tokens)| tokens);
                self.apply_isupport(tokens);
            }
            RPL_LISTSTART => self.listing.clear(),
            RPL_LIST => self.on_list_reply(params),
            RPL_LISTEND => self.on_list_end(),
            RPL_NAMREPLY => self.on_names(params),
            RPL_ENDOFNAMES => self.on_end_of_names(params),
            RPL_WHOREPLY => match who::reply(params) {
                Some(reply) if self.asked_who(&reply.channel) => self.take_who(reply),
                _ => self.on_other_numeric(code, params, message),
            },
            RPL_WHOSPCRPL => match who::whox_reply(params) {
                Some(reply) if self.asked_who(&reply.channel) => self.take_who(reply),
                _ => self.on_other_numeric(code, params, message),
            },
            RPL_ENDOFWHO => match params.first() {
                Some(name) if self.asked_who(name) => self.on_end_of_who(name.clone()),
                _ => self.on_other_numeric(code, params, message),
            },
            RPL_TOPIC => self.on_topic_reply(params),
            RPL_NOTOPIC => self.on_no_topic(params),
            RPL_TOPICWHOTIME => self.on_topic_who_time(params),
            RPL_CREATIONTIME => {}
            RPL_LOCALUSERS | RPL_GLOBALUSERS => self.server_sentence(message),
            RPL_WHOWASUSER | ERR_WASNOSUCHNICK => self.on_whowas(code, params, message),
            RPL_ENDOFWHOWAS => self.on_end_of_whowas(params, message),
            // The two numerics a whois and a whowas share. Inside a block they
            // are about somebody who has gone, and the whois sentence for `312`
            // would say they are connected.
            RPL_WHOISSERVER | RPL_WHOISACTUALLY if self.inside_a_whowas(params) => {
                self.on_whowas(code, params, message)
            }
            RPL_WHOISUSER | RPL_WHOISSERVER | RPL_WHOISIDLE | RPL_WHOISCHANNELS
            | RPL_WHOISACCOUNT => self.on_whois(code, params, message),
            RPL_CHANNELMODEIS => self.on_channel_modes(params),
            RPL_BANLIST => self.on_mode_list(ModeList::Ban, params, message),
            RPL_EXCEPTLIST => self.on_mode_list(ModeList::Exception, params, message),
            RPL_INVITELIST => self.on_mode_list(ModeList::Invite, params, message),
            RPL_ENDOFBANLIST => self.on_end_of_mode_list(ModeList::Ban, params, message),
            RPL_ENDOFEXCEPTLIST => self.on_end_of_mode_list(ModeList::Exception, params, message),
            RPL_ENDOFINVITELIST => self.on_end_of_mode_list(ModeList::Invite, params, message),
            RPL_QUIETLIST => match without_mode_letter(params, 'q') {
                Some(params) => self.on_mode_list(ModeList::Quiet, &params, message),
                None => self.on_other_numeric(code, params, message),
            },
            RPL_ENDOFQUIETLIST => match without_mode_letter(params, 'q') {
                Some(params) => self.on_end_of_mode_list(ModeList::Quiet, &params, message),
                None => self.on_other_numeric(code, params, message),
            },
            RPL_AWAY => self.on_away_reply(params),
            RPL_MONONLINE => self.on_monitor_status(params, true),
            RPL_MONOFFLINE => self.on_monitor_status(params, false),
            ERR_NICKNAMEINUSE => self.on_nick_refused(params, message, "is taken"),
            // As final as 433 while registering: without the same fallback the
            // session sat at `Registering` forever, no alternate tried and no
            // failure declared. Registered, each describes a failed rename and
            // falls through to the numeric's own sentence.
            ERR_ERRONEUSNICKNAME if !self.registered => {
                self.on_nick_refused(params, message, "was not accepted")
            }
            ERR_NICKCOLLISION if !self.registered => {
                self.on_nick_refused(params, message, "collided with another server")
            }
            ERR_UNAVAILRESOURCE if !self.registered => {
                self.on_nick_refused(params, message, "is briefly held")
            }
            RPL_LOGGEDIN => {
                let account = params.get(1).cloned().unwrap_or_default();
                self.account = Some(account.clone());
                // 900 arrives for a NickServ login as readily as for SASL, so
                // this is the one place a login the client had no part in
                // overwrites what the client knows. Refusing to set the account
                // outside SASL would leave everybody who identifies by hand
                // reading "not signed in" while signed in; carrying the refusal
                // forward says both true things instead. #390.
                let refused = match &self.sasl {
                    SaslStatus::Failed { message } => Some(message.clone()),
                    _ => None,
                };
                self.set_sasl(SaslStatus::Authenticated { account, refused });
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
            _ => self.on_other_numeric(code, params, message),
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
        self.follow_idle();

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
                    Some(line) => {
                        self.send_line(line);
                    }
                    None => debug!(command, "skipped an unsendable connect command"),
                },
            }
        }
        for channel in self.channels_to_join() {
            self.send_command("JOIN", &[&channel]);
        }
        self.sync_monitor();
        self.request_query_markers();
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
            self.gap_fills.entry(key).or_default();
        }
    }

    /// How much history one request may ask for: the smaller of what the server
    /// said it would answer with and the page this client reads.
    pub(crate) fn page_limit(&self) -> u32 {
        self.isupport
            .chathistory
            .map_or(history::PAGE, |max| max.min(history::PAGE))
    }

    /// Asks for the page behind the oldest message a reader is holding, and
    /// answers with the label that will name it.
    ///
    /// `labeled-response` is required as well as `draft/chathistory`, and this
    /// is the one place in the client where a missing capability costs a
    /// feature rather than changing how it works. A gap fill and a page back
    /// are both `chathistory` batches naming the same conversation, and without
    /// a label on the answer the client cannot say which of the two arrived —
    /// which would leave it walking forwards through history the reader
    /// already has, counting it as unread. Asking nothing is the honest
    /// degrade. Every server with `draft/chathistory` this project has met
    /// grants both.
    pub fn page_back(
        &mut self,
        target: &str,
        from: &str,
        msgid: Option<&str>,
        ask: String,
    ) -> (PageBack, Vec<Action>) {
        (
            self.ask_for_page_back(target, from, msgid, ask),
            self.drain(),
        )
    }

    fn ask_for_page_back(
        &mut self,
        target: &str,
        from: &str,
        msgid: Option<&str>,
        ask: String,
    ) -> PageBack {
        if !self.caps.is_enabled("draft/chathistory") || !self.caps.is_enabled("labeled-response") {
            return PageBack::Refused;
        }
        let limit = self.page_limit();
        if limit == 0 {
            return PageBack::Refused;
        }
        // The conversation's own first page is still coming and is the answer
        // to this. #486.
        if self.first_pages.contains(&self.fold(target)) {
            return PageBack::Deferred;
        }
        let label = self.next_label();
        let resume = history::Resume {
            timestamp: from,
            msgid,
        };
        let Some(line) = history::before(target, resume, limit, Some(&label)) else {
            return PageBack::Refused;
        };
        self.page_backs.insert(label.clone(), ask);
        self.send_line(line);
        PageBack::Asked(label)
    }

    /// Asks for the next page of a gap that has not been closed yet, and turns
    /// the walk round half way through the budget.
    ///
    /// Forward first, from the archive's watermark, because that is what
    /// continues where the reader stopped reading and because nearly every gap
    /// closes inside one page. `AFTER` answers oldest-first, so a full page is
    /// the *start* of what was missed and the rest is still out there. #239.
    ///
    /// Pages still coming back full at `GAP_FORWARD` are a gap too wide to fetch
    /// whole, and the walk turns round: it asks for the newest page the
    /// conversation has and works back until it meets what the forward half
    /// already fetched. What the cap costs is then the middle of the gap rather
    /// than the stretch running up to the conversation happening now. #520.
    ///
    /// Each request resumes from an end of the page that just arrived and never
    /// from the conversation's watermark: that moves with every message
    /// including the live ones, so a channel that says anything mid-flight
    /// pushes it to now — which asks for the gap from after the end of it and
    /// silently skips the rest. Found against a real server, where the second
    /// request went out stamped later than the whole backlog it was chasing.
    pub(crate) fn continue_gap(&mut self, target: &str, page: &GapPage) {
        let key = self.fold(target);
        let walked = self.gap_fills.remove(&key).unwrap_or_default();
        let pages = walked.pages + 1;
        // The two halves have met. Everything from where the reader stopped
        // reading to now is held, there is no hole to say anything about, and
        // whatever budget is left goes unspent.
        if walked
            .frontier
            .as_deref()
            .is_some_and(|frontier| page.oldest.as_str() <= frontier)
        {
            return;
        }
        let limit = self.page_limit();
        let line = match &walked.frontier {
            None if pages < history::GAP_FORWARD => history::request(
                target,
                Some(history::Resume {
                    timestamp: &page.newest,
                    msgid: page.newest_msgid.as_deref(),
                }),
                limit,
            ),
            // Half the budget gone and the pages still full. The near end of the
            // gap is wherever the conversation is now, and the most recent page
            // is the only way to ask for that: there is no selector for "now"
            // and the client cannot name a message it has never been sent.
            None => history::request(target, None, limit),
            Some(_) if pages >= history::GAP_PAGES => {
                self.note_gap(target, pages * limit, &page.oldest);
                return;
            }
            Some(_) => history::before(
                target,
                history::Resume {
                    timestamp: &page.oldest,
                    msgid: page.oldest_msgid.as_deref(),
                },
                limit,
                None,
            ),
        };
        let Some(line) = line else {
            return;
        };
        // Named as the walk turns round: the newest message the forward half
        // fetched, which is the far side of the hole and what the backward half
        // is closing towards.
        let frontier = walked
            .frontier
            .or_else(|| (pages >= history::GAP_FORWARD).then(|| page.newest.clone()));
        self.gap_fills.insert(key, GapFill { pages, frontier });
        self.send_line(line);
    }

    /// The one case where the client knows it is behind, said where it is
    /// behind.
    ///
    /// Stamped a millisecond ahead of the oldest message the walk brought back
    /// from the near end, so the row is drawn at the hole. Said at the bottom of
    /// the conversation instead — which is where `note` puts it, on the clock —
    /// it explains a discontinuity the reader meets a screen or two above it and
    /// reads across as if the conversation ran on.
    fn note_gap(&mut self, target: &str, fetched: u32, below: &str) {
        let at = history::just_before(below).unwrap_or_else(crate::message::now);
        self.note_at(
            target,
            MessageKind::Client,
            format!(
                "This conversation moved faster than ircx caught up with: \
                 {fetched} messages of it were fetched, and what was said \
                 between here and the message above was not."
            ),
            at,
        );
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
            self.rekey(previous);
        }
        self.sync_monitor();
    }

    /// Keys are folded names, so a late `CASEMAPPING` invalidates every one of
    /// them.
    fn rekey(&mut self, previous: CaseMapping) {
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
        let monitored = std::mem::take(&mut self.monitored);
        self.monitored = monitored
            .into_values()
            .map(|nick| (self.fold(&nick), nick))
            .collect();
        let watch_status = std::mem::take(&mut self.watch_status);
        self.watch_status = self
            .watched
            .iter()
            .filter_map(|nick| {
                watch_status
                    .get(&previous.fold(nick))
                    .copied()
                    .map(|online| (self.fold(nick), online))
            })
            .collect();
        // `archived` and `gap_fills` key on the same folded names — `restore`
        // seeds them under the default fold before any 005 exists — but hold
        // no original name to re-fold. The conversations supply it: every
        // watermark belongs to one, and its value carries the name as spelt.
        // Left under the old keys, a restored conversation's watermark was
        // never found again — backfill saw no `since`, asked LATEST, and the
        // gap-versus-first-sight distinction (#223) collapsed to first sight.
        let names: Vec<String> = self
            .channels
            .values()
            .map(|channel| channel.name.clone())
            .chain(self.queries.values().map(|query| query.nick.clone()))
            .collect();
        for name in names {
            let old = previous.fold(&name);
            let new = self.fold(&name);
            if old == new {
                continue;
            }
            if let Some(newest) = self.archived.remove(&old) {
                self.archived.insert(new.clone(), newest);
            }
            if let Some(pages) = self.gap_fills.remove(&old) {
                self.gap_fills.insert(new.clone(), pages);
            }
            if let Some(marker) = self.read_markers.remove(&old) {
                self.read_markers.insert(new.clone(), marker);
            }
            if let Some(unread) = self.unread_at.remove(&old) {
                self.unread_at.insert(new, unread);
            }
        }
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
                    realname: None,
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
        // Read while the borrow is still here, written after it is gone.
        let asked = self.named.remove(&key).then(|| {
            let mut names: Vec<String> = channel
                .members
                .values()
                .map(|member| {
                    let prefix = member.prefixes.first().map(String::as_str).unwrap_or("");
                    format!("{prefix}{}", member.nick)
                })
                .collect();
            names.sort_by_key(|name| name.to_lowercase());
            names
        });
        self.emit_members(&key);
        self.emit_channel(&key);
        if let Some(names) = asked {
            let text = match names.is_empty() {
                true => format!("Nobody is in {name}"),
                false => format!("{} in {name}: {}", names.len(), names.join(", ")),
            };
            self.note(name, MessageKind::Client, text);
        }
    }

    /// One question per join, asked for everybody who was already there.
    ///
    /// `NAMES` arrives with the join and carries the prefixes and nothing else.
    /// Who is away comes from `away-notify`, which speaks only for somebody who
    /// moves while this client is watching, and an account and a real name come
    /// from an `extended-join`, which speaks only for somebody who arrives after
    /// it. Everybody already in the channel was drawn here, signed in to
    /// nothing and called nothing, and stayed that way until they went away
    /// again. A `WHO` is the one question that answers for all of them. #677.
    ///
    /// Sent unconditionally, on every join and so on every rejoin: what a
    /// reconnect into twenty channels costs is twenty lines through the same
    /// pacing every other line goes through, and a roster nobody asked about is
    /// a roster that is wrong for as long as nobody moves.
    fn ask_who(&mut self, channel: &str) {
        let Some(line) = who::request(channel, self.isupport.whox) else {
            return;
        };
        self.pending_who.insert(self.fold(channel));
        self.send_line(line);
    }

    /// Whether a `WHO` reply is an answer to the one sent on joining.
    ///
    /// A reply naming any other channel is the server answering somebody who
    /// typed a `WHO`, and goes to the server tab where a typed one has always
    /// printed.
    fn asked_who(&self, channel: &str) -> bool {
        self.pending_who.contains(&self.fold(channel))
    }

    /// What a `WHO` said about one member, folded into the one already held.
    ///
    /// Never a new member. `NAMES` is the roster and arrives first, so a reply
    /// about somebody outside it has nowhere to go, and the whole run is drawn
    /// once at `315` rather than a member at a time: a channel with a thousand
    /// people in it is a thousand replies, and each of them an event of its own
    /// would be a join that redrew the member list a thousand times.
    fn take_who(&mut self, reply: who::Reply) {
        let key = self.fold(&reply.channel);
        let folded = self.fold(&reply.nick);
        let Some(member) = self
            .channels
            .get_mut(&key)
            .and_then(|channel| channel.members.get_mut(&folded))
        else {
            return;
        };
        match reply.away {
            // A `WHO` says whether somebody is away and never why, so a reason
            // an `AWAY` already gave is kept rather than blanked to an away
            // with nothing on it. `Some("")` is what the member list already
            // draws as away with no reason given.
            Some(true) => {
                member.away.get_or_insert_with(String::new);
            }
            Some(false) => member.away = None,
            None => {}
        }
        // Two different silences: a reply that had no account field states
        // nothing about one, and a plain `WHO` never has one, so an account an
        // `extended-join` gave outlives a server with no `WHOX`.
        if let Some(account) = reply.account {
            member.account = account;
        }
        if let Some(realname) = reply.realname {
            member.realname = Some(realname);
        }
    }

    fn on_end_of_who(&mut self, channel: String) {
        let key = self.fold(&channel);
        self.pending_who.remove(&key);
        self.emit_members(&key);
    }

    /// The topic a channel already had, which arrives on every join.
    fn on_topic_reply(&mut self, params: &[String]) {
        let (Some(name), Some(topic)) = (params.first(), params.get(1)) else {
            return;
        };
        let key = self.fold(name);
        let Some(channel) = self.channels.get_mut(&key) else {
            return;
        };
        channel.topic = Some(Topic {
            text: topic.clone(),
            set_by: None,
            set_at: None,
        });
        self.emit_channel(&key);
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

    /// Whether this numeric belongs to a whois the reader did not type, and so
    /// is to be read rather than drawn.
    ///
    /// Every whois numeric names the person it is about in its first parameter,
    /// which is what identifies the block without listing the numerics a server
    /// might answer with — `671` and `378` and whatever else it has. `318` ends
    /// it. A server that answers a whois without one leaves the nick in the set
    /// and goes on swallowing numerics about that person; nothing else gets in
    /// there, because only a reader opening an inspector puts a name in it.
    fn quiet_whois(&mut self, code: u16, params: &[String]) -> bool {
        let Some(who) = params.first() else {
            return false;
        };
        let folded = self.fold(who);
        if !self.quiet_whois.contains(&folded) {
            return false;
        }
        match code {
            RPL_WHOISUSER => {
                if let Some(realname) = params.get(4).filter(|real| !real.trim().is_empty()) {
                    let realname = realname.clone();
                    self.set_realname(who, realname);
                }
            }
            // Swallowed with the rest of the block, so the panel would go on
            // saying "not identified" about somebody the server has just named.
            RPL_WHOISACCOUNT => {
                if let Some(account) = params.get(1).filter(|account| !account.is_empty()) {
                    let account = account.clone();
                    self.update_member(who, |member| {
                        match member.account.as_deref() == Some(account.as_str()) {
                            true => false,
                            false => {
                                member.account = Some(account.clone());
                                true
                            }
                        }
                    });
                }
            }
            RPL_ENDOFWHOIS => {
                self.quiet_whois.remove(&folded);
            }
            _ => {}
        }
        true
    }

    /// Whether a `WHOWAS` block is open for the nick this numeric names.
    fn inside_a_whowas(&self, params: &[String]) -> bool {
        params
            .first()
            .is_some_and(|nick| self.whowas.contains(&self.fold(nick)))
    }

    /// A `WHOWAS` reply: what the server remembers of somebody who has gone.
    ///
    /// Written apart from `on_whois` rather than beside it because two of these
    /// numerics are the whois ones over again and say the opposite here. The
    /// tense is the whole difference a reader needs: `was`, and where they were
    /// last seen.
    fn on_whowas(&mut self, code: u16, params: &[String], message: &Message) {
        let Some(who) = params.first().cloned() else {
            return;
        };
        let sentence = match code {
            RPL_WHOWASUSER => {
                let user = params.get(1).map(String::as_str).unwrap_or("");
                let host = params.get(2).map(String::as_str).unwrap_or("");
                // The `*` between the host and the real name is a field no
                // server has ever used, which is why the name is fourth.
                let real = params.get(4).map(String::as_str).unwrap_or("");
                match real.trim().is_empty() || real.eq_ignore_ascii_case(&who) {
                    true => format!("{who} was {user}@{host}"),
                    false => format!("{who} was {user}@{host}, calling themselves {real}"),
                }
            }
            RPL_WHOISSERVER => {
                let server = params.get(1).map(String::as_str).unwrap_or("");
                // Libera puts a date a person can read here, ergo sends no
                // `312` at all, and the specification promises neither.
                let when = params.get(2).map(String::as_str).unwrap_or("");
                match when.trim().is_empty() {
                    true => format!("{who} was last seen on {server}"),
                    false => format!("{who} was last seen on {server}, {when}"),
                }
            }
            RPL_WHOISACTUALLY => {
                let host = params.get(1).map(String::as_str).unwrap_or("");
                format!("{who} was connecting from {host}")
            }
            ERR_WASNOSUCHNICK => self.forgotten(&who),
            _ => return,
        };
        self.whowas.insert(self.fold(&who));
        let note = self.chat_message(message, SERVER_TARGET, MessageKind::Server, sentence);
        self.append(note);
    }

    /// `369`. Libera answers a nickname it has never heard of with this and
    /// nothing else — no `406` anywhere — so the end of the block is the only
    /// place that can speak for one nothing came under, and a command that
    /// answers with silence looks like one that failed.
    fn on_end_of_whowas(&mut self, params: &[String], message: &Message) {
        let Some(who) = params.first().cloned() else {
            return;
        };
        if self.whowas.remove(&self.fold(&who)) {
            return;
        }
        let sentence = self.forgotten(&who);
        let note = self.chat_message(message, SERVER_TARGET, MessageKind::Server, sentence);
        self.append(note);
    }

    /// What both ways of saying "never heard of them" come out as. A server
    /// keeps its record for a while and then drops it, so this is about what
    /// the server still holds rather than about who ever existed.
    fn forgotten(&self, who: &str) -> String {
        format!("{} remembers no nickname `{who}`", self.network_name())
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
                if !real.trim().is_empty() {
                    let (who, real) = (who.clone(), real.to_string());
                    self.set_realname(&who, real);
                }
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

    /// Who set that topic and when, which the server sends straight after it.
    ///
    /// The seconds are turned into the same RFC 3339 the live path stores from
    /// the `time` tag. They were kept as the raw epoch before, so one field
    /// held two formats and whichever drew it would have shown a number half
    /// the time.
    fn on_topic_who_time(&mut self, params: &[String]) {
        let Some(name) = params.first() else { return };
        let key = self.fold(name);
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
        channel.modes = modes;
        self.emit_channel(&key);
    }

    /// `367 <me> <channel> <mask> [<who> <set-at>]`, and the same shape under
    /// `348` and `346`, with the leading target already stripped by the numeric
    /// dispatch.
    ///
    /// A row apiece rather than one collected list like `/list`: the reader
    /// asked what is banned in the channel they are in, and the answer belongs
    /// beside the rest of what has happened to it.
    fn on_mode_list(&mut self, list: ModeList, params: &[String], message: &Message) {
        let (Some(channel), Some(mask)) = (params.first(), params.get(1)) else {
            return;
        };
        // Ergo sends the whole `nick!user@host` and Libera a bare nick, which
        // is the difference `333` has and the same answer: a mask inside a
        // sentence is noise.
        let who = params
            .get(2)
            .map(|who| who.split('!').next().unwrap_or(who))
            .filter(|who| !who.trim().is_empty());
        let when = params
            .get(3)
            .and_then(|epoch| rfc3339(epoch))
            .as_deref()
            .and_then(readable);
        let (target, name) = self.mode_list_target(channel);
        let entry = format!("`{mask}` {}", list.entry(&name));
        let sentence = match (who, when) {
            (Some(who), Some(when)) => format!("{entry} — set by {who} on {when}"),
            (Some(who), None) => format!("{entry} — set by {who}"),
            (None, Some(when)) => format!("{entry} — set on {when}"),
            (None, None) => entry,
        };
        self.mode_lists_answered.insert((self.fold(channel), list));
        let note = self.chat_message(message, &target, MessageKind::Server, sentence);
        self.append(note);
    }

    /// `368`, and the two like it. The entries have already said everything
    /// there is to say, so this speaks only for a list nothing came under —
    /// where the server's own line is `#ircx :End of list` and a question
    /// answered with that alone reads as one that failed.
    fn on_end_of_mode_list(&mut self, list: ModeList, params: &[String], message: &Message) {
        let Some(channel) = params.first() else {
            return;
        };
        if self.mode_lists_answered.remove(&(self.fold(channel), list)) {
            return;
        }
        let (target, name) = self.mode_list_target(channel);
        let note = self.chat_message(message, &target, MessageKind::Server, list.empty(&name));
        self.append(note);
    }

    /// Where the answer goes, and what it calls the channel: the conversation
    /// while the reader is in it, under the spelling they joined by rather than
    /// the one the numeric came back with, and the server tab otherwise — a
    /// list can be asked for about a channel nobody has open.
    fn mode_list_target(&self, channel: &str) -> (String, String) {
        match self.channels.get(&self.fold(channel)) {
            Some(held) => (held.name.clone(), held.name.clone()),
            None => (SERVER_TARGET.to_string(), channel.to_string()),
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

    /// A NICK the server would not take, while registering: `what` is the
    /// refusal in words — taken, held, collided — and the answer to each is
    /// the next candidate.
    fn on_nick_refused(&mut self, params: &[String], message: &Message, what: &str) {
        let taken = params.first().cloned().unwrap_or_default();
        let name = self.network_name().to_string();

        if self.registered {
            self.notice(
                Severity::Warning,
                format!("Nickname `{taken}` {what} on {name}"),
                &message.raw,
            );
            return;
        }

        match self.next_nick() {
            Some(next) => {
                self.notice(
                    Severity::Warning,
                    format!("Nickname `{taken}` {what} on {name} — trying `{next}`"),
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
        // A STATUSMSG target is the channel, spoken to a slice of it: `@#chan`
        // reaches the ops of `#chan`. Filed under the channel — classified by
        // first character it read as a nick, so every ops broadcast opened a
        // query on whoever sent it, and `Remember` kept the query across
        // restarts.
        let raw_target = self
            .isupport
            .statusmsg_channel(raw_target)
            .unwrap_or(raw_target);
        let Some(body) = message.param(1) else { return };
        let sender = self.sender_of(message);

        // Before anything this line would make the client do. Dropping it in
        // `append` would still open a query on the person, mark them online
        // and answer their CTCP — an ignore that replies is not one.
        if !sender.is_self && self.is_ignored(&sender.nick) {
            return;
        }

        // Our own echo of a private message names the other side, not us.
        let mut target = match self.isupport.is_channel(raw_target) || sender.is_self {
            true => raw_target.to_string(),
            false => sender.nick.clone(),
        };

        if self.isupport.is_channel(&target) {
            target = self.canonical(&target);
        }

        // Before the delivery and echo handling below, which are about a line
        // being drawn. A DCC handshake is answered rather than drawn, and the
        // one part of it that is drawn draws itself, because the row has to be
        // named by the transfer it announces.
        //
        // Our own handshake comes back on a server with `echo-message` and is
        // dropped here rather than falling through: nothing this client sent
        // needs answering, and the line below would otherwise put a row saying
        // the reader had asked themselves for a CTCP into every conversation a
        // file was ever offered in.
        if let Some((request, args)) = text::ctcp(body) {
            if request.eq_ignore_ascii_case("DCC") && command == "PRIVMSG" {
                if sender.is_self {
                    return;
                }
                self.touch_query(&target, sender.account.clone());
                let target = self.canonical(&target);
                self.mark_online(&target);
                self.handle_dcc(message, &sender, &target, args);
                return;
            }
        }

        let (kind, text) = match text::ctcp(body) {
            Some(("ACTION", action)) => (MessageKind::Action, action.to_string()),
            Some((request, args)) => self.handle_incoming_ctcp(&sender, command, request, args),
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

    /// The transport has written every line up to `mark`. Anything waiting on
    /// one of them is on the socket now, which is as much as a server without
    /// `echo-message` will ever tell us: there, `Sent` is where it stops.
    pub fn on_written(&mut self, mark: u64) -> Vec<Action> {
        if mark <= self.written {
            return Vec::new();
        }
        let echoes = self.caps.is_enabled("echo-message");
        let mut settled = Vec::new();
        self.pending.retain_mut(|pending| {
            if pending.ticket <= self.written || pending.ticket > mark {
                return true;
            }
            pending.message.delivery = Delivery::Sent;
            settled.push(pending.message.clone());
            echoes
        });
        self.written = mark;
        for message in settled {
            self.emit(IrcxEvent::MessageUpdated {
                message: Box::new(message),
            });
        }
        self.drain()
    }

    /// Fails every message whose line never reached the socket. A connection
    /// that ends takes the queue behind it with it, and the alternative to
    /// saying so is a message that sits at `Pending` for the rest of the
    /// session. What was written stays written: an echo that will now never
    /// arrive does not unsend it.
    fn abandon_unwritten(&mut self) {
        let written = self.written;
        let stranded: Vec<PendingSend> = self
            .pending
            .drain(..)
            .filter(|pending| pending.ticket > written)
            .collect();
        // The same words a refused command uses, because it is the same fact.
        // It covers both ways a line is stranded: the connection ended under
        // it, and there was never one to begin with.
        let reason = format!("not connected to {}", self.network_name());
        for mut pending in stranded {
            pending.message.delivery = Delivery::Failed(reason.clone());
            self.emit(IrcxEvent::MessageUpdated {
                message: Box::new(pending.message),
            });
        }
    }

    /// A numeric answering a line this client labelled, where that line is
    /// something the reader said.
    ///
    /// `labeled-response` exists so that a server's answer names the message it
    /// belongs to, and an error wearing a send's label is that send being
    /// refused. What never arrives in that case is the echo — the terminal
    /// state — so without this the optimistic copy sits at `Sent` for the rest
    /// of the session, drawn exactly like a message that was delivered (#592).
    ///
    /// Only where the echo is what settles a send: without `echo-message`,
    /// `on_written` drops the pending copy at the socket, so by the time a
    /// refusal arrives there is nothing left to fail and the row keeps the
    /// state the write gave it.
    fn fail_labelled_send(&mut self, code: u16, message: &Message) -> bool {
        // A send that succeeds is answered by its echo, so a numeric under its
        // label is a refusal. Errors only all the same: the client is claiming
        // a message was not delivered, and it says that on the evidence of a
        // server saying something went wrong rather than on a label alone.
        if !(400..600).contains(&code) {
            return false;
        }
        let Some(label) = message.tag("label") else {
            return false;
        };
        let Some(index) = self
            .pending
            .iter()
            .position(|pending| pending.label.as_deref() == Some(label))
        else {
            return false;
        };

        // The server's own sentence, past the first parameter, which is our
        // nick. `MessageRow` draws it as `Not sent — {reason}` beside the retry
        // it already offers a failed run.
        let reason = message
            .params
            .get(1..)
            .and_then(<[String]>::last)
            .filter(|reason| !reason.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| format!("{} would not take it", self.network_name()));

        let mut refused = self.pending.remove(index).message;
        refused.delivery = Delivery::Failed(reason);
        self.emit(IrcxEvent::MessageUpdated {
            message: Box::new(refused),
        });
        true
    }

    /// Matches a server echo to the optimistic copy already on screen. The id
    /// stays the local one so the frontend can find the message it drew, which
    /// leaves the echo's tags to carry the server's `msgid`. Something has to:
    /// it is what a later history replay of this message is recognised by, and
    /// without it the user's own history comes back doubled.
    pub(crate) fn deliver(
        &mut self,
        echo: &Message,
        label: Option<&str>,
        target: &str,
        text: &str,
    ) -> bool {
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
        if !sender.is_self && self.is_ignored(&sender.nick) {
            return;
        }
        let Some(raw_target) = message.param(0) else {
            return;
        };
        // As in `handle_privmsg`: `@#chan` is the channel, not a query with
        // whoever typed into it.
        let raw_target = self
            .isupport
            .statusmsg_channel(raw_target)
            .unwrap_or(raw_target);
        let target = if self.isupport.is_channel(raw_target) {
            raw_target.to_string()
        } else {
            sender.nick.clone()
        };

        // Not your own, which `echo-message` sends straight back: the indicator
        // exists to say somebody else is about to speak, and a reader told they
        // are typing learns nothing. A second session of the same account types
        // under this nick too, and is the same answer for the same reason.
        //
        // The reaction below keeps its echo. That one is a fact about a message
        // — the chip belongs under it whoever added it — and the local copy
        // `react` emits is the same event arriving twice rather than a claim
        // about somebody's hands.
        if let Some(state) = message
            .tag("+typing")
            .or_else(|| message.tag("typing"))
            .filter(|_| !sender.is_self)
        {
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
                    nick: self.canonical_nick(&sender.nick),
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
        let realname = message
            .param(2)
            .filter(|realname| !realname.trim().is_empty())
            .map(str::to_string);

        if sender.is_self {
            self.user = sender.user.clone().or(self.user.clone());
            self.host = sender.host.clone().or(self.host.clone());
            let channel = self.channel_entry(&key, &name);
            channel.joined = true;
            channel.rejoin = true;
            channel.members.clear();
            self.send_command("MODE", &[&name]);
            self.ask_who(&name);
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
                realname,
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
                self.gap_fills.entry(key).or_default();
            }
            // The most recent page, which is what a conversation seen for the
            // first time has to show. Until it answers, everything behind what
            // the pane holds is what it is bringing, so a reader's own ask for
            // that is declined rather than sent (#486). A gap fill is not
            // tracked here: it reaches forward from the archive's newest, and
            // what a reader pages back for is behind its oldest.
            None => {
                self.gap_fills.remove(&key);
                self.first_pages.insert(key);
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
        // Read before the set moves below, so the line announcing the rename is
        // silenced under the name it was made from.
        let was_ignored = !sender.is_self && self.is_ignored(&sender.nick);
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
            self.unmonitor(&old, &query.nick);
            // Before the nick is overwritten: the conversation is moved by the
            // name it was under, and this is the last place that holds it.
            let was = std::mem::replace(&mut query.nick, new_nick.clone());
            let folded = self.fold(&new_nick);
            self.queries.insert(folded.clone(), query);
            if let Some(newest) = self.archived.remove(&old) {
                self.archived.insert(folded.clone(), newest);
            }
            if let Some(marker) = self.read_markers.remove(&old) {
                self.read_markers.insert(folded.clone(), marker);
            }
            if let Some(unread) = self.unread_at.remove(&old) {
                self.unread_at.insert(folded.clone(), unread);
            }
            self.emit(IrcxEvent::QueryRenamed {
                network: self.config.network.clone(),
                from: was,
                to: new_nick.clone(),
            });
            self.emit_query(&folded);
            self.sync_monitor();
        }

        // An ignore a rename escapes is an ignore that stops working, and it
        // fails in the direction that puts somebody back in front of the reader
        // who asked not to hear from them.
        if was_ignored {
            self.ignore(&sender.nick, false);
            self.ignore(&new_nick, true);
        }

        if sender.is_self {
            self.nick = new_nick;
            self.emit(IrcxEvent::NetworkUpdated {
                network: self.snapshot(),
            });
        }
    }

    /// Somebody else's goes on their roster entry and draws no row: a name
    /// changing is not a thing that happened in the conversation. Your own is
    /// the sentence below, because you typed a command and it is the only
    /// answer you get.
    fn handle_setname(&mut self, message: &Message) {
        let Some(realname) = message.param(0).map(str::to_string) else {
            return;
        };
        let sender = self.sender_of(message);
        if !sender.is_self {
            self.set_realname(&sender.nick, realname);
            return;
        }
        // Both, because they reach different distances: `config` is what
        // registers again on a reconnect inside this run, and the store is what
        // the next launch reads.
        self.config.realname = realname.clone();
        self.actions.push(Action::Realname {
            text: realname.clone(),
        });
        self.note(
            SERVER_TARGET,
            MessageKind::Client,
            format!("Your real name is now {realname}."),
        );
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
        // An invitation is addressed to you by name, which is the thing an
        // ignore is for.
        if self.is_ignored(&sender.nick) {
            return;
        }
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
        // strip_prefix rather than split_at: an empty or non-ASCII reference
        // is the server's to send, and slicing it would panic the task.
        if let Some(reference) = reference.strip_prefix('+') {
            let kind = message.param(1).unwrap_or_default().to_string();
            let target = message.param(2).map(str::to_string);
            let label = message.tag("label").map(str::to_string);
            self.open_batch(reference, kind, target, label, message.clone());
        } else if let Some(reference) = reference.strip_prefix('-') {
            self.close_batch(reference);
        }
    }

    fn handle_markread(&mut self, message: &Message) {
        if !self.caps.is_enabled("draft/read-marker")
            || matches!(message.prefix, Some(Prefix::User { .. }))
        {
            return;
        }
        let (Some(target), Some(parameter)) = (message.param(0), message.param(1)) else {
            return;
        };
        let Some(timestamp) = crate::read_marker::parse(parameter) else {
            return;
        };
        let key = self.fold(target);
        if !self.channels.contains_key(&key) && !self.queries.contains_key(&key) {
            return;
        }
        if self
            .read_markers
            .get(&key)
            .is_some_and(|read| *read >= timestamp)
        {
            return;
        }
        self.read_markers.insert(key.clone(), timestamp);
        self.emit(IrcxEvent::ReadMarkerUpdated {
            network: self.config.network.clone(),
            target: target.to_string(),
            timestamp: parameter
                .strip_prefix("timestamp=")
                .unwrap_or_default()
                .to_string(),
        });

        let reaches_newest = self
            .archived
            .get(&key)
            .and_then(|value| crate::read_marker::timestamp(value))
            .is_some_and(|newest| timestamp >= newest);
        let (removed, highlights) = match self.unread_at.get_mut(&key) {
            Some(unread) => {
                let before = unread.len();
                let highlights = unread
                    .iter()
                    .filter(|item| item.timestamp <= timestamp && item.highlight)
                    .count();
                unread.retain(|item| item.timestamp > timestamp);
                ((before - unread.len()) as u32, highlights as u32)
            }
            None => (0, 0),
        };

        if let Some(channel) = self.channels.get_mut(&key) {
            let previous = (channel.unread, channel.highlights);
            if reaches_newest {
                channel.unread = 0;
                channel.highlights = 0;
            } else {
                channel.unread = channel.unread.saturating_sub(removed);
                channel.highlights = channel.highlights.saturating_sub(highlights);
                if channel.unread == 0 {
                    channel.highlights = 0;
                }
            }
            let changed = previous != (channel.unread, channel.highlights);
            if changed {
                self.emit_channel(&key);
            }
        } else if let Some(query) = self.queries.get_mut(&key) {
            let previous = query.unread;
            query.unread = if reaches_newest {
                0
            } else {
                query.unread.saturating_sub(removed)
            };
            let changed = previous != query.unread;
            if changed {
                self.emit_query(&key);
            }
        }
        if reaches_newest {
            self.unread_at.remove(&key);
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

    fn on_monitor_status(&mut self, params: &[String], online: bool) {
        let Some(targets) = params.last() else {
            return;
        };
        for target in targets.split(',') {
            let nick = target.split_once('!').map_or(target, |(nick, _)| nick);
            let key = self.fold(nick);
            if let Some(query) = self.queries.get_mut(&key) {
                if query.online != online {
                    query.online = online;
                    self.emit_query(&key);
                }
            }
            if self.is_watched(nick) {
                let before = self.watch_status.insert(key, online);
                if before == Some(false) && online {
                    self.notice(
                        Severity::Info,
                        format!("{nick} is online"),
                        &format!("ircx-watch-online:{nick}"),
                    );
                }
            }
        }
    }

    pub(crate) fn sync_monitor(&mut self) {
        let Some(limit) = self.isupport.monitor else {
            self.monitored.clear();
            return;
        };
        if !self.registered {
            return;
        }

        let mut desired: Vec<(String, String)> = self
            .watched
            .iter()
            .map(|nick| (self.fold(nick), nick.clone()))
            .collect();
        desired.sort_by_key(|entry| entry.1.to_lowercase());
        desired.dedup_by(|a, b| a.0 == b.0);

        let mut queries: Vec<(String, String)> = self
            .queries
            .iter()
            .map(|(key, query)| (key.clone(), query.nick.clone()))
            .collect();
        queries.sort_by_key(|entry| entry.1.to_lowercase());
        for query in queries {
            if !desired.iter().any(|(key, _)| key == &query.0) {
                desired.push(query);
            }
        }
        if let Some(limit) = limit {
            desired.truncate(limit as usize);
        }

        let desired_keys: HashSet<String> = desired.iter().map(|(key, _)| key.clone()).collect();
        let removed: Vec<(String, String)> = self
            .monitored
            .iter()
            .filter(|(key, _)| !desired_keys.contains(*key))
            .map(|(key, nick)| (key.clone(), nick.clone()))
            .collect();
        for (key, nick) in removed {
            self.send_command("MONITOR", &["-", &nick]);
            self.monitored.remove(&key);
        }

        for (key, nick) in desired {
            if self.monitored.contains_key(&key) {
                continue;
            }
            if let Some(line) = build("MONITOR", &["+", &nick]) {
                self.send_line(line);
                self.monitored.insert(key, nick);
            }
        }
    }

    pub(crate) fn unmonitor(&mut self, key: &str, nick: &str) {
        if !self.is_watched(nick) && self.monitored.remove(key).is_some() {
            self.send_command("MONITOR", &["-", nick]);
        }
    }

    pub fn set_watched(&mut self, watched: Vec<String>) {
        self.watched = watched;
        let held: HashSet<String> = self.watched.iter().map(|nick| self.fold(nick)).collect();
        self.watch_status.retain(|key, _| held.contains(key));
        self.sync_monitor();
    }

    pub(crate) fn is_watched(&self, nick: &str) -> bool {
        let key = self.fold(nick);
        self.watched.iter().any(|held| self.fold(held) == key)
    }

    pub(crate) fn watch(&mut self, nick: &str, watched: bool) {
        if self.is_watched(nick) == watched {
            return;
        }
        let stored = if watched {
            self.watched.push(nick.to_string());
            nick.to_string()
        } else {
            let key = self.fold(nick);
            let stored = self
                .watched
                .iter()
                .find(|held| self.fold(held) == key)
                .cloned()
                .unwrap_or_else(|| nick.to_string());
            self.watched = self
                .watched
                .iter()
                .filter(|held| self.fold(held) != key)
                .cloned()
                .collect();
            self.watch_status.remove(&key);
            stored
        };
        self.sync_monitor();
        self.actions.push(Action::Watch {
            nick: stored,
            watched,
        });
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
            if self.caps.is_enabled("draft/read-marker") {
                self.send_command("MARKREAD", &[nick]);
            }
            self.sync_monitor();
        }
    }

    fn request_query_markers(&mut self) {
        if !self.caps.is_enabled("draft/read-marker") {
            return;
        }
        let queries: Vec<String> = self
            .queries
            .values()
            .map(|query| query.nick.clone())
            .collect();
        for query in queries {
            self.send_command("MARKREAD", &[&query]);
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
            muted: self.is_muted(key),
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
            muted: self.is_muted(key),
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
                realname: member.realname.clone(),
            })
            .collect()
    }

    pub(crate) fn emit_channel(&mut self, key: &str) {
        // A close drops the channel and parts it, so the server's PART echo
        // lands on one that is already gone. `channel` names a key it cannot
        // find with an empty string, which the sidebar drew as a nameless row.
        if !self.channels.contains_key(key) {
            return;
        }
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
            realname: member.realname.clone(),
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
        // A refusal is an answer. Without this the reader waits for a batch the
        // server has already said it will not send — `FAIL CHATHISTORY` is what
        // an unknown msgid or a selector it cannot resolve comes back as.
        if kind == "FAIL" {
            if let Some(label) = message.tag("label") {
                if self.page_backs.remove(label).is_some() {
                    self.actions.push(Action::PagedBack {
                        label: label.to_string(),
                        more: false,
                    });
                }
            }
        }
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

    /// What a server says about an account this client asked it to make.
    ///
    /// ```text
    /// REGISTER SUCCESS <account> :<description>
    /// REGISTER VERIFICATION_REQUIRED <account> :<description>
    /// VERIFY SUCCESS <account> :<description>
    /// ```
    ///
    /// A refusal arrives as `FAIL REGISTER <code>` and is already answered by
    /// `handle_standard_reply`, which passes on the server's own sentence
    /// because that is the only part written for a user. The same rule holds
    /// here. The one thing added to it is the sentence after a verification,
    /// because what finishes one is a command in this client and the server has
    /// no way to name it.
    fn handle_registration(&mut self, kind: &str, message: &Message) {
        let outcome = message.param(0).unwrap_or_default().to_ascii_uppercase();
        let account = message.param(1).unwrap_or_default().to_string();
        // Below three parameters there is no description, only the outcome.
        let described = (message.params.len() >= 3)
            .then(|| message.params.last())
            .flatten()
            .filter(|text| !text.trim().is_empty())
            .cloned();
        let text = described.unwrap_or_else(|| match outcome.as_str() {
            "SUCCESS" => format!("{account} is registered on {}", self.network_name()),
            // A word this client does not know is still the server talking
            // about the account, and saying so beats saying nothing.
            _ => format!("{} sent {kind} {outcome}", self.network_name()),
        });

        self.notice(Severity::Info, text.clone(), &message.raw);
        self.note(SERVER_TARGET, MessageKind::Client, text);
        if kind == "REGISTER" && outcome == "VERIFICATION_REQUIRED" {
            self.note(
                SERVER_TARGET,
                MessageKind::Client,
                "Run /verify with the code once it arrives.".into(),
            );
        }
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
        self.monitored.clear();
        self.pending_who.clear();
        // A new connection is a new roster, and what the `WHO` on join fills is
        // filled again. What it could not fill is worth one more question.
        self.looked_up.clear();
        self.registered = false;
        self.cap_ended = false;
        self.sts_verified_transport = false;
        self.nick_attempt = 0;
        self.nick = self.config.nick.clone();
        self.user = None;
        self.host = None;
        self.account = None;
        self.batches.clear();
        // A batch abandoned above is a page somebody is still waiting for, and
        // the next connection will answer nothing under the old label. Telling
        // them there is no more to reach is wrong by one page and unsticks the
        // pane; leaving it would stop that conversation ever paging again.
        for (label, _) in self.page_backs.drain() {
            self.actions.push(Action::PagedBack { label, more: false });
        }
        // The batches that would have cleared these are among the ones
        // abandoned above, and the next connection rejoins and asks again. Left
        // standing, a first page nobody will answer would decline every reader's
        // ask in that conversation for the rest of the session.
        self.first_pages.clear();
        self.abandon_unwritten();
        self.away = None;
        self.ping = None;
        self.last_heard = Instant::now();
        self.lag_ms = None;
        // A spent exchange left here would swallow the next connection's
        // `AUTHENTICATE +`: the go-ahead reads as the end of an empty
        // challenge, fails the old exchange's verify, and aborts — a network
        // blip became a network that never authenticates again.
        self.scram = None;
        self.challenge.clear();
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

    /// The casing a person is already known by, for a reaction that may have
    /// arrived under a different one.
    ///
    /// `canonical` above does this for a conversation and this does it for
    /// somebody in one, for the same reason: the chip's nick list, the unique
    /// index the archive keeps and the `you` the label is written with all key
    /// on the string, so a reaction filed under the casing it arrived with
    /// becomes a second chip nobody can clear. Your own is the case that shows
    /// it first — `send_react` emits under `self.nick` and the echo that
    /// follows arrives however the server spells it, which is one person on a
    /// chip counted twice.
    ///
    /// A nick nothing here knows keeps the casing it came with, exactly as a
    /// target nothing is open for does.
    pub(crate) fn canonical_nick(&self, nick: &str) -> String {
        if self.is_me(nick) {
            return self.nick.clone();
        }
        let folded = self.fold(nick);
        self.channels
            .values()
            .find_map(|channel| channel.members.get(&folded))
            .map_or_else(|| nick.to_string(), |member| member.nick.clone())
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

    /// Queues a line and returns the ticket it went out under, which is what
    /// `on_written` later reports back. Most callers have no message riding on
    /// the line and can drop it.
    pub(crate) fn send_line(&mut self, line: String) -> u64 {
        self.emit(IrcxEvent::RawLine {
            network: self.config.network.clone(),
            outgoing: true,
            line: redact(&line),
        });
        let ticket = self.next_ticket;
        self.next_ticket += 1;
        self.actions.push(Action::Send { line, ticket });
        ticket
    }

    pub(crate) fn send_command(&mut self, command: &str, params: &[&str]) {
        match build(command, params) {
            Some(line) => {
                self.send_line(line);
            }
            None => debug!(command, "refused to send a malformed command"),
        }
    }

    /// Handles CTCP other than ACTION. A question is a `PRIVMSG` and an answer
    /// is a `NOTICE`, which is the rule that keeps two clients from trading one
    /// line forever: what this sends can never be read back as a question, and
    /// what arrives on a `NOTICE` is somebody's answer and is only drawn. #572
    fn handle_incoming_ctcp(
        &mut self,
        sender: &Sender,
        command: &str,
        request: &str,
        args: &str,
    ) -> (MessageKind, String) {
        let args = args.trim();
        let asked = !sender.is_self && !command.eq_ignore_ascii_case("NOTICE");

        if request.eq_ignore_ascii_case("VERSION") {
            if args.is_empty() {
                if asked {
                    self.reply_ctcp(&sender.nick, &client::ctcp_version_body());
                }
                return (
                    MessageKind::Server,
                    format!("{} asked for CTCP VERSION", sender.nick),
                );
            }
            return (
                MessageKind::Server,
                format!("{} CTCP VERSION: {args}", sender.nick),
            );
        }

        if request.eq_ignore_ascii_case("PING") {
            if asked {
                self.reply_ctcp(&sender.nick, &text::ctcp_wrap("PING", args));
            }
            let text = if args.is_empty() {
                format!("{} CTCP PING", sender.nick)
            } else {
                format!("{} CTCP PING: {args}", sender.nick)
            };
            return (MessageKind::Server, text);
        }

        (
            MessageKind::Server,
            format!("{} asked for CTCP {request}", sender.nick),
        )
    }

    /// CTCP replies travel on a `NOTICE`, always, so that nothing this client
    /// sends can draw an answer out of the client it is sent to.
    fn reply_ctcp(&mut self, nick: &str, body: &str) {
        match MessageBuilder::new("NOTICE")
            .param(nick)
            .param(body)
            .build()
        {
            Ok(message) => {
                self.send_line(message.to_line());
            }
            Err(error) => {
                debug!(%nick, %body, %error, "refused to send a CTCP reply");
            }
        }
    }

    pub(crate) fn track_pending(
        &mut self,
        ticket: u64,
        label: Option<String>,
        message: ChatMessage,
    ) {
        self.pending.push(PendingSend {
            ticket,
            label,
            message,
        });
        // A server that negotiated `echo-message` and then does not echo would
        // grow this list forever. Only a written line can be abandoned that
        // way: one still waiting for the socket has a state change coming, and
        // dropping it is how a paste longer than the cap would strand its
        // oldest lines at `Pending`.
        if self.pending.len() > 64 {
            let written = self.written;
            if let Some(index) = self
                .pending
                .iter()
                .position(|pending| pending.ticket <= written)
            {
                self.pending.remove(index);
            }
        }
    }

    /// Remembers that a typing notification went out under this label. Keeps a
    /// few: see the field.
    pub(crate) fn sent_typing_as(&mut self, label: String) {
        self.typing_labels.push_back(label);
        while self.typing_labels.len() > 8 {
            self.typing_labels.pop_front();
        }
    }

    /// Whether this label named a typing notification, forgetting it if it did:
    /// one answer is all there is to match.
    fn was_typing_notification(&mut self, label: &str) -> bool {
        let Some(at) = self.typing_labels.iter().position(|sent| sent == label) else {
            return false;
        };
        self.typing_labels.remove(at);
        true
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

/// `728` and `729` name the mode they are about, between the channel and the
/// rest — `##ircx q hush!*@* somebody 1787952261`. Taken out, what is left is
/// the shape `367` and its kind arrive in and everything below can read.
///
/// `None` where the letter is not the one expected: the numeric is solanum's,
/// its documentation is its source, and a server using it for some other list
/// is better left saying what it said than relabelled as a quiet.
fn without_mode_letter(params: &[String], letter: char) -> Option<Vec<String>> {
    let named = params.get(1)?;
    if named.len() != 1 || !named.starts_with(letter) {
        return None;
    }
    let mut rest = params.to_vec();
    rest.remove(1);
    Some(rest)
}

/// One of the lists a channel keeps under a mode: who may not come in, who may
/// come in despite a ban, who needs no invitation, and who may come in without
/// speaking. They arrive in one shape and differ only in what an entry means.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum ModeList {
    Ban,
    Exception,
    Invite,
    Quiet,
}

impl ModeList {
    /// What an entry says about the mask in front of it.
    fn entry(self, channel: &str) -> String {
        match self {
            ModeList::Ban => format!("is banned in {channel}"),
            ModeList::Exception => format!("is exempt from the bans in {channel}"),
            ModeList::Invite => format!("can join {channel} without an invitation"),
            // Not "muted": muting is what the reader does to a conversation of
            // their own, and this is the channel stopping somebody speaking in
            // it. The two would read as the same word for opposite things.
            ModeList::Quiet => format!("cannot speak in {channel}"),
        }
    }

    /// What the end of the list says when nothing came under it. The invite
    /// list keeps its own wording: nobody on it does not mean nobody may join,
    /// only that the channel has granted no standing exemption.
    fn empty(self, channel: &str) -> String {
        match self {
            ModeList::Ban => format!("Nobody is banned in {channel}"),
            ModeList::Exception => format!("Nobody is exempt from the bans in {channel}"),
            ModeList::Invite => format!("Nobody is on the invite list for {channel}"),
            ModeList::Quiet => format!("Nobody is stopped from speaking in {channel}"),
        }
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
    let Some((command, rest)) = line.split_once(' ') else {
        return line.to_string();
    };
    if command.eq_ignore_ascii_case("AUTHENTICATE") {
        return match rest {
            "+" => line.to_string(),
            mechanism
                if mechanism.eq_ignore_ascii_case("PLAIN")
                    || mechanism.eq_ignore_ascii_case("EXTERNAL") =>
            {
                line.to_string()
            }
            _ => format!("{command} <credentials>"),
        };
    }
    if command.eq_ignore_ascii_case("PASS")
        || command.eq_ignore_ascii_case("OPER")
        || command.eq_ignore_ascii_case("REGISTER")
        || command.eq_ignore_ascii_case("VERIFY")
    {
        return format!("{command} <credentials>");
    }
    redact_service_message(line).unwrap_or_else(|| line.to_string())
}

/// `PRIVMSG nickserv :identify hunter2` and its relatives, with the secret
/// taken out and the verb left in, so the log still says what was attempted.
fn redact_service_message(line: &str) -> Option<String> {
    let (command, rest) = line.split_once(' ')?;
    if !command.eq_ignore_ascii_case("PRIVMSG") && !command.eq_ignore_ascii_case("NOTICE") {
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
        assert_eq!(redact("authenticate PLAIN"), "authenticate PLAIN");
        assert_eq!(redact("AuThEnTiCaTe +"), "AuThEnTiCaTe +");
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

    #[test]
    fn takes_out_credentials_regardless_of_command_case() {
        for (line, expected) in [
            ("authenticate aGVsbG8=", "authenticate <credentials>"),
            ("AuThEnTiCaTe aGVsbG8=", "AuThEnTiCaTe <credentials>"),
            ("pass hunter2", "pass <credentials>"),
            ("PaSs hunter2", "PaSs <credentials>"),
            ("oper syk hunter2", "oper <credentials>"),
            ("OpEr syk hunter2", "OpEr <credentials>"),
            (
                "privmsg NickServ :identify hunter2",
                "privmsg NickServ :identify <credentials>",
            ),
            (
                "PrIvMsG NickServ :identify hunter2",
                "PrIvMsG NickServ :identify <credentials>",
            ),
            (
                "notice NickServ :setpass syk key new",
                "notice NickServ :setpass <credentials>",
            ),
            (
                "NoTiCe NickServ :setpass syk key new",
                "NoTiCe NickServ :setpass <credentials>",
            ),
        ] {
            assert_eq!(redact(line), expected);
        }
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
        assert_eq!(
            redact("pRiVmSg #ircx :identify yourself"),
            "pRiVmSg #ircx :identify yourself"
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
