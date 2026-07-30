//! Scripted server dialogues. Nothing here opens a socket: lines go into
//! `SessionState`, actions come out, and the assertions are on what the UI
//! would have been told.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ircx_core::{Action, SaslCredentials, SessionConfig, SessionState};
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
        let (outcome, actions) = self.state.submit(target, input);
        self.apply(actions);
        outcome
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
        OpenTarget::Channel("##test".into()),
        OpenTarget::Query("NickServ".into()),
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
