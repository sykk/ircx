//! Scripted server dialogues. Nothing here opens a socket: lines go into
//! `SessionState`, actions come out, and the assertions are on what the UI
//! would have been told.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ircx_core::{Action, Restored, SaslCredentials, SessionConfig, SessionState};
use ircx_ipc::{
    ChatMessage, CommandOutcome, ConnectionStatus, Delivery, IrcxEvent, Member, MessageKind,
    MessageSource, SaslMechanism, SaslStatus, Severity,
};
use ircx_net::TlsInfo;
use ircx_store::OpenTarget;

/// What `cadmium.libera.chat` offered on 2026-07-30, copied off the wire rather
/// than guessed. Notably it does not offer `userhost-in-names`, and six of the
/// entries are ones ircx has no handling for.
///
/// It is one server's list, not the network's: `irc.libera.chat` is a rotation,
/// and `calcium` and `iridium` answered the same day with `labeled-response` and
/// `no-implicit-names` missing. Nothing below asserts on the whole list, because
/// the next connection may not be handed the same one.
const LIBERA_CAPS: &str = "account-notify away-notify batch chghost extended-join multi-prefix \
     sasl=ECDSA-NIST256P-CHALLENGE,EXTERNAL,PLAIN,SCRAM-SHA-512 tls account-tag cap-notify \
     echo-message invite-notify labeled-response message-tags no-implicit-names server-time \
     solanum.chat/identify-msg solanum.chat/oper solanum.chat/realhost";

fn config() -> SessionConfig {
    SessionConfig {
        network: "libera".into(),
        name: "Libera".into(),
        host: "irc.libera.chat".into(),
        port: 6697,
        tls: true,
        tls_verify: true,
        nick: "sykk".into(),
        alt_nicks: Vec::new(),
        username: "sykk".into(),
        realname: "sykk on ircx".into(),
        sasl: None,
        connect_commands: Vec::new(),
        autojoin: Vec::new(),
    }
}

struct Harness {
    state: SessionState,
    sent: Vec<String>,
    events: Vec<IrcxEvent>,
    /// Stands in for the archive's `open_targets` table, which is where these
    /// actions land in the running app.
    open: Vec<OpenTarget>,
    closed: bool,
}

impl Harness {
    fn new(config: SessionConfig) -> Self {
        Self {
            state: SessionState::new(config),
            sent: Vec::new(),
            events: Vec::new(),
            open: Vec::new(),
            closed: false,
        }
    }

    fn apply(&mut self, actions: Vec<Action>) {
        for action in actions {
            match action {
                Action::Send(line) => self.sent.push(line),
                // The raw log mirrors every line; it would drown the assertions.
                Action::Emit(event) => match *event {
                    IrcxEvent::RawLine { .. } => {}
                    event => self.events.push(event),
                },
                Action::Remember(target) => {
                    self.open.retain(|held| held.name() != target.name());
                    self.open.push(target);
                }
                Action::Forget(target) => self.open.retain(|held| held.name() != target),
                // Nothing here drives plugins, so a batch on its way to a
                // rule is not something this harness can act on.
                Action::Notify { .. } => {}
                Action::Close => self.closed = true,
            }
        }
    }

    fn connect(&mut self) {
        let actions = self.state.on_connected(None);
        self.apply(actions);
    }

    fn connect_over_tls(&mut self, info: TlsInfo) {
        let actions = self.state.on_connected(Some(info));
        self.apply(actions);
    }

    fn feed(&mut self, line: &str) {
        let actions = self.state.on_line(line);
        self.apply(actions);
    }

    fn submit(&mut self, target: &str, input: &str) -> CommandOutcome {
        let (outcome, actions) = self.state.submit(target, input, None);
        self.apply(actions);
        outcome
    }

    fn reply(&mut self, target: &str, input: &str, parent: &str) -> CommandOutcome {
        let (outcome, actions) = self.state.submit(target, input, Some(parent));
        self.apply(actions);
        outcome
    }

    fn plugin_stopped(&mut self, text: &str, detail: Option<&str>) {
        let actions = self
            .state
            .plugin_stopped(text.to_owned(), detail.map(str::to_owned));
        self.apply(actions);
    }

    fn react(&mut self, target: &str, message: &str, emoji: &str, active: bool) {
        let actions = self.state.react(target, message, emoji, active);
        self.apply(actions);
    }

    /// The msgid reacted to, who reacted, with what, and whether it was added.
    fn reactions(&self) -> Vec<(&str, &str, &str, bool)> {
        self.events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::ReactionChanged {
                    message,
                    nick,
                    emoji,
                    active,
                    ..
                } => Some((message.as_str(), nick.as_str(), emoji.as_str(), *active)),
                _ => None,
            })
            .collect()
    }

    fn reaction_targets(&self) -> Vec<&str> {
        self.events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::ReactionChanged { target, .. } => Some(target.as_str()),
                _ => None,
            })
            .collect()
    }

    fn sent(&mut self) -> Vec<String> {
        std::mem::take(&mut self.sent)
    }

    fn sent_starting(&self, prefix: &str) -> Vec<String> {
        self.sent
            .iter()
            .filter(|line| line.starts_with(prefix))
            .cloned()
            .collect()
    }

    fn messages(&self) -> Vec<&ChatMessage> {
        self.events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::MessagesAppended { messages, .. } => Some(messages),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn appended(&self) -> Vec<&Vec<ChatMessage>> {
        self.events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::MessagesAppended { messages, .. } => Some(messages),
                _ => None,
            })
            .collect()
    }

    fn notices(&self) -> Vec<(Severity, &str)> {
        self.events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::Notice { severity, text, .. } => Some((*severity, text.as_str())),
                _ => None,
            })
            .collect()
    }

    fn members(&self, channel: &str) -> Vec<Member> {
        self.state.members(channel)
    }

    fn last_members(&self) -> Vec<Member> {
        self.events
            .iter()
            .rev()
            .find_map(|event| match event {
                IrcxEvent::MembersReplaced { members, .. } => Some(members.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }

    fn statuses(&self) -> Vec<&ConnectionStatus> {
        self.events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::ConnectionChanged { status, .. } => Some(status),
                _ => None,
            })
            .collect()
    }

    fn sasl_states(&self) -> Vec<&SaslStatus> {
        self.events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::SaslChanged { status, .. } => Some(status),
                _ => None,
            })
            .collect()
    }
}

/// Registration up to `001`, with the capabilities the caller names ACKed.
fn registered(caps: &str) -> Harness {
    let mut session = Harness::new(config());
    session.connect();
    session.feed(&format!(":irc.libera.chat CAP * LS :{caps}"));
    if !caps.is_empty() {
        session.feed(&format!(":irc.libera.chat CAP * ACK :{caps}"));
    }
    session.feed(":irc.libera.chat 001 sykk :Welcome to the Libera.Chat IRC Network sykk");
    session.feed(
        ":irc.libera.chat 005 sykk CHANTYPES=# PREFIX=(ov)@+ CASEMAPPING=rfc1459 \
         NETWORK=Libera.Chat :are supported by this server",
    );
    session.sent();
    session.events.clear();
    session
}

/// A session that already holds this conversation's record, the way a relaunch
/// does: restored from the archive with a watermark, then registered.
fn registered_holding(name: &str, newest: &str) -> Harness {
    let mut session = Harness::new(config());
    let actions = session.state.restore(vec![Restored {
        target: OpenTarget::Channel(name.into()),
        newest: Some(newest.into()),
    }]);
    session.apply(actions);
    session.connect();
    session.feed(":irc.libera.chat CAP * LS :draft/chathistory");
    session.feed(":irc.libera.chat CAP * ACK :draft/chathistory");
    session.feed(":irc.libera.chat 001 sykk :Welcome to the Libera.Chat IRC Network sykk");
    session.sent();
    session.events.clear();
    session
}

#[test]
fn registration_asks_for_the_intersection_and_authenticates_with_sasl() {
    let mut config = config();
    config.sasl = Some(SaslCredentials {
        mechanism: SaslMechanism::Plain,
        account: "sykk".into(),
        password: Some("hunter2".into()),
    });
    config.autojoin = vec!["#ircx".into()];
    config.connect_commands = vec!["/mode sykk +i".into()];
    let mut session = Harness::new(config);

    session.connect();
    assert_eq!(
        session.sent(),
        vec!["CAP LS 302", "NICK sykk", "USER sykk 0 * :sykk on ircx"]
    );

    session.feed(&format!(":irc.libera.chat CAP * LS :{LIBERA_CAPS}"));
    let requests = session.sent();
    assert_eq!(requests.len(), 1, "one REQ line fits: {requests:?}");
    let requested: Vec<&str> = requests[0]["CAP REQ :".len()..].split(' ').collect();
    assert!(requested.contains(&"sasl"), "{requested:?}");
    assert!(requested.contains(&"multi-prefix"), "{requested:?}");
    assert!(
        !requested.iter().any(|cap| cap.contains('=')),
        "values are stripped from the request: {requested:?}"
    );
    assert!(
        !requested.iter().any(|cap| cap.starts_with("solanum.chat/")),
        "a capability ircx cannot act on is left alone: {requested:?}"
    );

    session.feed(":irc.libera.chat CAP * ACK :sasl multi-prefix server-time echo-message");
    assert_eq!(session.sent(), vec!["AUTHENTICATE PLAIN"]);

    session.feed("AUTHENTICATE +");
    let payload = session.sent();
    assert_eq!(payload.len(), 1);
    assert_eq!(
        STANDARD
            .decode(payload[0].trim_start_matches("AUTHENTICATE "))
            .unwrap(),
        b"\0sykk\0hunter2"
    );

    session.feed(":irc.libera.chat 900 sykk sykk!~sykk@user/sykk sykk :You are now logged in");
    session.feed(":irc.libera.chat 903 sykk :SASL authentication successful");
    assert_eq!(session.sent(), vec!["CAP END"]);
    assert!(matches!(
        session.sasl_states().last(),
        Some(SaslStatus::Authenticated { account }) if account == "sykk"
    ));

    session.feed(":irc.libera.chat 001 sykk :Welcome to the Libera.Chat IRC Network sykk");
    assert_eq!(
        session.sent(),
        vec!["MODE sykk +i", "JOIN #ircx"],
        "connect commands run before the autojoin"
    );
    assert!(session.statuses().contains(&&ConnectionStatus::Connected));
    assert!(!session.closed);
}

#[test]
fn a_server_offering_no_capabilities_still_gives_a_working_client() {
    let mut session = Harness::new(config());
    session.connect();
    session.sent();

    session.feed(":tiny.example CAP * LS :");
    assert_eq!(
        session.sent(),
        vec!["CAP END"],
        "nothing to request, so registration is let through"
    );

    session.feed(":tiny.example 001 sykk :Welcome");
    session.feed(":tiny.example 421 sykk CAP :Unknown command");
    session.sent();

    session.feed(":sable!~s@example JOIN #ircx");
    session.feed(":tiny.example 353 sykk = #ircx :sykk @sable");
    session.feed(":tiny.example 366 sykk #ircx :End of /NAMES list.");
    session.feed(":sable!~s@example PRIVMSG #ircx :no caps here");

    assert_eq!(session.members("#ircx").len(), 2);
    let said = session.messages();
    assert!(said.iter().any(|message| message.text == "no caps here"));

    let outcome = session.submit("#ircx", "hello");
    let sent = session.sent();
    assert_eq!(sent, vec!["PRIVMSG #ircx hello"]);
    match outcome {
        CommandOutcome::Sent(message) => {
            // Without `echo-message` the write is the last thing we hear.
            assert_eq!(message.delivery, Delivery::Sent);
            assert!(message.id_is_local);
            assert!(message.timestamp_is_local);
        }
        other => panic!("expected a sent message, got {other:?}"),
    }
    assert!(!session.closed);
}

/// With `extended-join` every JOIN carries three parameters, which is the only
/// form Libera sends. Nothing here used to script it.
#[test]
fn an_extended_join_reads_the_account_without_it_becoming_the_channel() {
    let mut session = registered("extended-join multi-prefix");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx * :sykk on ircx");
    session.feed(":sable!~s@user/sable JOIN #ircx sable :Sable");
    session.feed(":ash!~a@user/ash JOIN #ircx * :Ash");

    let members = session.members("#ircx");
    assert_eq!(
        members
            .iter()
            .map(|member| (member.nick.as_str(), member.account.as_deref()))
            .collect::<Vec<_>>(),
        vec![("ash", None), ("sable", Some("sable"))],
        "`*` means no account, and the realname is not one either"
    );
    assert!(
        session
            .messages()
            .iter()
            .all(|message| message.target == "#ircx"),
        "the second parameter is an account, not a second channel"
    );
}

#[test]
fn names_arriving_in_pieces_become_one_member_list() {
    let mut session = registered("multi-prefix");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":irc.libera.chat 353 sykk = #ircx :@sable +ash");
    session.feed(":irc.libera.chat 353 sykk = #ircx :bob sykk");
    assert!(
        session.last_members().is_empty(),
        "nothing is published until the list ends"
    );

    session.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");
    let members = session.last_members();
    assert_eq!(members.len(), 4);
    assert_eq!(members[0].nick, "sable");
    assert_eq!(members[0].prefixes, vec!["@"]);
    assert_eq!(members[1].nick, "ash");
    assert_eq!(members[1].prefixes, vec!["+"]);
    assert_eq!(
        members[2..]
            .iter()
            .map(|member| member.nick.as_str())
            .collect::<Vec<_>>(),
        vec!["bob", "sykk"],
        "unprefixed members sort by folded nick"
    );
}

#[test]
fn multi_prefix_keeps_every_rank_and_its_absence_keeps_the_highest() {
    let mut with = registered("multi-prefix");
    with.feed(":irc.libera.chat 005 sykk PREFIX=(qaohv)~&@%+ :are supported by this server");
    with.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    with.feed(":irc.libera.chat 353 sykk = #ircx :~&@sable");
    with.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");
    assert_eq!(with.members("#ircx")[0].prefixes, vec!["~", "&", "@"]);

    let mut without = registered("");
    without.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    without.feed(":irc.libera.chat 353 sykk = #ircx :@sable");
    without.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");
    assert_eq!(without.members("#ircx")[0].prefixes, vec!["@"]);
}

#[test]
fn userhost_in_names_does_not_leak_the_mask_into_the_nick() {
    let mut session = registered("userhost-in-names multi-prefix");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":irc.libera.chat 353 sykk = #ircx :@sable!~sable@user/sable ash!a@b");
    session.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");

    let members = session.members("#ircx");
    assert_eq!(members[0].nick, "sable");
    assert_eq!(members[1].nick, "ash");
}

#[test]
fn rfc1459_folding_finds_a_member_whose_nick_changed_case() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":irc.libera.chat 353 sykk = #ircx :sable[m]");
    session.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");
    session.feed(":irc.libera.chat MODE #ircx +o SABLE{M}");

    let members = session.members("#IRCX");
    assert_eq!(members.len(), 1, "the channel is found case-insensitively");
    assert_eq!(
        members[0].prefixes,
        vec!["@"],
        "`[` folds to `{{` under rfc1459, so this is the same member"
    );
}

#[test]
fn an_ascii_casemapping_keeps_bracketed_nicks_apart() {
    let mut session = Harness::new(config());
    session.connect();
    session.feed(":irc.example CAP * LS :");
    session.feed(":irc.example 001 sykk :Welcome");
    session.feed(":irc.example 005 sykk CASEMAPPING=ascii :are supported by this server");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":irc.example 353 sykk = #ircx :sable[m]");
    session.feed(":irc.example 366 sykk #ircx :End of /NAMES list.");
    session.feed(":irc.example MODE #ircx +o SABLE{M}");

    assert!(
        session.members("#ircx")[0].prefixes.is_empty(),
        "under ascii mapping those are two different nicks"
    );
}

#[test]
fn a_batch_arrives_as_one_append_marked_as_history() {
    let mut session = registered("batch server-time draft/chathistory message-tags");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.events.clear();

    session.feed(":irc.libera.chat BATCH +hist chathistory #ircx");
    session.feed(
        "@batch=hist;time=2026-07-29T10:00:00.000Z;msgid=abc \
         :sable!~s@user/sable PRIVMSG #ircx :first",
    );
    session.feed(
        "@batch=hist;time=2026-07-29T10:00:01.000Z;msgid=def \
         :ash!~a@user/ash PRIVMSG #ircx :second",
    );
    assert!(
        session.messages().is_empty(),
        "a batch is held until it closes"
    );

    session.feed(":irc.libera.chat BATCH -hist");
    let appends = session.appended();
    assert_eq!(appends.len(), 1, "one event for the whole batch");
    assert_eq!(appends[0].len(), 2);

    let first = &appends[0][0];
    assert_eq!(first.source, MessageSource::ServerHistory);
    assert_eq!(first.batch.as_deref(), Some("hist"));
    assert_eq!(first.id, "abc");
    assert!(!first.id_is_local, "the server's msgid is the id");
    assert_eq!(first.timestamp, "2026-07-29T10:00:00.000Z");
    assert!(!first.timestamp_is_local);

    let unread = session.events.iter().rev().find_map(|event| match event {
        IrcxEvent::ChannelUpdated { channel } => Some(channel.unread),
        _ => None,
    });
    assert_eq!(unread, None, "backfill is not unread mail");
}

#[test]
fn echo_message_confirms_delivery_against_the_optimistic_copy() {
    let mut session = registered("echo-message labeled-response message-tags");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.events.clear();
    session.sent();

    let outcome = session.submit("#ircx", "is this on");
    let CommandOutcome::Sent(optimistic) = outcome else {
        panic!("expected a sent message");
    };
    assert_eq!(optimistic.delivery, Delivery::Pending);

    let line = session.sent().remove(0);
    let label = line
        .strip_prefix("@label=")
        .and_then(|rest| rest.split(' ').next())
        .expect("labelled because the server offered labeled-response")
        .to_string();

    session.feed(&format!(
        "@label={label};msgid=srv1 :sykk!~sykk@user/sykk PRIVMSG #ircx :is this on"
    ));

    let updated: Vec<&ChatMessage> = session
        .events
        .iter()
        .filter_map(|event| match event {
            IrcxEvent::MessageUpdated { message } => Some(message.as_ref()),
            _ => None,
        })
        .collect();
    assert_eq!(updated.len(), 1);
    assert_eq!(updated[0].id, optimistic.id, "the id the UI drew is kept");
    assert_eq!(updated[0].delivery, Delivery::Delivered);
    assert!(
        session.messages().is_empty(),
        "the echo is not a second message"
    );
}

#[test]
fn an_echo_without_a_label_is_matched_on_its_text() {
    let mut session = registered("echo-message");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.events.clear();
    session.sent();

    let CommandOutcome::Sent(optimistic) = session.submit("#ircx", "unlabelled") else {
        panic!("expected a sent message");
    };
    assert_eq!(session.sent(), vec!["PRIVMSG #ircx unlabelled"]);

    session.feed(":sykk!~sykk@user/sykk PRIVMSG #ircx :unlabelled");
    let updated = session.events.iter().any(|event| match event {
        IrcxEvent::MessageUpdated { message } => {
            message.id == optimistic.id && message.delivery == Delivery::Delivered
        }
        _ => false,
    });
    assert!(updated);
}

#[test]
fn an_echoed_action_is_matched_against_the_text_the_ctcp_wrapped() {
    let mut session = registered("echo-message");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.events.clear();
    session.sent();

    let CommandOutcome::Sent(optimistic) = session.submit("#ircx", "/me waves") else {
        panic!("expected a sent message");
    };
    assert_eq!(optimistic.kind, MessageKind::Action);

    session.feed(":sykk!~sykk@user/sykk PRIVMSG #ircx :\u{1}ACTION waves\u{1}");
    assert!(
        session.messages().is_empty(),
        "the echo updates the action rather than repeating it"
    );
    assert!(session.events.iter().any(|event| matches!(
        event,
        IrcxEvent::MessageUpdated { message } if message.delivery == Delivery::Delivered
    )));
}

#[test]
fn a_nickname_collision_reads_as_a_sentence_and_falls_back() {
    let mut config = config();
    config.nick = "sable".into();
    config.alt_nicks = vec!["sable-".into()];
    let mut session = Harness::new(config);
    session.connect();
    session.feed(":irc.libera.chat CAP * LS :");
    session.sent();

    session.feed(":irc.libera.chat 433 * sable :Nickname is already in use.");
    assert_eq!(
        session.notices(),
        vec![(
            Severity::Warning,
            "Nickname `sable` is taken on Libera — trying `sable-`"
        )]
    );
    assert_eq!(session.sent(), vec!["NICK sable-"]);

    session.feed(":irc.libera.chat 433 * sable- :Nickname is already in use.");
    assert_eq!(
        session.sent(),
        vec!["NICK sable_"],
        "the configured alternatives run out, so a suffix is added"
    );

    for taken in ["sable_", "sable__", "sable___"] {
        session.feed(&format!(
            ":irc.libera.chat 433 * {taken} :Nickname is already in use."
        ));
    }
    assert!(session.closed, "there is nothing left to try");
    assert!(matches!(
        session.statuses().last(),
        Some(ConnectionStatus::Failed { .. })
    ));
}

#[test]
fn the_raw_line_is_kept_on_the_notice_it_produced() {
    let mut session = registered("");
    let raw = ":irc.libera.chat 474 sykk #ops :Cannot join channel (+b)";
    session.feed(raw);

    let detail = session.events.iter().find_map(|event| match event {
        IrcxEvent::Notice { text, detail, .. } => Some((text.clone(), detail.clone())),
        _ => None,
    });
    assert_eq!(
        detail,
        Some((
            "You are banned from #ops".to_string(),
            Some(raw.to_string())
        ))
    );
}

#[test]
fn a_long_message_is_split_to_fit_the_line_the_server_will_send_on() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.sent();

    let word = "wide ";
    let text = word.repeat(200);
    let outcome = session.submit("#ircx", &text);
    assert!(matches!(outcome, CommandOutcome::Sent(_)));

    let lines = session.sent_starting("PRIVMSG");
    assert!(lines.len() > 1, "a 1000 byte message does not fit one line");
    for line in &lines {
        let on_the_wire = format!(":sykk!~sykk@user/sykk {line}\r\n");
        assert!(
            on_the_wire.len() <= 512,
            "{} bytes once the server adds our mask",
            on_the_wire.len()
        );
    }

    let rejoined: String = lines
        .iter()
        .map(|line| line.trim_start_matches("PRIVMSG #ircx :"))
        .collect::<Vec<_>>()
        .join(" ");
    assert_eq!(rejoined.trim(), text.trim());
}

#[test]
fn an_unknown_command_is_refused_in_words() {
    let mut session = registered("");
    match session.submit("#ircx", "/frobnicate everything") {
        CommandOutcome::Rejected(reason) => {
            assert!(reason.contains("/frobnicate"), "{reason}");
            assert!(reason.contains("/help"), "{reason}");
        }
        other => panic!("expected a rejection, got {other:?}"),
    }
    assert!(session.sent().is_empty());
}

/// `/invite` in a query has no channel to fall back on, and inventing one
/// would invite someone somewhere the user did not name.
#[test]
fn invite_from_a_query_asks_for_the_channel() {
    let mut session = registered("");
    match session.submit("sable", "/invite ash") {
        CommandOutcome::Rejected(reason) => assert!(reason.contains("channel"), "{reason}"),
        other => panic!("expected a rejection, got {other:?}"),
    }
    assert!(session.sent().is_empty());

    session.submit("sable", "/invite ash #ircx");
    assert_eq!(session.sent(), vec!["INVITE ash #ircx"]);
}

/// `/help` is written to be read, so it has to arrive somewhere: the tab it
/// was typed in, one client note per line, whether or not we are registered.
#[test]
fn help_is_printed_into_the_tab_it_was_asked_for() {
    let mut session = registered("");
    let outcome = session.submit("#ircx", "/help");

    assert!(
        matches!(outcome, CommandOutcome::Handled),
        "expected the help to be handled locally, got {outcome:?}"
    );
    assert!(session.sent().is_empty(), "help never reaches the server");

    let appends = session.appended();
    assert_eq!(appends.len(), 1, "one arrival, not one per line");
    let lines: Vec<&str> = appends[0].iter().map(|note| note.text.as_str()).collect();
    assert!(lines.len() > 10, "the whole list arrived: {lines:?}");
    assert!(appends[0]
        .iter()
        .all(|note| note.target == "#ircx" && note.kind == MessageKind::Client));
    assert!(
        lines.iter().any(|line| line.starts_with("/join")),
        "{lines:?}"
    );
    assert!(
        lines.iter().any(|line| line.starts_with("/help")),
        "{lines:?}"
    );

    let mut before_registration = Harness::new(config());
    before_registration.submit("*", "/help");
    assert!(!before_registration.messages().is_empty());
}

#[test]
fn slash_commands_reach_the_wire_as_the_protocol_spells_them() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.sent();

    session.submit("#ircx", "/join ircx-dev");
    session.submit("#ircx", "/topic the topic goes here");
    session.submit("#ircx", "/kick ash being loud");
    session.submit("#ircx", "/invite sable");
    session.submit("#ircx", "/invite sable #ircx-dev");
    session.submit("#ircx", "/me waves");
    session.submit("#ircx", "/msg sable in private");
    session.submit("#ircx", "/nick sykk2");
    session.submit("#ircx", "/away back later");
    session.submit("#ircx", "/whois sable");
    session.submit("#ircx", "/raw PING token");

    assert_eq!(
        session.sent(),
        vec![
            "JOIN #ircx-dev",
            "TOPIC #ircx :the topic goes here",
            "KICK #ircx ash :being loud",
            "INVITE sable #ircx",
            "INVITE sable #ircx-dev",
            "PRIVMSG #ircx :\u{1}ACTION waves\u{1}",
            "PRIVMSG sable :in private",
            "NICK sykk2",
            "AWAY :back later",
            "WHOIS sable",
            "PING token",
        ]
    );
}

#[test]
fn a_private_message_opens_a_query_and_counts_as_unread() {
    let mut session = registered("account-tag");
    session.feed("@account=sable :sable!~s@user/sable PRIVMSG sykk :are you there");

    let query = session.events.iter().find_map(|event| match event {
        IrcxEvent::QueryUpdated { query } => Some(query.clone()),
        _ => None,
    });
    let query = query.expect("a private message opens a query");
    assert_eq!(query.nick, "sable");

    let messages = session.messages();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].target, "sable");
    assert_eq!(messages[0].sender.account.as_deref(), Some("sable"));
    assert_eq!(messages[0].kind, MessageKind::Privmsg);

    let unread = session.events.iter().rev().find_map(|event| match event {
        IrcxEvent::QueryUpdated { query } => Some(query.unread),
        _ => None,
    });
    assert_eq!(unread, Some(1));

    let actions = session.state.mark_read("SABLE");
    session.apply(actions);
    assert_eq!(session.state.queries()[0].unread, 0);
}

#[test]
fn a_ctcp_action_becomes_an_action_and_urls_become_attachments() {
    let mut session = registered("");
    session.feed(
        ":sable!~s@user/sable PRIVMSG #ircx :\u{1}ACTION reads https://example.invalid/a.png\u{1}",
    );

    let messages = session.messages();
    assert_eq!(messages[0].kind, MessageKind::Action);
    assert_eq!(messages[0].text, "reads https://example.invalid/a.png");
    assert_eq!(messages[0].attachments.len(), 1);
    assert!(messages[0].attachments[0].preview.is_none());
}

#[test]
fn sasl_failure_stops_the_connection_rather_than_connecting_as_a_stranger() {
    let mut config = config();
    config.sasl = Some(SaslCredentials {
        mechanism: SaslMechanism::Plain,
        account: "sykk".into(),
        password: Some("wrong".into()),
    });
    let mut session = Harness::new(config);
    session.connect();
    session.feed(":irc.libera.chat CAP * LS :sasl=PLAIN");
    session.feed(":irc.libera.chat CAP * ACK :sasl");
    session.feed("AUTHENTICATE +");
    session.feed(":irc.libera.chat 904 sykk :SASL authentication failed");

    assert!(session.closed, "registration is abandoned");
    assert!(matches!(
        session.sasl_states().last(),
        Some(SaslStatus::Failed { .. })
    ));
    assert!(matches!(
        session.statuses().last(),
        Some(ConnectionStatus::Failed { .. })
    ));
}

/// Walked with a real wrong password on 2026-07-31, which is how the wording
/// was found: Libera answers `904` with "SASL authentication failed", and the
/// sentence built around it read "SASL authentication with Libera.Chat failed —
/// SASL authentication failed".
#[test]
fn a_rejected_login_says_what_to_fix_without_repeating_the_server() {
    let mut config = config();
    config.sasl = Some(SaslCredentials {
        mechanism: SaslMechanism::Plain,
        account: "sykk".into(),
        password: Some("wrong".into()),
    });
    let mut session = Harness::new(config);
    session.connect();
    session.feed(":irc.libera.chat CAP * LS :sasl=PLAIN");
    session.feed(":irc.libera.chat CAP * ACK :sasl");
    session.feed("AUTHENTICATE +");
    session.feed(":irc.libera.chat 904 sykk :SASL authentication failed");

    let Some(SaslStatus::Failed { message }) = session.sasl_states().last() else {
        panic!("expected a failure");
    };

    // The account is as likely to be wrong as the password, and it is on
    // screen nowhere else.
    assert!(message.contains("sykk"), "names the account: {message}");
    assert!(
        message.contains("network's settings"),
        "says where to fix it: {message}"
    );
    assert!(
        !message.contains("SASL authentication with"),
        "does not restate what the server just said: {message}"
    );
    assert_eq!(message.matches("SASL authentication failed").count(), 1);
}

#[test]
fn a_server_without_sasl_degrades_to_a_plain_connection() {
    let mut config = config();
    config.sasl = Some(SaslCredentials {
        mechanism: SaslMechanism::Plain,
        account: "sykk".into(),
        password: Some("hunter2".into()),
    });
    let mut session = Harness::new(config);
    session.connect();
    session.sent();

    session.feed(":tiny.example CAP * LS :multi-prefix");
    session.feed(":tiny.example CAP * ACK :multi-prefix");
    assert_eq!(session.sent(), vec!["CAP REQ :multi-prefix", "CAP END"]);
    assert!(!session.closed, "no SASL is not an authentication failure");

    session.feed(":tiny.example 001 sykk :Welcome");
    let warnings: Vec<&str> = session
        .notices()
        .into_iter()
        .filter(|(severity, _)| *severity == Severity::Warning)
        .map(|(_, text)| text)
        .collect();
    assert!(
        warnings
            .iter()
            .any(|text| text.contains("does not offer SASL")),
        "the user is told, loudly: {warnings:?}"
    );
    assert!(warnings
        .iter()
        .any(|text| text.contains("without authenticating")));
}

#[test]
fn sasl_external_sends_the_empty_payload() {
    let mut config = config();
    config.sasl = Some(SaslCredentials {
        mechanism: SaslMechanism::External,
        account: "sykk".into(),
        password: None,
    });
    let mut session = Harness::new(config);
    session.connect();
    session.feed(":irc.libera.chat CAP * LS :sasl=EXTERNAL");
    session.sent();

    session.feed(":irc.libera.chat CAP * ACK :sasl");
    assert_eq!(session.sent(), vec!["AUTHENTICATE EXTERNAL"]);
    session.feed("AUTHENTICATE +");
    assert_eq!(session.sent(), vec!["AUTHENTICATE +"]);
}

#[test]
fn a_capability_offered_later_is_requested_and_one_withdrawn_is_dropped() {
    let mut session = registered("away-notify");
    session.feed(":irc.libera.chat CAP sykk NEW :chghost invite-notify");
    assert_eq!(
        session.sent(),
        vec!["CAP REQ :chghost invite-notify"],
        "nothing else is re-requested"
    );

    session.feed(":irc.libera.chat CAP sykk ACK :chghost invite-notify");
    session.feed(":irc.libera.chat CAP sykk DEL :away-notify");

    let enabled = session
        .events
        .iter()
        .rev()
        .find_map(|event| match event {
            IrcxEvent::CapsChanged { enabled, .. } => Some(enabled.clone()),
            _ => None,
        })
        .unwrap_or_default();
    assert_eq!(enabled, vec!["chghost", "invite-notify"]);
}

#[test]
fn membership_and_topic_changes_move_the_member_list() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":irc.libera.chat 353 sykk = #ircx :sykk sable ash");
    session.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");
    session.feed(":irc.libera.chat 332 sykk #ircx :the old topic");
    session.events.clear();

    session.feed(":sable!~s@user/sable NICK basil");
    assert_eq!(
        session
            .members("#ircx")
            .iter()
            .map(|member| member.nick.clone())
            .collect::<Vec<_>>(),
        vec!["ash", "basil", "sykk"]
    );

    session.feed(":ash!~a@user/ash PART #ircx :bye");
    session.feed(":basil!~s@user/sable QUIT :Ping timeout");
    assert_eq!(session.members("#ircx").len(), 1);

    session.feed(":sykk!~sykk@user/sykk TOPIC #ircx :a new topic");
    let topic = session.events.iter().rev().find_map(|event| match event {
        IrcxEvent::ChannelUpdated { channel } => channel.topic.clone(),
        _ => None,
    });
    assert_eq!(topic.map(|topic| topic.text), Some("a new topic".into()));

    let kinds: Vec<MessageKind> = session.messages().iter().map(|m| m.kind).collect();
    assert_eq!(
        kinds,
        vec![
            MessageKind::Nick,
            MessageKind::Part,
            MessageKind::Quit,
            MessageKind::Topic
        ]
    );
}

/// #112: the timeline drew a reply quote long before anything could compose
/// one. The tag ircx sends is the one it already reads.
mod replying {
    use super::*;

    fn in_channel(caps: &str) -> Harness {
        let mut session = registered(caps);
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.sent();
        session
    }

    #[test]
    fn a_reply_names_its_parent_on_the_wire() {
        let mut session = in_channel("message-tags");
        let outcome = session.reply("#ircx", "it is in the env", "abc123");

        assert!(matches!(outcome, CommandOutcome::Sent(_)));
        assert_eq!(
            session.sent(),
            vec!["@+reply=abc123 PRIVMSG #ircx :it is in the env"]
        );
    }

    #[test]
    fn the_local_copy_quotes_what_it_answered() {
        let mut session = in_channel("message-tags");
        let CommandOutcome::Sent(copy) = session.reply("#ircx", "it is in the env", "abc123")
        else {
            panic!("expected a sent message");
        };
        assert_eq!(copy.reply_to.as_deref(), Some("abc123"));
    }

    /// An action is a reply like any other; a `/join` typed with a parent
    /// staged says nothing, so there is nothing to attach it to.
    #[test]
    fn an_action_carries_it_and_a_command_that_says_nothing_does_not() {
        let mut session = in_channel("message-tags");
        session.reply("#ircx", "/me nods", "abc123");
        session.reply("#ircx", "/join #elsewhere", "abc123");

        assert_eq!(
            session.sent(),
            vec![
                "@+reply=abc123 PRIVMSG #ircx :\u{1}ACTION nods\u{1}",
                "JOIN #elsewhere",
            ]
        );
    }

    /// `/msg` addresses somebody else, so a parent staged in this conversation
    /// does not follow it there.
    #[test]
    fn a_message_to_another_target_leaves_the_parent_behind() {
        let mut session = in_channel("message-tags");
        session.reply("#ircx", "/msg sable in private", "abc123");

        assert_eq!(session.sent(), vec!["PRIVMSG sable :in private"]);
    }

    /// Every piece answers the same message. Tagging only the first would leave
    /// the rest looking like they answered nothing.
    #[test]
    fn every_piece_of_a_split_names_the_parent() {
        let mut session = in_channel("message-tags");
        session.reply("#ircx", &"wide ".repeat(200), "abc123");

        let lines = session.sent_starting("@+reply=abc123 PRIVMSG");
        assert!(lines.len() > 1, "the text was long enough to split");
        assert_eq!(lines.len(), session.sent_starting("@").len());
    }

    /// A tag the server will not carry names a parent nobody else was shown,
    /// and a quote only this client can see is worse than none.
    #[test]
    fn without_message_tags_the_line_goes_plain() {
        let mut session = in_channel("");
        let CommandOutcome::Sent(copy) = session.reply("#ircx", "it is in the env", "abc123")
        else {
            panic!("expected a sent message");
        };

        assert_eq!(session.sent(), vec!["PRIVMSG #ircx :it is in the env"]);
        assert_eq!(copy.reply_to, None);
    }

    /// The echo replaces tags, raw and time and keeps the rest of the local
    /// copy, so what the quote is drawn from has to survive it.
    #[test]
    fn the_quote_survives_the_echo() {
        let mut session = in_channel("echo-message message-tags");
        let CommandOutcome::Sent(copy) = session.reply("#ircx", "it is in the env", "abc123")
        else {
            panic!("expected a sent message");
        };

        session.feed("@msgid=def456 :sykk!~sykk@user/sykk PRIVMSG #ircx :it is in the env");
        let updated = session.events.iter().find_map(|event| match event {
            IrcxEvent::MessageUpdated { message } if message.id == copy.id => Some(message),
            _ => None,
        });
        assert_eq!(
            updated.and_then(|message| message.reply_to.as_deref()),
            Some("abc123")
        );
    }
}

#[test]
fn a_typing_tag_becomes_a_typing_event() {
    let mut session = registered("message-tags");
    session.feed("@+typing=active :sable!~s@user/sable TAGMSG #ircx");
    session.feed("@+typing=done :sable!~s@user/sable TAGMSG #ircx");

    let typing: Vec<bool> = session
        .events
        .iter()
        .filter_map(|event| match event {
            IrcxEvent::TypingChanged { active, .. } => Some(*active),
            _ => None,
        })
        .collect();
    assert_eq!(typing, vec![true, false]);
}

#[test]
fn a_line_the_parser_cannot_read_is_ignored() {
    let mut session = registered("");
    session.feed("");
    session.feed("@ :nobody");
    session.feed(":only.a.prefix");
    assert!(session.events.is_empty());
    assert!(session.sent().is_empty());
}

/// Libera's token is its own server name rather than an opaque cookie, and it
/// only arrives once the connection has been quiet for a little over two
/// minutes. This is the line a socket idling on `irc.libera.chat` was sent on
/// 2026-07-30.
#[test]
fn a_ping_is_answered_with_the_token_it_carried() {
    let mut session = registered("");
    session.feed("PING :iridium.libera.chat");
    assert_eq!(session.sent(), vec!["PONG iridium.libera.chat"]);
}

/// The channel, text, msgid and time are the ones off the wire on 2026-07-30,
/// down to the label ircx put on the line it sent.
mod probe {
    pub const CHANNEL: &str = "##test";
    pub const NICK: &str = "ircx-t78015";
    pub const MASK: &str = "ircx-t78015!~ircxtest@2607:3c40:2900:b480::4cd";
    pub const TEXT: &str = "ircx client verification run ircxprobe78015 — please ignore";
    pub const MSGID: &str = "11785409510340009285048AAHH6NIyN0ZXN0";
    pub const TIME: &str = "2026-07-30T11:05:10.340Z";
}

/// Registered as the nick the Libera run used, so its lines can be replayed
/// verbatim.
fn probe_session(caps: &str) -> Harness {
    let mut config = config();
    config.nick = probe::NICK.into();
    config.username = "ircxtest".into();
    let mut session = Harness::new(config);
    session.connect();
    session.feed(&format!(":cadmium.libera.chat CAP * LS :{caps}"));
    session.feed(&format!(":cadmium.libera.chat CAP * ACK :{caps}"));
    session.feed(&format!(
        ":cadmium.libera.chat 001 {} :Welcome to the Libera.Chat IRC Network {}",
        probe::NICK,
        probe::NICK
    ));
    session.feed(&format!(
        ":cadmium.libera.chat 005 {} CHANTYPES=# PREFIX=(ov)@+ CASEMAPPING=rfc1459 \
         NETWORK=Libera.Chat :are supported by this server",
        probe::NICK
    ));
    session.feed(&format!(":{} JOIN {}", probe::MASK, probe::CHANNEL));
    session.sent();
    session.events.clear();
    session
}

/// The echo is the only place the server names the message it took from us.
/// Losing that name means a `chathistory` replay cannot be told it is the same
/// message, and the user's own history comes back doubled.
#[test]
fn an_echo_hands_the_confirmed_message_the_servers_msgid_and_time() {
    let mut session = probe_session("echo-message labeled-response message-tags server-time");

    let CommandOutcome::Sent(optimistic) = session.submit(probe::CHANNEL, probe::TEXT) else {
        panic!("expected a sent message");
    };
    assert_eq!(optimistic.delivery, Delivery::Pending);
    assert!(optimistic.timestamp_is_local);

    let sent = session.sent();
    assert_eq!(
        sent,
        vec![format!(
            "@label=ircx-1 PRIVMSG {} :{}",
            probe::CHANNEL,
            probe::TEXT
        )],
        "the line the Libera run put on the wire"
    );

    session.feed(&format!(
        "@msgid={};time={};label=ircx-1 :{} PRIVMSG {} :{}",
        probe::MSGID,
        probe::TIME,
        probe::MASK,
        probe::CHANNEL,
        probe::TEXT
    ));

    let confirmed = session
        .events
        .iter()
        .find_map(|event| match event {
            IrcxEvent::MessageUpdated { message } => Some(message.as_ref()),
            _ => None,
        })
        .expect("the echo confirms the optimistic copy");
    assert_eq!(confirmed.delivery, Delivery::Delivered);
    assert_eq!(
        confirmed.id, optimistic.id,
        "the id the UI drew is still the id"
    );
    assert!(
        confirmed.id_is_local,
        "that id is ours, and says so, even though the server has one too"
    );
    assert_eq!(
        confirmed.tags.iter().find(|(name, _)| name == "msgid"),
        Some(&("msgid".to_string(), Some(probe::MSGID.to_string()))),
        "the server's name for the message is kept beside the local id"
    );
    assert_eq!(confirmed.timestamp, probe::TIME);
    assert!(
        !confirmed.timestamp_is_local,
        "the server saw it 50 ms after we wrote it, and its clock is the shared one"
    );
}

/// The server the second Libera run landed on does not offer
/// `labeled-response`, so the echo carries nothing tying it to the line we sent
/// except its text. Matching on text still has to keep the server's msgid and
/// time. These are the lines above with the label taken out, which is the form
/// that run saw.
#[test]
fn an_echo_matched_on_its_text_still_takes_the_servers_msgid_and_time() {
    let mut session = probe_session("echo-message message-tags server-time");

    let CommandOutcome::Sent(optimistic) = session.submit(probe::CHANNEL, probe::TEXT) else {
        panic!("expected a sent message");
    };
    assert_eq!(
        session.sent(),
        vec![format!("PRIVMSG {} :{}", probe::CHANNEL, probe::TEXT)],
        "nothing labels the line, because the server cannot answer a label"
    );

    session.feed(&format!(
        "@msgid={};time={} :{} PRIVMSG {} :{}",
        probe::MSGID,
        probe::TIME,
        probe::MASK,
        probe::CHANNEL,
        probe::TEXT
    ));

    let confirmed = session
        .events
        .iter()
        .find_map(|event| match event {
            IrcxEvent::MessageUpdated { message } => Some(message.as_ref()),
            _ => None,
        })
        .expect("the echo confirms the optimistic copy on its text alone");
    assert_eq!(confirmed.id, optimistic.id);
    assert_eq!(confirmed.delivery, Delivery::Delivered);
    assert_eq!(
        confirmed.tags.iter().find(|(name, _)| name == "msgid"),
        Some(&("msgid".to_string(), Some(probe::MSGID.to_string())))
    );
    assert_eq!(confirmed.timestamp, probe::TIME);
    assert!(!confirmed.timestamp_is_local);
    assert!(
        session.messages().is_empty(),
        "the echo is not a second message"
    );
}

/// `message-ids` was never a capability. The tag that carries a msgid is part
/// of `message-tags`, which is what Libera actually offers.
#[test]
fn a_msgid_arrives_under_message_tags_with_no_capability_of_its_own() {
    let mut session = Harness::new(config());
    session.connect();
    session.sent();
    session.feed(&format!(":cadmium.libera.chat CAP * LS :{LIBERA_CAPS}"));

    let requested = session.sent().join(" ");
    assert!(
        !requested.contains("message-ids"),
        "no server can offer it, because it is not a capability: {requested}"
    );
    assert!(requested.contains("message-tags"));

    session.feed(":cadmium.libera.chat CAP * ACK :message-tags server-time");
    session.feed(":cadmium.libera.chat 001 sykk :Welcome to the Libera.Chat IRC Network sykk");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.events.clear();
    session.feed(
        "@msgid=abc123;time=2026-07-30T11:05:10.340Z \
         :sable!~s@user/sable PRIVMSG #ircx :hello",
    );

    let messages = session.messages();
    assert_eq!(messages[0].id, "abc123");
    assert!(!messages[0].id_is_local);
}

/// A `PONG` answers the keepalive, and the figure it produced has to outlive
/// the event: anything rebuilding from a snapshot is two minutes behind it.
#[test]
fn the_measured_lag_is_still_there_at_the_next_snapshot() {
    let mut session = registered("");
    assert_eq!(session.state.snapshot().lag_ms, None);

    let actions = session.state.keepalive();
    session.apply(actions);
    let ping = session.sent();
    let token = ping[0]
        .strip_prefix("PING ")
        .expect("the keepalive sends a token")
        .to_string();

    session.feed(&format!(
        ":cadmium.libera.chat PONG cadmium.libera.chat :{token}"
    ));
    let announced = session.events.iter().find_map(|event| match event {
        IrcxEvent::LagChanged { lag_ms, .. } => Some(*lag_ms),
        _ => None,
    });
    assert!(announced.is_some());
    assert_eq!(session.state.snapshot().lag_ms, announced);

    let actions = session
        .state
        .on_disconnected("the server closed the connection");
    session.apply(actions);
    assert_eq!(
        session.state.snapshot().lag_ms,
        None,
        "a new socket has not been measured yet"
    );
}

/// The socket drops without the session being asked to stop, which is what a
/// bare `QUIT` through `/raw` does. Whatever the user was in comes back.
#[test]
fn a_channel_joined_by_hand_is_rejoined_after_a_reconnect() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx-dev");
    session.feed(":sykk!~sykk@user/sykk PART #ircx-dev :bye");
    session.sent();

    let actions = session.state.on_disconnected("the connection ended");
    session.apply(actions);
    session.connect();
    session.feed(":cadmium.libera.chat CAP * LS :");
    session.sent();

    session.feed(":cadmium.libera.chat 001 sykk :Welcome to the Libera.Chat IRC Network sykk");
    assert_eq!(
        session.sent_starting("JOIN"),
        vec!["JOIN #ircx"],
        "what was left is not walked back into, and autojoin was empty"
    );
}

#[test]
fn a_channel_the_user_was_kicked_out_of_is_not_rejoined() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":sable!~s@user/sable KICK #ircx sykk :take a break");

    let actions = session.state.on_disconnected("the connection ended");
    session.apply(actions);
    session.connect();
    session.feed(":cadmium.libera.chat CAP * LS :");
    session.sent();

    session.feed(":cadmium.libera.chat 001 sykk :Welcome");
    assert!(session.sent_starting("JOIN").is_empty());
}

#[test]
fn an_autojoin_channel_is_not_joined_twice_after_a_reconnect() {
    let mut config = config();
    config.autojoin = vec!["#ircx".into()];
    let mut session = Harness::new(config);
    session.connect();
    session.feed(":cadmium.libera.chat CAP * LS :");
    session.feed(":cadmium.libera.chat 001 sykk :Welcome");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");

    let actions = session.state.on_disconnected("the connection ended");
    session.apply(actions);
    session.connect();
    session.feed(":cadmium.libera.chat CAP * LS :");
    session.sent();

    session.feed(":cadmium.libera.chat 001 sykk :Welcome");
    assert_eq!(session.sent_starting("JOIN"), vec!["JOIN #ircx"]);
}

/// The set is written by being somewhere and unwritten by closing the tab,
/// which is what makes it different from the `autojoin` preference.
#[test]
fn a_channel_and_a_query_are_remembered_until_they_are_closed() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":sable!~s@user/sable PRIVMSG sykk :are you there");

    assert_eq!(
        session.open,
        vec![
            OpenTarget::Channel("#ircx".into()),
            OpenTarget::Query("sable".into()),
        ]
    );

    let actions = session.state.close_target("#IRCX");
    session.apply(actions);
    assert_eq!(session.open, vec![OpenTarget::Query("sable".into())]);

    let actions = session.state.close_target("sable");
    session.apply(actions);
    assert!(session.open.is_empty(), "{:?}", session.open);
}

#[test]
fn a_channel_the_user_left_or_was_thrown_out_of_is_not_remembered() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx-dev");
    session.feed(":sykk!~sykk@user/sykk PART #ircx :bye");
    session.feed(":sable!~s@user/sable KICK #ircx-dev sykk :take a break");

    assert!(session.open.is_empty(), "{:?}", session.open);
}

/// The restart case. The user closed nothing, so what was open comes back —
/// out of the archive's own record, not out of `autojoin`.
#[test]
fn the_conversations_from_the_last_run_come_back_and_are_rejoined() {
    let mut session = Harness::new(config());
    let actions = session.state.restore(vec![
        Restored {
            target: OpenTarget::Channel("##test".into()),
            newest: None,
        },
        Restored {
            target: OpenTarget::Query("NickServ".into()),
            newest: None,
        },
    ]);
    session.apply(actions);

    // In the sidebar before the socket is dialled, so there is something to
    // click on while the network is still connecting.
    let channels = session.state.channels();
    assert_eq!(channels.len(), 1);
    assert_eq!(channels[0].name, "##test");
    assert!(!channels[0].joined);
    assert_eq!(session.state.queries().len(), 1);
    assert!(session.events.iter().any(
        |event| matches!(event, IrcxEvent::ChannelUpdated { channel } if channel.name == "##test")
    ));

    session.connect();
    session.feed(":cadmium.libera.chat CAP * LS :");
    session.sent();
    session.feed(":cadmium.libera.chat 001 sykk :Welcome");

    assert_eq!(session.sent_starting("JOIN"), vec!["JOIN ##test"]);
}

/// What the handshake negotiated is the only honest answer to "is this
/// connection safe", and a network can turn verification off.
#[test]
fn what_tls_negotiated_reaches_the_network_tab() {
    let mut session = Harness::new(config());
    session.connect_over_tls(TlsInfo {
        protocol: "TLS 1.3".into(),
        cipher_suite: "TLS13_AES_256_GCM_SHA384".into(),
        peer_cert_subject: Some("CN=cadmium.libera.chat".into()),
    });

    let messages = session.messages();
    let note = messages
        .iter()
        .find(|message| message.kind == MessageKind::Client)
        .expect("the connection says what it got");
    assert_eq!(note.target, "*");
    assert_eq!(
        note.text,
        "Connected to irc.libera.chat over TLS 1.3, TLS13_AES_256_GCM_SHA384, \
         certificate CN=cadmium.libera.chat"
    );

    let mut plain = Harness::new(config());
    plain.connect();
    assert_eq!(
        plain.messages()[0].text,
        "Connected to irc.libera.chat without TLS"
    );
}

/// #90. A hook is dropped for the life of the connection, so the moment it
/// happens is the only moment there is. The notice is gone by the time anyone
/// wonders why their notes stopped; the console note is what they can still
/// find, which is why this is said twice and in two ways.
#[test]
fn a_plugin_that_stopped_says_so_where_the_network_says_everything_else() {
    const TEXT: &str = "The units plugin failed 3 times in a row, so ircx stopped asking it to \
                        annotate messages. Install it again from Plugins once it is fixed.";

    let mut session = registered("");
    session.plugin_stopped(
        TEXT,
        Some("TypeError: cannot read property 'text' of undefined"),
    );

    assert_eq!(
        session.notices(),
        vec![(Severity::Warning, TEXT)],
        "a plugin switched off is a warning, not a failure of the connection"
    );

    let note = session
        .messages()
        .into_iter()
        .rev()
        .find(|message| message.kind == MessageKind::Client)
        .expect("the console keeps what the notice does not");
    assert_eq!(note.target, "*");
    assert_eq!(note.text, TEXT);

    let detail = session
        .events
        .iter()
        .find_map(|event| match event {
            IrcxEvent::Notice { detail, .. } => detail.clone(),
            _ => None,
        })
        .expect("the notice carries what the plugin threw");
    assert!(
        detail.contains("TypeError"),
        "the sentence is for the user and the detail is for whoever wrote the plugin: {detail}"
    );
}

/// `NAMES` can be asked about any channel. The answer is not a reason to put
/// that channel in the user's sidebar, and nothing would ever take it out.
///
/// The two channels answer with different visibility flags because they are
/// different kinds of channel: `##test` is `+Pnst`, so solanum sends `@`, while
/// `#libera` is public and gets `=`. Both are ignored, and both are what came
/// back on 2026-07-30.
#[test]
fn a_names_reply_for_a_channel_we_are_not_in_creates_nothing() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN ##test");
    session.feed(":cadmium.libera.chat 353 sykk @ ##test :sykk @sable");
    session.feed(":cadmium.libera.chat 366 sykk ##test :End of /NAMES list.");
    session.events.clear();

    session.feed(":cadmium.libera.chat 353 sykk = #libera :ash basil @sable");
    session.feed(":cadmium.libera.chat 366 sykk #libera :End of /NAMES list.");
    session.feed(":cadmium.libera.chat 332 sykk #libera :Libera.Chat | libera.chat");
    session.feed(":cadmium.libera.chat 324 sykk #libera +CLPcnrtf");

    assert_eq!(
        session
            .state
            .channels()
            .iter()
            .map(|channel| channel.name.clone())
            .collect::<Vec<_>>(),
        vec!["##test"],
        "asking about a channel is not joining it"
    );
    assert!(
        session.members("#libera").is_empty(),
        "and nothing is held for it"
    );
    assert!(
        session.events.is_empty(),
        "nor is the UI told about it: {:?}",
        session.events
    );
}

#[test]
fn a_reconnect_forgets_the_capabilities_the_old_server_had() {
    let mut session = registered("echo-message multi-prefix");
    assert!(session
        .state
        .snapshot()
        .caps_enabled
        .contains(&"echo-message".to_string()));

    let actions = session
        .state
        .on_disconnected("the server closed the connection");
    session.apply(actions);
    session.connect();

    assert!(session.state.snapshot().caps_enabled.is_empty());
    assert_eq!(session.sent()[0], "CAP LS 302");
}

/// The reaction dialogues below are the example exchanges from the IRCv3
/// `react` client tag specification, taken verbatim down to the channel names,
/// msgids and values. Nothing here was copied off a live server: `+draft/react`
/// is a work-in-progress tag and no Libera run has carried one.
#[test]
fn a_react_tagmsg_is_recorded_against_the_message_it_answered() {
    let mut session = registered("message-tags");
    session.feed("@msgid=123 :nick!user@host PRIVMSG #channel :Hello!");
    session.feed("@msgid=456;+reply=123;+draft/react=lol :nick2!user2@host2 TAGMSG #channel");

    assert_eq!(session.reactions(), vec![("123", "nick2", "lol", true)]);
    assert_eq!(session.reaction_targets(), vec!["#channel"]);
}

#[test]
fn an_unreact_takes_one_reaction_back_and_leaves_the_next_standing() {
    let mut session = registered("message-tags");
    session.feed("@msgid=123 :nick!user@host PRIVMSG #football :They won!");
    session.feed("@msgid=124;+reply=123;+draft/react=🇦🇷 :nick2!user2@host2 TAGMSG #football");
    session.feed("@msgid=125;+reply=123;+draft/unreact=🇦🇷 :nick2!user2@host2 TAGMSG #football");
    session.feed("@msgid=126;+reply=123;+draft/react=🇩🇪 :nick2!user2@host2 TAGMSG #football");

    assert_eq!(
        session.reactions(),
        vec![
            ("123", "nick2", "🇦🇷", true),
            ("123", "nick2", "🇦🇷", false),
            ("123", "nick2", "🇩🇪", true),
        ]
    );
}

/// The specification makes `+reply` mandatory alongside `+draft/react`. A
/// reaction without one names no message, so there is nothing to attach it to.
#[test]
fn a_reaction_naming_no_message_is_dropped() {
    let mut session = registered("message-tags");
    session.feed("@msgid=456;+draft/react=lol :nick2!user2@host2 TAGMSG #channel");
    assert!(session.reactions().is_empty());
}

/// "The `+draft/react` and `+draft/unreact` tags MUST NOT both be attached to a
/// single message." A line that does it cannot be read as either one.
#[test]
fn a_line_carrying_both_react_and_unreact_is_refused() {
    let mut session = registered("message-tags");
    session.feed(
        "@msgid=456;+reply=123;+draft/react=lol;+draft/unreact=lol \
         :nick2!user2@host2 TAGMSG #channel",
    );
    assert!(session.reactions().is_empty());
}

/// The session holds no messages — the archive does — so a reaction travels by
/// the msgid it named whether or not this client ever saw what it answers.
/// Nothing below feeds the `PRIVMSG` with msgid 123.
#[test]
fn a_reaction_to_a_message_this_session_never_saw_is_still_reported() {
    let mut session = registered("message-tags");
    session.feed("@msgid=456;+reply=123;+draft/react=lol :nick2!user2@host2 TAGMSG #channel");
    assert_eq!(session.reactions(), vec![("123", "nick2", "lol", true)]);
}

#[test]
fn a_reaction_sent_to_us_directly_belongs_to_the_senders_query() {
    let mut session = registered("message-tags");
    session.feed("@msgid=456;+reply=123;+draft/react=lol :nick2!user2@host2 TAGMSG sykk");
    assert_eq!(session.reaction_targets(), vec!["nick2"]);
}

#[test]
fn sending_a_reaction_puts_reply_and_react_on_one_tagmsg() {
    let mut session = registered("message-tags");
    session.react("#channel", "123", "lol", true);

    assert_eq!(
        session.sent(),
        vec!["@+reply=123;+draft/react=lol TAGMSG #channel"]
    );
    // Only `echo-message` would bring it back, so the sender's own copy is
    // reported here rather than waited for.
    assert_eq!(session.reactions(), vec![("123", "sykk", "lol", true)]);
}

#[test]
fn taking_a_reaction_back_spells_it_as_unreact() {
    let mut session = registered("message-tags");
    session.react("#channel", "123", "🇦🇷", false);

    assert_eq!(
        session.sent(),
        vec!["@+reply=123;+draft/unreact=🇦🇷 TAGMSG #channel"]
    );
    assert_eq!(session.reactions(), vec![("123", "sykk", "🇦🇷", false)]);
}

/// The tag's value has no restrictions, so it can hold a space — which on the
/// wire is an escape rather than the end of the tag.
#[test]
fn a_reaction_value_holding_a_space_is_escaped_on_the_way_out() {
    let mut session = registered("message-tags");
    session.react("#channel", "123", "hear hear", true);

    assert_eq!(
        session.sent(),
        vec![r"@+reply=123;+draft/react=hear\shear TAGMSG #channel"]
    );
}

/// `irc.libera.chat` is a rotation whose servers do not all advertise the same
/// capabilities, so a session without `message-tags` is one reconnect away.
/// Reactions are unavailable there, not broken.
#[test]
fn a_server_without_message_tags_carries_no_reaction_and_reports_no_failure() {
    let mut session = registered("");
    session.react("#channel", "123", "lol", true);

    assert!(session.sent().is_empty());
    assert!(session.events.is_empty());
}

/// The timeline's chips send through `/react`, which is why the click and the
/// typed line have to reach the same wire.
#[test]
fn the_react_command_sends_what_the_react_call_does() {
    let mut clicked = registered("message-tags");
    clicked.react("#channel", "123", "lol", true);

    let mut typed = registered("message-tags");
    let outcome = typed.submit("#channel", "/react 123 lol");

    assert!(
        matches!(outcome, CommandOutcome::Handled),
        "expected the reaction to be handled, got {outcome:?}"
    );
    assert_eq!(typed.sent(), clicked.sent());
    assert_eq!(typed.reactions(), vec![("123", "sykk", "lol", true)]);
}

#[test]
fn the_unreact_command_takes_the_reaction_back() {
    let mut session = registered("message-tags");
    session.submit("#channel", "/unreact 123 🇦🇷");

    assert_eq!(
        session.sent(),
        vec!["@+reply=123;+draft/unreact=🇦🇷 TAGMSG #channel"]
    );
    assert_eq!(session.reactions(), vec![("123", "sykk", "🇦🇷", false)]);
}

/// The value is the rest of the line: the tag puts no restriction on it, and a
/// reaction is not always one glyph.
#[test]
fn a_reaction_typed_with_spaces_in_it_keeps_them() {
    let mut session = registered("message-tags");
    session.submit("#channel", "/react 123 hear hear");

    assert_eq!(
        session.sent(),
        vec![r"@+reply=123;+draft/react=hear\shear TAGMSG #channel"]
    );
}

#[test]
fn a_react_command_missing_half_its_arguments_says_so() {
    let mut session = registered("message-tags");

    for input in ["/react", "/react 123", "/react 123    "] {
        let outcome = session.submit("#channel", input);
        assert!(
            matches!(&outcome, CommandOutcome::Rejected(reason) if reason.contains("<msgid>")),
            "`{input}` should have been rejected, got {outcome:?}"
        );
    }
    assert!(session.sent().is_empty());
}

/// The chips are not drawn where reactions cannot be sent, so this is the typed
/// route only — and someone who typed it is owed the reason.
#[test]
fn a_react_command_on_a_server_without_message_tags_names_the_reason() {
    let mut session = registered("");
    let outcome = session.submit("#channel", "/react 123 lol");

    assert!(
        matches!(&outcome, CommandOutcome::Rejected(reason) if reason.contains("message-tags")),
        "{outcome:?}"
    );
    assert!(session.sent().is_empty());
    assert!(session.events.is_empty());
}

/// A `TAGMSG` needs a recipient, and the server console has none.
#[test]
fn a_react_command_in_the_server_tab_has_nothing_to_address() {
    let mut session = registered("message-tags");
    let outcome = session.submit("*", "/react 123 lol");

    assert!(
        matches!(outcome, CommandOutcome::Rejected(_)),
        "{outcome:?}"
    );
    assert!(session.sent().is_empty());
}

/// The oldest gap in `docs/manual-verification.md`: neither Libera run met a
/// netsplit, and the churn they did see was one JOIN in 45 seconds.
///
/// A split is a burst of QUITs whose reason is the two servers that lost each
/// other, and the rejoin is a burst of JOINs, sometimes with the NAMES list
/// sent again. Nothing about that is special on the wire, which is the point:
/// this asserts the member list survives the volume and the repetition rather
/// than assuming a hundred of something behaves like one of it.
#[test]
fn a_netsplit_takes_its_half_of_the_channel_and_gives_it_back() {
    const SPLIT: &str = "molybdenum.libera.chat silver.libera.chat";
    let mut session = registered("multi-prefix");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");

    // A hundred and one members: the user, and a hundred who will divide.
    let names: Vec<String> = (0..100).map(|n| format!("nick{n:03}")).collect();
    for chunk in names.chunks(20) {
        session.feed(&format!(
            ":irc.libera.chat 353 sykk = #ircx :{}",
            chunk.join(" ")
        ));
    }
    session.feed(":irc.libera.chat 353 sykk = #ircx :@sykk");
    session.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");
    assert_eq!(session.members("#ircx").len(), 101);

    // The half on the far side of the split goes, all at once.
    let lost = &names[..50];
    for nick in lost {
        session.feed(&format!(":{nick}!~u@host/{nick} QUIT :{SPLIT}"));
    }
    let after = session.members("#ircx");
    assert_eq!(after.len(), 51, "half the channel and the user are left");
    assert!(
        !after.iter().any(|member| lost.contains(&member.nick)),
        "nobody who quit is still listed"
    );

    // They come back, and the server sends the list again on the rejoin.
    for nick in lost {
        session.feed(&format!(":{nick}!~u@host/{nick} JOIN #ircx"));
    }
    for chunk in names.chunks(20) {
        session.feed(&format!(
            ":irc.libera.chat 353 sykk = #ircx :{}",
            chunk.join(" ")
        ));
    }
    session.feed(":irc.libera.chat 353 sykk = #ircx :@sykk");
    session.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");

    let back = session.members("#ircx");
    assert_eq!(back.len(), 101, "everyone is back exactly once");
    let mut nicks: Vec<&str> = back.iter().map(|member| member.nick.as_str()).collect();
    nicks.sort_unstable();
    let before = nicks.len();
    nicks.dedup();
    assert_eq!(nicks.len(), before, "and nobody is listed twice");
    assert!(
        back.iter()
            .any(|m| m.nick == "sykk" && m.prefixes == vec!["@"]),
        "the user keeps the rank the second NAMES gave them"
    );
}

/// A rejoin arriving before the QUIT that explains it — the two servers
/// reconnect and the JOIN overtakes the split on the way. The member list must
/// not end up holding the same person twice.
#[test]
fn a_rejoin_that_overtakes_its_own_quit_does_not_double_a_member() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.feed(":irc.libera.chat 353 sykk = #ircx :sykk ash sable");
    session.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");

    session.feed(":ash!~a@user/ash JOIN #ircx");

    let members = session.members("#ircx");
    assert_eq!(members.iter().filter(|m| m.nick == "ash").count(), 1);
    assert_eq!(members.len(), 3);
}

/// IRCv3 standard replies. `ircclient.md` lists them among the capabilities to
/// support, and until now `FAIL`, `WARN` and `NOTE` fell through to a debug
/// line — a server explaining why something did not work, discarded.
#[test]
fn a_standard_reply_reaches_the_user_with_the_server_s_own_words() {
    let mut session = registered("");
    session.feed(":irc.libera.chat FAIL JOIN CHANNEL_FULL #ircx :Channel is full");

    assert_eq!(
        session.notices(),
        vec![(Severity::Error, "Channel is full")],
        "the description is the part written for a person"
    );
    // And it lands in the console, where server chatter is findable later.
    let lines: Vec<&str> = session.messages().iter().map(|m| m.text.as_str()).collect();
    assert!(lines.contains(&"Channel is full"), "{lines:?}");
}

#[test]
fn the_three_kinds_carry_their_own_weight() {
    let mut session = registered("");
    session.feed(":irc.libera.chat FAIL * ACCOUNT_REQUIRED :You must be registered");
    session.feed(":irc.libera.chat WARN REHASH CERTS_EXPIRED :A certificate has expired");
    session.feed(":irc.libera.chat NOTE * CONNECTION_AGE :You have been here a while");

    assert_eq!(
        session.notices(),
        vec![
            (Severity::Error, "You must be registered"),
            (Severity::Warning, "A certificate has expired"),
            (Severity::Info, "You have been here a while"),
        ]
    );
}

/// The context between the code and the description is variable in length and
/// machine-readable, so the description is found from the end rather than by
/// counting forwards.
#[test]
fn context_between_the_code_and_the_description_does_not_displace_it() {
    let mut session = registered("");
    session.feed(
        ":irc.libera.chat FAIL BOX BOXES_INVALID STACK CLOTHES :Given boxes are not supported",
    );

    assert_eq!(
        session.notices(),
        vec![(Severity::Error, "Given boxes are not supported")]
    );
}

/// A reply with no description is malformed. The code is machine-readable and
/// not a sentence, but passing it on beats saying nothing at all.
#[test]
fn a_reply_with_no_description_still_says_something() {
    let mut session = registered("");
    session.feed(":irc.libera.chat FAIL * NEED_REGISTRATION");
    session.feed(":irc.libera.chat FAIL JOIN BAD_CHANNEL");

    assert_eq!(
        session.notices(),
        vec![
            // `network_name` is what the server advertised in `005`, not the
            // label the user typed when they added the network.
            (Severity::Error, "Libera.Chat sent NEED_REGISTRATION"),
            (Severity::Error, "Libera.Chat sent BAD_CHANNEL about JOIN"),
        ]
    );
}

/// The raw line carries the command, the code and the context, so nothing is
/// lost by showing only the sentence.
#[test]
fn the_code_and_context_stay_available_on_the_notice() {
    let mut session = registered("");
    let raw = ":irc.libera.chat FAIL JOIN CHANNEL_FULL #ircx :Channel is full";
    session.feed(raw);

    let detail = session
        .events
        .iter()
        .find_map(|event| match event {
            IrcxEvent::Notice { detail, .. } => detail.clone(),
            _ => None,
        })
        .expect("the notice carries its raw line");
    assert!(detail.contains("CHANNEL_FULL"), "{detail}");
    assert!(detail.contains("#ircx"), "{detail}");
}

/// Closing a query removed it in core and told nobody, so it stayed on screen
/// until the next launch. Channels always had `ChannelRemoved`; this is its
/// counterpart, and #121 is where the gap was found.
#[test]
fn closing_a_query_says_so_the_way_closing_a_channel_does() {
    let mut session = registered("");
    session.feed(":sable!~s@user/sable PRIVMSG sykk :are you there");
    assert!(!session.state.queries().is_empty(), "the query opened");

    let actions = session.state.close_target("SABLE");
    session.apply(actions);

    let removed: Vec<&str> = session
        .events
        .iter()
        .filter_map(|event| match event {
            IrcxEvent::QueryRemoved { nick, .. } => Some(nick.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(removed, vec!["sable"], "cased as the server spelled it");
    assert!(session.state.queries().is_empty());
    assert!(
        session.open.is_empty(),
        "and it is not reopened next launch"
    );
}

/// A `LIST` is answered with one reply per channel, and a network has tens of
/// thousands. #119 was the client lagging under exactly that, because every
/// reply fell through to `server_words` and became a console message. They are
/// collected now and sent once — #125.
#[test]
fn a_channel_list_arrives_once_rather_than_a_line_at_a_time() {
    let mut session = registered("");
    session.feed(":irc.libera.chat 321 sykk Channel :Users  Name");
    session.feed(":irc.libera.chat 322 sykk #ircx 42 :the topic goes here");
    session.feed(":irc.libera.chat 322 sykk #rust 1337 :systems programming");
    session.feed(":irc.libera.chat 322 sykk #quiet 0 :");

    assert!(
        session.messages().is_empty(),
        "no console line per channel: {:?}",
        session.messages()
    );

    session.feed(":irc.libera.chat 323 sykk :End of /LIST");

    let events: Vec<(String, u32, String)> = session
        .events
        .iter()
        .find_map(|event| match event {
            IrcxEvent::ChannelsListed { channels, .. } => Some(
                channels
                    .iter()
                    .map(|c| (c.name.clone(), c.users, c.topic.clone()))
                    .collect(),
            ),
            _ => None,
        })
        .expect("the list arrives when the server says it ended");

    assert_eq!(
        events,
        vec![
            ("#ircx".to_string(), 42, "the topic goes here".to_string()),
            ("#rust".to_string(), 1337, "systems programming".to_string()),
            ("#quiet".to_string(), 0, String::new()),
        ]
    );
}

/// A second `LIST` replaces the first rather than appending to it.
#[test]
fn a_new_listing_starts_from_nothing() {
    let mut session = registered("");
    session.feed(":irc.libera.chat 321 sykk Channel :Users  Name");
    session.feed(":irc.libera.chat 322 sykk #first 1 :one");
    session.feed(":irc.libera.chat 323 sykk :End of /LIST");
    session.events.clear();

    session.feed(":irc.libera.chat 321 sykk Channel :Users  Name");
    session.feed(":irc.libera.chat 322 sykk #second 2 :two");
    session.feed(":irc.libera.chat 323 sykk :End of /LIST");

    let names: Vec<String> = session
        .events
        .iter()
        .find_map(|event| match event {
            IrcxEvent::ChannelsListed { channels, .. } => {
                Some(channels.iter().map(|c| c.name.clone()).collect())
            }
            _ => None,
        })
        .expect("the second list");
    assert_eq!(names, vec!["#second".to_string()]);
}

/// #153. The topic of a channel you have just joined was tracked on the
/// channel and drawn nowhere: the header leaves it out on purpose and no
/// message carried it, so it was invisible until somebody changed it.
mod topic_on_join {
    use super::*;

    fn joined() -> Harness {
        let mut session = registered("");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.events.clear();
        session
    }

    fn said(session: &Harness) -> Vec<String> {
        session
            .messages()
            .iter()
            .filter(|message| message.kind == MessageKind::Topic)
            .map(|message| message.text.clone())
            .collect()
    }

    #[test]
    fn the_topic_is_said_in_the_channel() {
        let mut session = joined();
        session.feed(":irc.libera.chat 332 sykk #ircx :read the FAQ before asking");

        assert_eq!(
            said(&session),
            ["The topic of #ircx is: read the FAQ before asking"]
        );
    }

    /// The server sends who and when straight after, so it is a second line
    /// rather than a rewrite of the first — which would need the first to be
    /// held back for a reply that not every server sends.
    #[test]
    fn who_set_it_and_when_follows_it() {
        let mut session = joined();
        session.feed(":irc.libera.chat 332 sykk #ircx :read the FAQ");
        session.feed(":irc.libera.chat 333 sykk #ircx sable 1769683200");

        assert_eq!(
            said(&session),
            [
                "The topic of #ircx is: read the FAQ",
                "Set by sable on 2026-01-29 at 10:40 UTC",
            ]
        );
    }

    /// `333` carries whole seconds since the epoch and the live path stores
    /// RFC 3339 from the `time` tag. One field, one format.
    #[test]
    fn the_time_is_stored_as_the_live_path_stores_it() {
        let mut session = joined();
        session.feed(":irc.libera.chat 332 sykk #ircx :read the FAQ");
        session.feed(":irc.libera.chat 333 sykk #ircx sable 1769683200");

        let channel = session
            .events
            .iter()
            .rev()
            .find_map(|event| match event {
                IrcxEvent::ChannelUpdated { channel } => Some(channel.clone()),
                _ => None,
            })
            .expect("the channel is updated");
        let topic = channel.topic.expect("it has a topic");
        assert_eq!(topic.set_by.as_deref(), Some("sable"));
        assert_eq!(topic.set_at.as_deref(), Some("2026-01-29T10:40:00Z"));
    }

    /// Ergo sends the whole `nick!user@host` in `333` where Libera sends a
    /// bare nick, and the live driver read back "Set by
    /// ircx-other!~u@f6u3beryjfghu.irc" before this.
    #[test]
    fn a_mask_is_read_back_as_the_nick_that_set_it() {
        let mut session = joined();
        session.feed(":irc.libera.chat 332 sykk #ircx :read the FAQ");
        session.feed(":irc.libera.chat 333 sykk #ircx sable!~s@user/sable 1769683200");

        assert_eq!(said(&session)[1], "Set by sable on 2026-01-29 at 10:40 UTC");
    }

    #[test]
    fn a_channel_with_no_topic_says_nothing() {
        let mut session = joined();
        session.feed(":irc.libera.chat 331 sykk #ircx :No topic is set");

        assert!(said(&session).is_empty());
    }

    /// A server that sends the time as something other than seconds should
    /// cost the sentence its date, not the whole line.
    #[test]
    fn an_unreadable_time_still_names_who_set_it() {
        let mut session = joined();
        session.feed(":irc.libera.chat 332 sykk #ircx :read the FAQ");
        session.feed(":irc.libera.chat 333 sykk #ircx sable notatimestamp");

        assert_eq!(said(&session)[1], "Set by sable");
    }
}

/// #153. A query with somebody who has quit looked exactly like one with
/// somebody who is there, which is the one thing that changes whether it is
/// worth typing into.
mod query_presence {
    use super::*;

    fn online(session: &Harness, nick: &str) -> Option<bool> {
        session.events.iter().rev().find_map(|event| match event {
            IrcxEvent::QueryUpdated { query } if query.nick == nick => Some(query.online),
            _ => None,
        })
    }

    fn talking() -> Harness {
        let mut session = registered("");
        session.feed(":sable!s@h PRIVMSG sykk :are you there");
        session
    }

    #[test]
    fn a_quit_is_seen() {
        let mut session = talking();
        assert_eq!(online(&session, "sable"), Some(true));

        session.feed(":sable!s@h QUIT :gone");
        assert_eq!(online(&session, "sable"), Some(false));
    }

    /// It latched: `online` was set once when the query was created and
    /// cleared on `QUIT`, so somebody who quit and came back stayed marked
    /// gone for the rest of the session.
    #[test]
    fn hearing_from_them_again_takes_the_quit_back() {
        let mut session = talking();
        session.feed(":sable!s@h QUIT :gone");
        assert_eq!(online(&session, "sable"), Some(false));

        session.feed(":sable!s@h PRIVMSG sykk :back");
        assert_eq!(online(&session, "sable"), Some(true));
    }

    /// Sending to a nick says nothing about whether anyone is there to read
    /// it, so our own echo is not evidence they returned.
    #[test]
    fn our_own_message_is_not_evidence_they_are_back() {
        let mut session = registered("echo-message");
        session.feed(":sable!s@h PRIVMSG sykk :are you there");
        session.feed(":sable!s@h QUIT :gone");
        session.feed(":sykk!~sykk@user/sykk PRIVMSG sable :are you back?");

        assert_eq!(online(&session, "sable"), Some(false));
    }
}

/// #158. The palette offered `/close` and the dispatch table had no arm for it,
/// so typing it got "not a command ircx knows" from a list the client drew.
mod closing {
    use super::*;

    fn in_channel() -> Harness {
        let mut session = registered("");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.sent();
        session
    }

    fn removed(session: &Harness) -> Vec<String> {
        session
            .events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::ChannelRemoved { name, .. } => Some(name.clone()),
                IrcxEvent::QueryRemoved { nick, .. } => Some(nick.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn closing_a_channel_parts_it_and_forgets_it() {
        let mut session = in_channel();
        assert!(matches!(
            session.submit("#ircx", "/close"),
            CommandOutcome::Handled
        ));

        assert_eq!(session.sent(), vec!["PART #ircx"]);
        assert_eq!(removed(&session), ["#ircx"]);
    }

    /// For closing a conversation you are not looking at.
    #[test]
    fn a_named_target_is_closed_instead_of_this_one() {
        let mut session = in_channel();
        session.feed(":sable!s@h PRIVMSG sykk :hello");
        session.events.clear();

        session.submit("#ircx", "/close sable");

        assert_eq!(removed(&session), ["sable"]);
        assert!(
            session.sent().is_empty(),
            "closing a query parts nothing — there is nothing to leave"
        );
    }

    #[test]
    fn closing_something_that_is_not_open_says_so() {
        let mut session = in_channel();
        assert!(matches!(
            session.submit("#ircx", "/close #elsewhere"),
            CommandOutcome::Rejected(_)
        ));
    }

    /// The console is where a network speaks when it has no conversation to
    /// speak in, so closing it would leave that nowhere to go.
    #[test]
    fn the_server_console_cannot_be_closed() {
        let mut session = in_channel();
        assert!(matches!(
            session.submit("*", "/close"),
            CommandOutcome::Rejected(_)
        ));
    }
}

/// A whole SCRAM-SHA-512 exchange, answered the way a server answers it.
///
/// The salt, iteration count and server nonce are the ones in `scram.rs`'s
/// vector; the client's nonce is not, because it is generated, so the reply is
/// built around whatever the client actually sent. What this covers that the
/// unit tests cannot is the four messages arriving as four lines, in order,
/// with the session holding the exchange between them.
mod scram_over_a_session {
    use super::*;

    const SALT: &str = "W22ZaJ0SNY7soEsUEjb6gQ==";
    const SERVER_PART: &str = "%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";

    fn authenticating() -> Harness {
        authenticating_with(SaslMechanism::ScramSha512, "SCRAM-SHA-512")
    }

    fn authenticating_with(mechanism: SaslMechanism, token: &str) -> Harness {
        let mut config = config();
        config.sasl = Some(SaslCredentials {
            mechanism,
            account: "user".into(),
            password: Some("pencil".into()),
        });
        let mut session = Harness::new(config);
        session.connect();
        // The server advertises the mechanism being negotiated. A server that
        // does not is a different case, and the client is right to refuse it —
        // `ergo` offers SHA-256 and not SHA-512, which is how that was found.
        session.feed(&format!(
            ":irc.libera.chat CAP * LS :sasl=PLAIN,EXTERNAL,{token} message-tags"
        ));
        session.feed(":irc.libera.chat CAP * ACK :sasl");
        // `sent` drains, so registration is cleared here and every assertion
        // below is about the exchange rather than about what came before it.
        let sent = session.sent();
        assert_eq!(
            sent.last().map(String::as_str),
            Some(format!("AUTHENTICATE {token}").as_str()),
            "the mechanism is named before anything is sent: {sent:?}"
        );
        session
    }

    /// What the client sent, decoded, with the `AUTHENTICATE ` stripped.
    fn payload(line: &str) -> String {
        let argument = line.trim_start_matches("AUTHENTICATE ");
        String::from_utf8(STANDARD.decode(argument).expect("base64")).expect("text")
    }

    fn nonce_from(client_first: &str) -> String {
        payload(client_first)
            .rsplit_once("r=")
            .expect("a nonce")
            .1
            .to_owned()
    }

    #[test]
    fn the_exchange_runs_to_a_verified_signature() {
        let mut session = authenticating();
        session.feed("AUTHENTICATE +");
        let first = session.sent();
        assert_eq!(first.len(), 1);
        let client_first = payload(&first[0]);
        assert!(
            client_first.starts_with("n,,n=user,r="),
            "no channel binding, and the account named: {client_first}"
        );

        let nonce = nonce_from(&first[0]);
        let combined = format!("{nonce}{SERVER_PART}");
        let server_first = format!("r={combined},s={SALT},i=4096");
        session.feed(&format!("AUTHENTICATE {}", STANDARD.encode(&server_first)));

        let second = session.sent();
        assert_eq!(second.len(), 1);
        let client_final = payload(&second[0]);
        assert!(
            client_final.starts_with(&format!("c=biws,r={combined},p=")),
            "the proof carries the gs2 header and the joined nonce: {client_final}"
        );

        // The server's own half of the proof, computed the way a server does.
        let auth = format!("n=user,r={nonce},{server_first},c=biws,r={combined}",);
        let signature = server_signature("pencil", SALT, 4096, &auth);
        session.feed(&format!(
            "AUTHENTICATE {}",
            STANDARD.encode(format!("v={signature}"))
        ));

        assert_eq!(
            session.sent(),
            vec!["AUTHENTICATE +"],
            "an empty response is what says the client is satisfied"
        );

        session.feed(":irc.libera.chat 900 sykk user!~u@host user :You are now logged in");
        session.feed(":irc.libera.chat 903 sykk :SASL authentication successful");
        assert!(
            matches!(
                session.sasl_states().last(),
                Some(SaslStatus::Authenticated { account }) if account == "user"
            ),
            "{:?}",
            session.sasl_states().last()
        );
    }

    /// A mechanism the server never offered is not an authentication failure:
    /// the client says so and carries on unauthenticated, per the degradation
    /// rule. Pinned because it is quiet — `ergo` advertises SHA-256, a user
    /// picking SHA-512 connects fine, and nothing about the connection says
    /// they are not logged in unless this line is read.
    #[test]
    fn a_mechanism_the_server_does_not_offer_says_so_and_connects_anyway() {
        let mut config = config();
        config.sasl = Some(SaslCredentials {
            mechanism: SaslMechanism::ScramSha512,
            account: "user".into(),
            password: Some("pencil".into()),
        });
        let mut session = Harness::new(config);
        session.connect();
        session.feed(":irc.libera.chat CAP * LS :sasl=PLAIN,EXTERNAL,SCRAM-SHA-256");
        session.feed(":irc.libera.chat CAP * ACK :sasl");

        let said: Vec<String> = session
            .messages()
            .iter()
            .map(|message| message.text.clone())
            .filter(|text| text.contains("SASL"))
            .collect();
        assert_eq!(said, ["Libera does not accept SASL SCRAM-SHA-512"]);
        assert!(
            session.sent().contains(&"CAP END".to_string()),
            "registration carries on rather than stopping"
        );
    }

    /// Which hash is negotiated is the one thing this wiring can get wrong, and
    /// getting it wrong would send a proof the server cannot check. `ergo`
    /// offers SHA-256 and Libera advertises SHA-512, so both are real.
    #[test]
    fn sha_256_names_itself_and_runs_the_same_exchange() {
        let mut session = authenticating_with(SaslMechanism::ScramSha256, "SCRAM-SHA-256");
        session.feed("AUTHENTICATE +");
        let first = session.sent();
        let nonce = nonce_from(&first[0]);
        let combined = format!("{nonce}{SERVER_PART}");
        let server_first = format!("r={combined},s={SALT},i=4096");
        session.feed(&format!("AUTHENTICATE {}", STANDARD.encode(&server_first)));

        let client_final = payload(&session.sent()[0]);
        assert!(
            client_final.starts_with(&format!("c=biws,r={combined},p=")),
            "got {client_final}"
        );
    }

    /// The check that makes it mutual. A server that cannot prove it knew the
    /// password must not end up with the client reporting a successful login.
    #[test]
    fn a_server_that_cannot_prove_it_knew_the_password_stops_the_connection() {
        let mut session = authenticating();
        session.feed("AUTHENTICATE +");
        let nonce = nonce_from(&session.sent()[0]);
        let server_first = format!("r={nonce}{SERVER_PART},s={SALT},i=4096");
        session.feed(&format!("AUTHENTICATE {}", STANDARD.encode(&server_first)));
        session.sent();

        let forged = STANDARD.encode([0u8; 64]);
        session.feed(&format!(
            "AUTHENTICATE {}",
            STANDARD.encode(format!("v={forged}"))
        ));

        assert_eq!(
            session.sent(),
            vec!["AUTHENTICATE *"],
            "the exchange is abandoned rather than left open"
        );
        let failed = matches!(
            session.sasl_states().last(),
            Some(SaslStatus::Failed { .. })
        );
        assert!(failed, "{:?}", session.sasl_states().last());
    }

    /// A server nonce that does not extend the client's is another exchange
    /// being replayed, and it is caught before any proof is sent.
    #[test]
    fn a_replayed_challenge_sends_no_proof() {
        let mut session = authenticating();
        session.feed("AUTHENTICATE +");
        session.sent();

        let replayed = format!("r=somebodyElsesNonce{SERVER_PART},s={SALT},i=4096");
        session.feed(&format!("AUTHENTICATE {}", STANDARD.encode(&replayed)));

        assert_eq!(session.sent(), vec!["AUTHENTICATE *"]);
    }

    /// What a server computes to prove it knew the password.
    fn server_signature(password: &str, salt: &str, rounds: u32, auth: &str) -> String {
        use ring::{hmac, pbkdf2};
        let salt = STANDARD.decode(salt).expect("base64 salt");
        let mut salted = [0u8; 64];
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA512,
            std::num::NonZeroU32::new(rounds).expect("a positive count"),
            &salt,
            password.as_bytes(),
            &mut salted,
        );
        let server_key = hmac::sign(&hmac::Key::new(hmac::HMAC_SHA512, &salted), b"Server Key");
        let signature = hmac::sign(
            &hmac::Key::new(hmac::HMAC_SHA512, server_key.as_ref()),
            auth.as_bytes(),
        );
        STANDARD.encode(signature.as_ref())
    }
}

/// #190. Messaging NickServ opened the query and showed nothing in it: the
/// replies were filed under the casing the server used, and the query under the
/// casing the user typed, so one conversation was two.
mod one_conversation_one_name {
    use super::*;

    fn talking() -> Harness {
        let mut session = Harness::new(config());
        session.connect();
        session.feed(":irc.libera.chat CAP * LS :");
        session.feed(":irc.libera.chat 001 sykk :Welcome");
        session.feed(
            ":irc.libera.chat 005 sykk CHANTYPES=# PREFIX=(ov)@+ CASEMAPPING=rfc1459 \
             :are supported by this server",
        );
        session.sent();
        session
    }

    /// Every target an appended message named, for the conversation asked
    /// about.
    fn named(session: &Harness, like: &str) -> Vec<String> {
        session
            .messages()
            .iter()
            .map(|message| message.target.clone())
            .filter(|target| target.eq_ignore_ascii_case(like))
            .collect()
    }

    /// What the local copy of an outgoing message was filed under.
    fn filed_under(outcome: &CommandOutcome) -> String {
        match outcome {
            CommandOutcome::Sent(message) => message.target.clone(),
            other => panic!("expected a sent message, got {other:?}"),
        }
    }

    /// The report: a query opened as `nickserv`, answered as `NickServ`, and
    /// the reply landing where nobody was looking.
    #[test]
    fn a_reply_in_another_casing_lands_in_the_conversation_that_is_open() {
        let mut session = talking();
        let (_, actions) = session.state.open_query("nickserv");
        session.apply(actions);
        session.feed(":NickServ!NickServ@services. NOTICE sykk :NickServ lets you register");

        assert_eq!(
            named(&session, "nickserv"),
            ["nickserv"],
            "the conversation keeps the name it was opened under"
        );
    }

    /// The other order, which is how a query usually starts: the server names
    /// it first, and what the user types afterwards has to go to the same
    /// place.
    #[test]
    fn a_message_typed_in_another_casing_joins_the_conversation_already_open() {
        let mut session = talking();
        session.feed(":NickServ!NickServ@services. NOTICE sykk :you are now identified");

        let outcome = session.submit("NICKSERV", "STATUS");
        assert_eq!(filed_under(&outcome), "NickServ");
    }

    /// The line on the wire keeps what was typed. The server does its own
    /// folding, and a target it does not know is its answer to give.
    #[test]
    fn the_wire_keeps_what_the_user_typed() {
        let mut session = talking();
        session.feed(":NickServ!NickServ@services. NOTICE sykk :hello");
        session.sent();
        session.submit("NICKSERV", "STATUS");

        assert_eq!(session.sent(), vec!["PRIVMSG NICKSERV STATUS"]);
    }

    /// A channel is a target too, and a server answering `#TEST` to a `#test`
    /// join would split it the same way.
    #[test]
    fn a_channel_answered_in_another_casing_is_the_same_channel() {
        let mut session = talking();
        session.feed(":sykk!s@h JOIN #test");
        session.feed(":phrack!p@h PRIVMSG #TEST :hello");

        assert_eq!(named(&session, "#test"), ["#test", "#test"]);
    }
}

/// #219. `draft/chathistory` was negotiated on every connection and never used,
/// so the gap between the last message this machine saw and now stayed missing.
///
/// The action carries the target and how much to ask for. Where the archive
/// left off is the rest of the request, and it is filled in by the connection
/// task, which is what can read the archive.
mod backfill_on_join {
    use super::*;

    fn joined(caps: &str, isupport: &str) -> Harness {
        let mut session = registered(caps);
        if !isupport.is_empty() {
            session.feed(&format!(
                ":irc.libera.chat 005 sykk {isupport} :are supported by this server"
            ));
        }
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session
    }

    fn asked(session: &Harness) -> Vec<String> {
        session.sent_starting("CHATHISTORY")
    }

    #[test]
    fn joining_asks_for_what_was_said_while_nobody_was_here() {
        let session = joined("draft/chathistory", "");

        assert_eq!(asked(&session), ["CHATHISTORY LATEST #ircx * 200"]);
    }

    #[test]
    fn a_server_without_the_capability_is_asked_for_nothing() {
        let session = joined("", "CHATHISTORY=1000");

        assert!(asked(&session).is_empty());
    }

    /// Asking for more than the server said it would answer with is a request
    /// it is entitled to refuse outright.
    #[test]
    fn the_limit_the_server_stated_is_not_exceeded() {
        let session = joined("draft/chathistory", "CHATHISTORY=50");

        assert_eq!(asked(&session), ["CHATHISTORY LATEST #ircx * 50"]);
    }

    #[test]
    fn a_generous_server_does_not_widen_the_page() {
        let session = joined("draft/chathistory", "CHATHISTORY=1000");

        assert_eq!(asked(&session), ["CHATHISTORY LATEST #ircx * 200"]);
    }

    /// The draft spelling is what ergo sends while the capability is a draft,
    /// and it is the same statement.
    #[test]
    fn the_draft_spelling_of_the_token_is_read_too() {
        let session = joined("draft/chathistory", "draft/CHATHISTORY=25");

        assert_eq!(asked(&session), ["CHATHISTORY LATEST #ircx * 25"]);
    }

    #[test]
    fn somebody_else_joining_asks_for_nothing() {
        let mut session = joined("draft/chathistory", "");
        session.sent();
        session.feed(":phrack!p@h JOIN #ircx");

        assert!(asked(&session).is_empty());
    }

    /// A conversation this client already holds is asked for the gap rather
    /// than for a page it mostly has.
    #[test]
    fn an_archive_is_asked_for_what_came_after_it() {
        let mut session = registered_holding("#ircx", "2026-07-31T09:15:04.123456789Z");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");

        assert_eq!(
            asked(&session),
            ["CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:15:04.123Z 200"]
        );
    }

    /// A rejoin inside one session has a gap too: the client heard the channel
    /// before it left, so what it says while away was missed.
    #[test]
    fn a_rejoin_asks_for_the_gap_rather_than_the_latest_page() {
        let mut session = joined("draft/chathistory", "");
        session.feed("@time=2026-07-31T09:15:04.000Z :phrack!p@h PRIVMSG #ircx :hello");
        session.feed(":sykk!~sykk@user/sykk PART #ircx");
        session.sent();
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");

        assert_eq!(
            asked(&session),
            ["CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:15:04.000Z 200"]
        );
    }
}

/// #223. What a backfill fills decides whether it counts: a gap is what the
/// reader was not here for, and a first page is a conversation they have only
/// just met.
mod what_a_backfill_counts {
    use super::*;

    fn unread(session: &Harness, name: &str) -> u32 {
        session
            .state
            .channels()
            .iter()
            .find(|channel| channel.name == name)
            .map_or(0, |channel| channel.unread)
    }

    fn replay(session: &mut Harness, lines: &[&str]) {
        session.feed(":ergo.test BATCH +1 chathistory #ircx");
        for line in lines {
            session.feed(line);
        }
        session.feed(":ergo.test BATCH -1");
    }

    #[test]
    fn a_first_page_counts_towards_nothing() {
        let mut session = registered("draft/chathistory");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        replay(
            &mut session,
            &["@batch=1;time=2026-07-31T09:00:00.000Z :phrack!p@h PRIVMSG #ircx :morning"],
        );

        assert_eq!(unread(&session, "#ircx"), 0);
    }

    #[test]
    fn a_gap_counts_as_the_unread_it_is() {
        let mut session = registered_holding("#ircx", "2026-07-31T08:00:00.000Z");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        replay(
            &mut session,
            &[
                "@batch=1;time=2026-07-31T09:00:00.000Z :phrack!p@h PRIVMSG #ircx :morning",
                "@batch=1;time=2026-07-31T09:01:00.000Z :phrack!p@h PRIVMSG #ircx :and again",
            ],
        );

        assert_eq!(unread(&session, "#ircx"), 2);
    }

    /// Ergo narrates the reader's own comings and goings as messages from a
    /// service, and a badge counting those says more than was said. #221.
    #[test]
    fn a_service_outside_the_channel_adds_nothing_to_read() {
        let mut session = registered_holding("#ircx", "2026-07-31T08:00:00.000Z");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.feed(":irc.libera.chat 353 sykk = #ircx :sykk phrack");
        session.feed(":irc.libera.chat 366 sykk #ircx :End of NAMES list");
        replay(
            &mut session,
            &[
                "@batch=1;time=2026-07-31T09:00:00.000Z :phrack!p@h PRIVMSG #ircx :morning",
                "@batch=1;time=2026-07-31T09:01:00.000Z :HistServ!HistServ@localhost \
                 PRIVMSG #ircx :sykk joined the channel",
            ],
        );

        assert_eq!(unread(&session, "#ircx"), 1);
    }

    /// The gap is closed by the answer to it. A second batch that nobody asked
    /// for — a netjoin replay, say — is not the reader's backlog.
    #[test]
    fn the_gap_is_only_filled_once() {
        let mut session = registered_holding("#ircx", "2026-07-31T08:00:00.000Z");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        replay(
            &mut session,
            &["@batch=1;time=2026-07-31T09:00:00.000Z :phrack!p@h PRIVMSG #ircx :morning"],
        );
        replay(
            &mut session,
            &["@batch=1;time=2026-07-31T09:02:00.000Z :phrack!p@h PRIVMSG #ircx :again"],
        );

        assert_eq!(unread(&session, "#ircx"), 1);
    }

    /// The restart case, which is the one #223 was filed for: the archive says
    /// where the conversation left off, and everything after it was missed.
    #[test]
    fn a_conversation_restored_from_the_archive_asks_for_its_gap() {
        let mut session = registered_holding("#ircx", "2026-07-31T08:00:00.000Z");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");

        assert_eq!(
            session.sent_starting("CHATHISTORY"),
            ["CHATHISTORY AFTER #ircx timestamp=2026-07-31T08:00:00.000Z 200"]
        );
    }
}

/// Channel modes said in words. `syk_ set mode +o syk` is the protocol; what
/// happened is that syk took ops, and the digest counts it with the rest of the
/// comings and goings.
mod modes_in_words {
    use super::*;

    fn in_channel() -> Harness {
        let mut session = registered("");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.feed(":irc.libera.chat 353 sykk = #ircx :sykk phrack walker");
        session.feed(":irc.libera.chat 366 sykk #ircx :End of NAMES list");
        session.events.clear();
        session
    }

    fn said(session: &Harness) -> Vec<(String, String)> {
        session
            .messages()
            .iter()
            .filter(|message| message.kind == MessageKind::Mode)
            .map(|message| (message.sender.nick.clone(), message.text.clone()))
            .collect()
    }

    /// About the person who now holds it rather than the person who handed it
    /// over: the digest counts one clause and the reader wants the holder.
    #[test]
    fn giving_ops_is_about_who_took_them() {
        let mut session = in_channel();
        session.feed(":phrack!p@h MODE #ircx +o walker");

        assert_eq!(
            said(&session),
            [("walker".to_string(), "took ops".to_string())]
        );
    }

    #[test]
    fn taking_ops_away_is_losing_them() {
        let mut session = in_channel();
        session.feed(":phrack!p@h MODE #ircx -o walker");

        assert_eq!(
            said(&session),
            [("walker".to_string(), "lost ops".to_string())]
        );
    }

    #[test]
    fn voice_is_named_too() {
        let mut session = in_channel();
        session.feed(":phrack!p@h MODE #ircx +v walker");

        assert_eq!(
            said(&session),
            [("walker".to_string(), "took voice".to_string())]
        );
    }

    /// One line can carry several, and each is its own clause to count.
    #[test]
    fn one_line_of_several_becomes_one_message_each() {
        let mut session = in_channel();
        session.feed(":phrack!p@h MODE #ircx +ov walker sykk");

        assert_eq!(
            said(&session),
            [
                ("walker".to_string(), "took ops".to_string()),
                ("sykk".to_string(), "took voice".to_string()),
            ]
        );
    }

    /// A mode that grants nobody anything is about the channel, and stays with
    /// whoever changed it — one line each, saying what it did rather than which
    /// letter it was. #243.
    #[test]
    fn a_channel_mode_says_what_it_did() {
        let mut session = in_channel();
        session.feed(":irc.libera.chat MODE #ircx +nt");

        assert_eq!(
            said(&session),
            [
                (
                    "irc.libera.chat".to_string(),
                    "blocked messages from outside the channel".to_string()
                ),
                (
                    "irc.libera.chat".to_string(),
                    "locked the topic to ops".to_string()
                ),
            ]
        );
    }

    /// Removing one is not adding it with a word in front.
    #[test]
    fn taking_a_channel_mode_off_reads_as_taking_it_off() {
        let mut session = in_channel();
        session.feed(":irc.libera.chat MODE #ircx -i");

        assert_eq!(
            said(&session),
            [(
                "irc.libera.chat".to_string(),
                "took invite-only off the channel".to_string()
            )]
        );
    }

    /// A mode this client has no name for keeps its letter, which is the rule
    /// the membership modes already follow.
    #[test]
    fn a_channel_mode_with_no_name_keeps_its_letter() {
        let mut session = in_channel();
        session.feed(":irc.libera.chat MODE #ircx +C");

        assert_eq!(
            said(&session),
            [(
                "irc.libera.chat".to_string(),
                "set +C on the channel".to_string()
            )]
        );
    }

    /// A standing this client has no name for is still shorter than the letters
    /// it replaces, and still true.
    #[test]
    fn a_standing_with_no_name_keeps_its_letter() {
        let mut session = registered("");
        session.feed(":irc.libera.chat 005 sykk PREFIX=(qaohv)~&@%+ :are supported by this server");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.feed(":irc.libera.chat 353 sykk = #ircx :sykk walker");
        session.feed(":irc.libera.chat 366 sykk #ircx :End of NAMES list");
        session.events.clear();
        session.feed(":phrack!p@h MODE #ircx +a walker");

        assert_eq!(
            said(&session),
            [("walker".to_string(), "took admin".to_string())]
        );
    }
}

/// A rename is two things to a roster that is a list of names: the new one
/// arrives and the old one has to go. Found by driving a channel through a
/// netsplit-sized burst, where seven people renamed and then left, and their
/// old names stayed in the member list for the rest of the session.
mod renaming_in_a_roster {
    use super::*;

    fn joined() -> Harness {
        let mut session = registered("");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.feed(":irc.libera.chat 353 sykk = #ircx :sykk oldname");
        session.feed(":irc.libera.chat 366 sykk #ircx :End of NAMES list");
        session.events.clear();
        session
    }

    /// The roster the frontend holds, replayed from the events it was sent.
    fn roster(session: &Harness) -> Vec<String> {
        let mut held: Vec<String> = Vec::new();
        for event in &session.events {
            match event {
                IrcxEvent::MembersReplaced { members, .. } => {
                    held = members.iter().map(|member| member.nick.clone()).collect();
                }
                IrcxEvent::MemberUpdated { member, .. } => {
                    if !held.iter().any(|nick| nick == &member.nick) {
                        held.push(member.nick.clone());
                    }
                }
                IrcxEvent::MemberRemoved { nick, .. } => held.retain(|held| held != nick),
                _ => {}
            }
        }
        held.sort();
        held
    }

    #[test]
    fn the_old_name_goes_when_the_new_one_arrives() {
        let mut session = joined();
        session.feed(":oldname!o@h NICK newname");

        assert_eq!(roster(&session), ["newname"]);
    }

    /// The failure this was found by: the quit names the new nick, so a roster
    /// still holding the old one keeps it for good.
    #[test]
    fn quitting_after_a_rename_leaves_nobody_behind() {
        let mut session = joined();
        session.feed(":oldname!o@h NICK newname");
        session.feed(":newname!o@h QUIT :leaving");

        assert!(roster(&session).is_empty());
    }

    #[test]
    fn a_rename_that_only_changes_case_still_leaves_one_name() {
        let mut session = joined();
        session.feed(":oldname!o@h NICK OldName");

        assert_eq!(roster(&session), ["OldName"]);
    }
}

/// The other half of #234: a query is the conversation, not the name on it.
mod renaming_in_a_query {
    use super::*;

    fn talking() -> Harness {
        let mut session = registered("");
        session.feed(":oldname!o@h PRIVMSG sykk :are you around?");
        session.events.clear();
        session
    }

    fn renames(session: &Harness) -> Vec<(String, String)> {
        session
            .events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::QueryRenamed { from, to, .. } => Some((from.clone(), to.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_rename_says_which_conversation_moved_and_where() {
        let mut session = talking();
        session.feed(":oldname!o@h NICK newname");

        assert_eq!(
            renames(&session),
            [("oldname".to_string(), "newname".to_string())]
        );
    }

    /// Said before the move, so it carries the name the conversation had.
    #[test]
    fn the_name_it_moved_from_is_the_one_it_was_under() {
        let mut session = talking();
        session.feed(":oldname!o@h NICK OldName");

        assert_eq!(
            renames(&session),
            [("oldname".to_string(), "OldName".to_string())]
        );
    }

    #[test]
    fn a_rename_by_somebody_with_no_query_moves_nothing() {
        let mut session = registered("");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.feed(":irc.libera.chat 353 sykk = #ircx :sykk stranger");
        session.feed(":irc.libera.chat 366 sykk #ircx :End of NAMES list");
        session.events.clear();
        session.feed(":stranger!s@h NICK renamed");

        assert!(renames(&session).is_empty());
    }

    /// The row that follows has to name the person it is now with.
    #[test]
    fn the_query_that_follows_carries_the_new_name() {
        let mut session = talking();
        session.feed(":oldname!o@h NICK newname");

        let named: Vec<String> = session
            .events
            .iter()
            .filter_map(|event| match event {
                IrcxEvent::QueryUpdated { query } => Some(query.nick.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(named, ["newname"]);
    }
}

/// #237. Nobody joins a query, so a private message sent while ircx was closed
/// leaves nothing to ask about and #220's on-join backfill never reaches it.
mod finding_missed_queries {
    use super::*;

    fn returning(caps: &str) -> Harness {
        let mut session = Harness::new(config());
        let actions = session.state.restore(vec![Restored {
            target: OpenTarget::Channel("#ircx".into()),
            newest: Some("2026-07-31T08:00:00.000Z".into()),
        }]);
        session.apply(actions);
        session.connect();
        session.feed(&format!(":irc.libera.chat CAP * LS :{caps}"));
        if !caps.is_empty() {
            session.feed(&format!(":irc.libera.chat CAP * ACK :{caps}"));
        }
        session.sent();
        session.feed(":irc.libera.chat 001 sykk :Welcome to the Libera.Chat IRC Network sykk");
        session
    }

    fn answer(session: &mut Harness, lines: &[&str]) {
        session.feed(":ergo.test BATCH +1 draft/chathistory-targets");
        for line in lines {
            session.feed(line);
        }
        session.feed(":ergo.test BATCH -1");
    }

    #[test]
    fn a_returning_client_asks_what_it_missed() {
        let session = returning("draft/chathistory");

        // The far bound is now, so the line is asserted at both ends rather
        // than whole.
        let asked = session.sent_starting("CHATHISTORY TARGETS");
        assert_eq!(asked.len(), 1);
        assert!(asked[0]
            .starts_with("CHATHISTORY TARGETS timestamp=2026-07-31T08:00:00.000Z timestamp="));
        assert!(asked[0].ends_with(" 50"));
    }

    /// Nothing archived is no gap, only the server's whole memory.
    #[test]
    fn a_first_run_asks_nothing() {
        let mut session = Harness::new(config());
        session.connect();
        session.feed(":irc.libera.chat CAP * LS :draft/chathistory");
        session.feed(":irc.libera.chat CAP * ACK :draft/chathistory");
        session.sent();
        session.feed(":irc.libera.chat 001 sykk :Welcome");

        assert!(session.sent_starting("CHATHISTORY TARGETS").is_empty());
    }

    #[test]
    fn a_server_without_the_capability_is_asked_nothing() {
        let session = returning("");

        assert!(session.sent_starting("CHATHISTORY TARGETS").is_empty());
    }

    #[test]
    fn a_conversation_it_names_is_opened_and_asked_about() {
        let mut session = returning("draft/chathistory");
        session.sent();
        answer(
            &mut session,
            &["@batch=1 :ergo.test CHATHISTORY TARGETS phrack 2026-07-31T09:00:00.000Z"],
        );

        assert_eq!(session.state.queries().len(), 1);
        assert_eq!(
            session.sent_starting("CHATHISTORY LATEST phrack"),
            ["CHATHISTORY LATEST phrack * 200"]
        );
    }

    /// A channel it names is either one this client joins, which #220 asks about
    /// on the way in, or one the user is not in.
    #[test]
    fn a_channel_it_names_is_passed_over() {
        let mut session = returning("draft/chathistory");
        session.sent();
        answer(
            &mut session,
            &["@batch=1 :ergo.test CHATHISTORY TARGETS #elsewhere 2026-07-31T09:00:00.000Z"],
        );

        assert!(session
            .sent_starting("CHATHISTORY LATEST #elsewhere")
            .is_empty());
        // The channel this client is actually in is untouched; the named one
        // was never opened.
        let names: Vec<String> = session
            .state
            .channels()
            .iter()
            .map(|channel| channel.name.clone())
            .collect();
        assert_eq!(names, ["#ircx"]);
    }

    /// The archive is already at or past what the server says was last said, so
    /// there is nothing to fetch.
    #[test]
    fn a_conversation_already_current_is_left_alone() {
        let mut session = Harness::new(config());
        let actions = session.state.restore(vec![Restored {
            target: OpenTarget::Query("phrack".into()),
            newest: Some("2026-07-31T10:00:00.000Z".into()),
        }]);
        session.apply(actions);
        session.connect();
        session.feed(":irc.libera.chat CAP * LS :draft/chathistory");
        session.feed(":irc.libera.chat CAP * ACK :draft/chathistory");
        session.feed(":irc.libera.chat 001 sykk :Welcome");
        session.sent();
        answer(
            &mut session,
            &["@batch=1 :ergo.test CHATHISTORY TARGETS phrack 2026-07-31T09:00:00.000Z"],
        );

        assert!(session.sent_starting("CHATHISTORY").is_empty());
    }

    /// What arrives was missed, which is the whole reason it was asked for.
    #[test]
    fn what_comes_back_counts_as_unread() {
        let mut session = returning("draft/chathistory");
        session.sent();
        answer(
            &mut session,
            &["@batch=1 :ergo.test CHATHISTORY TARGETS phrack 2026-07-31T09:00:00.000Z"],
        );
        session.feed(":ergo.test BATCH +2 chathistory phrack");
        session.feed(
            "@batch=2;time=2026-07-31T09:00:00.000Z :phrack!p@h PRIVMSG sykk :did you see this",
        );
        session.feed(":ergo.test BATCH -2");

        let unread: Vec<u32> = session
            .state
            .queries()
            .iter()
            .map(|query| query.unread)
            .collect();
        assert_eq!(unread, [1]);
    }
}

/// The near side of "while I was away" is where the archive left off when the
/// client started, and nothing this connection does may move it. Walking #237
/// found the window one millisecond wide: the server's own welcome lands in the
/// console before anything asks what was missed, and the console counted.
#[test]
fn the_gap_is_measured_from_before_the_socket_was_opened() {
    let mut session = Harness::new(config());
    let actions = session.state.restore(vec![Restored {
        target: OpenTarget::Channel("#ircx".into()),
        newest: Some("2026-07-31T08:00:00.000Z".into()),
    }]);
    session.apply(actions);
    session.connect();
    session.feed(":irc.libera.chat CAP * LS :draft/chathistory");
    session.feed(":irc.libera.chat CAP * ACK :draft/chathistory");
    session.sent();
    session.feed(":irc.libera.chat 001 sykk :Welcome to the Libera.Chat IRC Network sykk");

    let asked = session.sent_starting("CHATHISTORY TARGETS");
    assert_eq!(asked.len(), 1);
    assert!(
        asked[0].contains("timestamp=2026-07-31T08:00:00.000Z timestamp="),
        "the gap should start where the archive left off, not at the welcome: {}",
        asked[0]
    );
}

/// #239. `AFTER` answers oldest-first, so a page that comes back full is the
/// start of what was missed rather than all of it — and the watermark moves to
/// what did arrive, so without asking again a conversation that outran one page
/// stays exactly one page behind for good.
mod paging_a_gap {
    use super::*;

    /// A server that will answer with three at a time, and a client that has
    /// been away.
    fn behind() -> Harness {
        let mut session = Harness::new(config());
        let actions = session.state.restore(vec![Restored {
            target: OpenTarget::Channel("#ircx".into()),
            newest: Some("2026-07-31T08:00:00.000Z".into()),
        }]);
        session.apply(actions);
        session.connect();
        session.feed(":irc.libera.chat CAP * LS :draft/chathistory");
        session.feed(":irc.libera.chat CAP * ACK :draft/chathistory");
        session.feed(":irc.libera.chat 001 sykk :Welcome");
        session.feed(":irc.libera.chat 005 sykk CHATHISTORY=3 :are supported by this server");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.sent();
        session
    }

    /// `reference` keeps each batch distinct, the way a server's do.
    fn page(session: &mut Harness, reference: u32, minutes: &[u32]) {
        session.feed(&format!(":ergo.test BATCH +{reference} chathistory #ircx"));
        for minute in minutes {
            session.feed(&format!(
                "@batch={reference};time=2026-07-31T09:{minute:02}:00.000Z \
                 :phrack!p@h PRIVMSG #ircx :line {minute}"
            ));
        }
        session.feed(&format!(":ergo.test BATCH -{reference}"));
    }

    #[test]
    fn a_full_page_is_asked_past() {
        let mut session = behind();
        page(&mut session, 1, &[1, 2, 3]);

        assert_eq!(
            session.sent_starting("CHATHISTORY"),
            ["CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:03:00.000Z 3"]
        );
    }

    #[test]
    fn a_short_page_is_the_end_of_it() {
        let mut session = behind();
        page(&mut session, 1, &[1, 2]);

        assert!(session.sent_starting("CHATHISTORY").is_empty());
    }

    /// Found against a real server: the second request went out stamped later
    /// than the whole backlog it was chasing. A conversation's watermark moves
    /// with every message including the live ones, so anything said while a
    /// page is in flight pushes it to now — and the continuation asks for the
    /// gap from after the end of it.
    #[test]
    fn a_live_message_mid_flight_does_not_move_where_the_next_page_starts() {
        let mut session = behind();
        // Said now, while the page is still coming back.
        session.feed("@time=2026-07-31T23:59:00.000Z :walker!w@h PRIVMSG #ircx :meanwhile, live");
        session.sent();
        page(&mut session, 1, &[1, 2, 3]);

        assert_eq!(
            session.sent_starting("CHATHISTORY"),
            ["CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:03:00.000Z 3"]
        );
    }

    #[test]
    fn each_page_carries_on_from_the_last() {
        let mut session = behind();
        page(&mut session, 1, &[1, 2, 3]);
        session.sent();
        page(&mut session, 2, &[4, 5, 6]);

        assert_eq!(
            session.sent_starting("CHATHISTORY"),
            ["CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:06:00.000Z 3"]
        );
    }

    /// Somebody away for a month is not worth a thousand requests, and the
    /// reader is told where the fetching stopped rather than left with the
    /// oldest of what they missed and no reason to doubt it.
    #[test]
    fn it_stops_and_says_so() {
        let mut session = behind();
        // Nine full pages, each answered by a request for the next.
        for round in 1..=9 {
            page(&mut session, round, &[round, round + 20, round + 40]);
        }
        assert_eq!(session.sent_starting("CHATHISTORY").len(), 9);
        session.sent();

        // The tenth is the cap.
        page(&mut session, 10, &[10, 30, 50]);

        assert!(session.sent_starting("CHATHISTORY").is_empty());
        let said: Vec<String> = session
            .messages()
            .iter()
            .filter(|message| message.kind == MessageKind::Client)
            .map(|message| message.text.clone())
            .collect();
        let stopped: Vec<&String> = said
            .iter()
            .filter(|text| text.contains("more that was not"))
            .collect();
        assert_eq!(stopped.len(), 1, "said once, and only once: {said:?}");
    }

    /// A first page of a conversation this client never held is not a gap, so
    /// its truncation is the ordinary "scroll back for more".
    #[test]
    fn a_first_page_is_not_paged_past() {
        let mut session = registered("draft/chathistory");
        session.feed(":irc.libera.chat 005 sykk CHATHISTORY=3 :are supported by this server");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.sent();
        page(&mut session, 1, &[1, 2, 3]);

        assert!(session.sent_starting("CHATHISTORY").is_empty());
    }
}

/// #243. The modes were tracked, used to draw a lock in the sidebar, and shown
/// nowhere a reader could check the lock against. They are said in the
/// conversation now, which is where the topic goes and for the same reason.
mod what_a_channel_is {
    use super::*;

    fn joined_with(modes: &str) -> Harness {
        let mut session = registered("");
        session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
        session.events.clear();
        session.feed(&format!(":irc.libera.chat 324 sykk #ircx {modes}"));
        session
    }

    fn said(session: &Harness) -> Vec<String> {
        session
            .messages()
            .iter()
            .filter(|message| message.kind == MessageKind::Server)
            .map(|message| message.text.clone())
            .collect()
    }

    #[test]
    fn the_rules_are_said_on_the_way_in() {
        let session = joined_with("+int");

        assert_eq!(
            said(&session),
            ["#ircx is invite only, closed to messages from outside and topic-locked to ops."]
        );
    }

    #[test]
    fn one_rule_needs_no_list() {
        let session = joined_with("+m");

        assert_eq!(said(&session), ["#ircx is moderated."]);
    }

    /// A sentence ending in "and +C" helps nobody, and the raw log has the
    /// letters for whoever wants them.
    #[test]
    fn a_mode_with_no_name_is_left_out_rather_than_spelled() {
        let session = joined_with("+Cm");

        assert_eq!(said(&session), ["#ircx is moderated."]);
    }

    #[test]
    fn a_channel_with_nothing_worth_saying_says_nothing() {
        let session = joined_with("+C");

        assert!(said(&session).is_empty());
    }

    /// A key is a mode parameter and may hold any letter, which is the reason
    /// `isRestricted` only ever reads the flag token.
    #[test]
    fn a_key_does_not_read_as_more_modes() {
        let session = joined_with("+k mistletoe");

        assert_eq!(said(&session), ["#ircx is behind a key."]);
    }
}
