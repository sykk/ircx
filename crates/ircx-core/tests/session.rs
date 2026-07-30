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

const LIBERA_CAPS: &str = "account-notify account-tag away-notify batch chghost echo-message \
     extended-join invite-notify labeled-response message-tags multi-prefix sasl=PLAIN,EXTERNAL \
     server-time userhost-in-names";

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
    closed: bool,
}

impl Harness {
    fn new(config: SessionConfig) -> Self {
        Self {
            state: SessionState::new(config),
            sent: Vec::new(),
            events: Vec::new(),
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
                Action::Close => self.closed = true,
            }
        }
    }

    fn connect(&mut self) {
        let actions = self.state.on_connected();
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
    assert!(requested.contains(&"sasl"));
    assert!(requested.contains(&"multi-prefix"));
    assert!(
        !requested.contains(&"account-tag=x"),
        "values are stripped from the request"
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
    with.feed(":irc.libera.chat 353 sykk = #ircx :~&@sable");
    with.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");
    assert_eq!(with.members("#ircx")[0].prefixes, vec!["~", "&", "@"]);

    let mut without = registered("");
    without.feed(":irc.libera.chat 353 sykk = #ircx :@sable");
    without.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");
    assert_eq!(without.members("#ircx")[0].prefixes, vec!["@"]);
}

#[test]
fn userhost_in_names_does_not_leak_the_mask_into_the_nick() {
    let mut session = registered("userhost-in-names multi-prefix");
    session.feed(":irc.libera.chat 353 sykk = #ircx :@sable!~sable@user/sable ash!a@b");
    session.feed(":irc.libera.chat 366 sykk #ircx :End of /NAMES list.");

    let members = session.members("#ircx");
    assert_eq!(members[0].nick, "sable");
    assert_eq!(members[1].nick, "ash");
}

#[test]
fn rfc1459_folding_finds_a_member_whose_nick_changed_case() {
    let mut session = registered("");
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
            IrcxEvent::MessageUpdated { message } => Some(message),
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

#[test]
fn slash_commands_reach_the_wire_as_the_protocol_spells_them() {
    let mut session = registered("");
    session.feed(":sykk!~sykk@user/sykk JOIN #ircx");
    session.sent();

    session.submit("#ircx", "/join ircx-dev");
    session.submit("#ircx", "/topic the topic goes here");
    session.submit("#ircx", "/kick ash being loud");
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

#[test]
fn a_ping_is_answered_with_the_token_it_carried() {
    let mut session = registered("");
    session.feed("PING :libera-1234");
    assert_eq!(session.sent(), vec!["PONG libera-1234"]);
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
