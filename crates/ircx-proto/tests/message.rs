use ircx_proto::{numeric, Command, Message, MessageBuilder, ParseError, Prefix};

struct Case {
    name: &'static str,
    input: &'static str,
    line: &'static str,
    tags: &'static [(&'static str, Option<&'static str>)],
    prefix: Option<Prefix>,
    command: Command,
    params: &'static [&'static str],
}

fn named(name: &str) -> Command {
    Command::Named(name.to_string())
}

fn server(name: &str) -> Prefix {
    Prefix::Server(name.to_string())
}

fn user(nick: &str, user: Option<&str>, host: Option<&str>) -> Prefix {
    Prefix::User {
        nick: nick.to_string(),
        user: user.map(str::to_string),
        host: host.map(str::to_string),
    }
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            name: "no prefix",
            input: "PING :12345",
            line: "PING 12345",
            tags: &[],
            prefix: None,
            command: named("PING"),
            params: &["12345"],
        },
        Case {
            name: "no parameters",
            input: "QUIT",
            line: "QUIT",
            tags: &[],
            prefix: None,
            command: named("QUIT"),
            params: &[],
        },
        Case {
            name: "server prefix with numeric",
            input: ":irc.example.net 001 alice :Welcome to the network",
            line: ":irc.example.net 001 alice :Welcome to the network",
            tags: &[],
            prefix: Some(server("irc.example.net")),
            command: Command::Numeric(numeric::RPL_WELCOME),
            params: &["alice", "Welcome to the network"],
        },
        Case {
            name: "full user prefix",
            input: ":nick!user@host PRIVMSG #chan :hello world",
            line: ":nick!user@host PRIVMSG #chan :hello world",
            tags: &[],
            prefix: Some(user("nick", Some("user"), Some("host"))),
            command: named("PRIVMSG"),
            params: &["#chan", "hello world"],
        },
        Case {
            name: "bare nick prefix",
            input: ":nick JOIN #chan",
            line: ":nick JOIN #chan",
            tags: &[],
            prefix: Some(user("nick", None, None)),
            command: named("JOIN"),
            params: &["#chan"],
        },
        Case {
            name: "nick and host without user",
            input: ":nick@example.com AWAY",
            line: ":nick@example.com AWAY",
            tags: &[],
            prefix: Some(user("nick", None, Some("example.com"))),
            command: named("AWAY"),
            params: &[],
        },
        Case {
            name: "nick and user without host",
            input: ":nick!user QUIT :bye",
            line: ":nick!user QUIT bye",
            tags: &[],
            prefix: Some(user("nick", Some("user"), None)),
            command: named("QUIT"),
            params: &["bye"],
        },
        Case {
            name: "tags with and without values",
            input: "@bot;account=alice;label= :nick!user@host PRIVMSG #chan :hi",
            line: "@bot;account=alice;label= :nick!user@host PRIVMSG #chan hi",
            tags: &[
                ("bot", None),
                ("account", Some("alice")),
                ("label", Some("")),
            ],
            prefix: Some(user("nick", Some("user"), Some("host"))),
            command: named("PRIVMSG"),
            params: &["#chan", "hi"],
        },
        Case {
            name: "vendor tag key",
            input: "@+draft/reply=abc;time=2026-07-29T12:00:00.000Z PING x",
            line: "@+draft/reply=abc;time=2026-07-29T12:00:00.000Z PING x",
            tags: &[
                ("+draft/reply", Some("abc")),
                ("time", Some("2026-07-29T12:00:00.000Z")),
            ],
            prefix: None,
            command: named("PING"),
            params: &["x"],
        },
        Case {
            name: "escaped tag value",
            input: r"@msg=a\sb\:c\\d PING x",
            line: r"@msg=a\sb\:c\\d PING x",
            tags: &[("msg", Some("a b;c\\d"))],
            prefix: None,
            command: named("PING"),
            params: &["x"],
        },
        Case {
            name: "escaped line breaks in tag value",
            input: r"@msg=one\r\ntwo PING x",
            line: r"@msg=one\r\ntwo PING x",
            tags: &[("msg", Some("one\r\ntwo"))],
            prefix: None,
            command: named("PING"),
            params: &["x"],
        },
        Case {
            name: "unknown escape and lone trailing backslash",
            input: r"@msg=a\qb\ PING x",
            line: "@msg=aqb PING x",
            tags: &[("msg", Some("aqb"))],
            prefix: None,
            command: named("PING"),
            params: &["x"],
        },
        Case {
            name: "empty trailing",
            input: "PRIVMSG #chan :",
            line: "PRIVMSG #chan :",
            tags: &[],
            prefix: None,
            command: named("PRIVMSG"),
            params: &["#chan", ""],
        },
        Case {
            name: "trailing full of colons",
            input: "PRIVMSG #chan ::-) time: 12:00",
            line: "PRIVMSG #chan ::-) time: 12:00",
            tags: &[],
            prefix: None,
            command: named("PRIVMSG"),
            params: &["#chan", ":-) time: 12:00"],
        },
        Case {
            name: "fifteenth parameter swallows the rest",
            input: "CMD a b c d e f g h i j k l m n o p q",
            line: "CMD a b c d e f g h i j k l m n :o p q",
            tags: &[],
            prefix: None,
            command: named("CMD"),
            params: &[
                "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o p q",
            ],
        },
        Case {
            name: "repeated spaces between tokens",
            input: "PING   :hello  world",
            line: "PING :hello  world",
            tags: &[],
            prefix: None,
            command: named("PING"),
            params: &["hello  world"],
        },
        Case {
            name: "four digits is not a numeric",
            input: "0001 alice",
            line: "0001 alice",
            tags: &[],
            prefix: None,
            command: named("0001"),
            params: &["alice"],
        },
        Case {
            name: "three characters with a letter is not a numeric",
            input: "12a alice",
            line: "12a alice",
            tags: &[],
            prefix: None,
            command: named("12a"),
            params: &["alice"],
        },
        Case {
            name: "line terminator is stripped",
            input: "PRIVMSG #chan :hi there\r\n",
            line: "PRIVMSG #chan :hi there",
            tags: &[],
            prefix: None,
            command: named("PRIVMSG"),
            params: &["#chan", "hi there"],
        },
    ]
}

#[test]
fn parses_each_case() {
    for case in cases() {
        let message = Message::parse(case.input).unwrap_or_else(|e| panic!("{}: {e}", case.name));

        let tags: Vec<(String, Option<String>)> = case
            .tags
            .iter()
            .map(|(key, value)| (key.to_string(), value.map(str::to_string)))
            .collect();
        let params: Vec<String> = case.params.iter().map(|p| p.to_string()).collect();

        assert_eq!(message.tags, tags, "{}", case.name);
        assert_eq!(message.prefix, case.prefix, "{}", case.name);
        assert_eq!(message.command, case.command, "{}", case.name);
        assert_eq!(message.params, params, "{}", case.name);
        assert_eq!(message.to_line(), case.line, "{}", case.name);
    }
}

#[test]
fn parsing_a_serialised_message_yields_the_same_message() {
    for case in cases() {
        let message = Message::parse(case.input).unwrap();
        let line = message.to_line();
        let expected = Message {
            raw: line.clone(),
            ..message
        };
        assert_eq!(Message::parse(&line).unwrap(), expected, "{}", case.name);
    }
}

#[test]
fn raw_keeps_the_line_as_received() {
    let message = Message::parse("PING   :12345\r\n").unwrap();
    assert_eq!(message.raw, "PING   :12345");
}

#[test]
fn malformed_lines_are_rejected() {
    let cases = [
        ("", ParseError::Empty),
        ("   ", ParseError::Empty),
        ("\r\n", ParseError::Empty),
        (":", ParseError::EmptyPrefix),
        (": ", ParseError::EmptyPrefix),
        (": PRIVMSG #chan :hi", ParseError::EmptyPrefix),
        (":irc.example.net", ParseError::MissingCommand),
        ("@", ParseError::EmptyTags),
        ("@ PING x", ParseError::EmptyTags),
        ("@;; PING x", ParseError::EmptyTags),
        ("@time=1", ParseError::MissingCommand),
        ("@time=1 :nick!user@host", ParseError::MissingCommand),
    ];
    for (input, expected) in cases {
        assert_eq!(Message::parse(input), Err(expected), "{input:?}");
    }
}

#[test]
fn over_long_inbound_lines_parse() {
    let line = format!("PRIVMSG #chan :{}", "x".repeat(2000));
    let message = Message::parse(&line).unwrap();
    assert_eq!(message.param(1).unwrap().len(), 2000);
}

#[test]
fn parse_never_panics() {
    let alphabet = [':', '@', ';', ' ', '\\', '=', '!', 'a', 'é'];
    let mut inputs = vec![String::new()];
    for _ in 0..4 {
        let mut longer = Vec::new();
        for base in &inputs {
            for c in alphabet {
                let mut candidate = base.clone();
                candidate.push(c);
                if let Ok(message) = Message::parse(&candidate) {
                    let line = message.to_line();
                    assert!(Message::parse(&line).is_ok(), "{candidate:?} -> {line:?}");
                }
                longer.push(candidate);
            }
        }
        inputs = longer;
    }
}

#[test]
fn tag_reads_a_missing_value_as_empty() {
    let message = Message::parse("@a=1;bare;empty= PING x").unwrap();
    assert_eq!(message.tag("a"), Some("1"));
    assert_eq!(message.tag("bare"), Some(""));
    assert_eq!(message.tag("empty"), Some(""));
    assert_eq!(message.tag("absent"), None);
}

#[test]
fn param_reads_by_index() {
    let message = Message::parse(":n JOIN #chan :account").unwrap();
    assert_eq!(message.param(0), Some("#chan"));
    assert_eq!(message.param(1), Some("account"));
    assert_eq!(message.param(2), None);
}

#[test]
fn builder_serialises_the_message_it_was_given() {
    let message = MessageBuilder::new("PRIVMSG")
        .tag("label", Some("42".to_string()))
        .tag("bot", None)
        .prefix(Prefix::User {
            nick: "nick".to_string(),
            user: None,
            host: None,
        })
        .param("#chan")
        .param("hello world")
        .build()
        .unwrap();

    assert_eq!(
        message.to_line(),
        "@label=42;bot :nick PRIVMSG #chan :hello world"
    );
    assert_eq!(message.raw, message.to_line());
}

#[test]
fn builder_takes_a_numeric_command() {
    let message = MessageBuilder::new(Command::Numeric(numeric::RPL_WELCOME))
        .param("alice")
        .param("Welcome")
        .build()
        .unwrap();
    assert_eq!(message.to_line(), "001 alice Welcome");
}

#[test]
fn builder_escapes_tag_values() {
    let message = MessageBuilder::new("TAGMSG")
        .tag("msg", Some("a b;c\\d\r\n".to_string()))
        .param("#chan")
        .build()
        .unwrap();
    assert_eq!(message.to_line(), r"@msg=a\sb\:c\\d\r\n TAGMSG #chan");
}

#[test]
fn builder_rejects_an_over_long_message() {
    let error = MessageBuilder::new("PRIVMSG")
        .param("#chan")
        .param("x".repeat(600))
        .build()
        .unwrap_err();
    assert!(
        matches!(error, ParseError::MessageTooLong { len: 616 }),
        "{error}"
    );
}

#[test]
fn builder_rejects_over_long_tags() {
    let error = MessageBuilder::new("PING")
        .tag("msg", Some("x".repeat(9000)))
        .param("a")
        .build()
        .unwrap_err();
    assert!(matches!(error, ParseError::TagsTooLong { .. }), "{error}");
}

#[test]
fn builder_rejects_a_line_break_in_a_parameter() {
    let error = MessageBuilder::new("PRIVMSG")
        .param("#chan")
        .param("hi\r\nQUIT")
        .build()
        .unwrap_err();
    assert!(
        matches!(error, ParseError::InvalidParam { index: 1, .. }),
        "{error}"
    );
}

#[test]
fn builder_rejects_a_space_in_a_middle_parameter() {
    let error = MessageBuilder::new("PRIVMSG")
        .param("#chan #other")
        .param("hi")
        .build()
        .unwrap_err();
    assert!(
        matches!(error, ParseError::InvalidParam { index: 0, .. }),
        "{error}"
    );
}

#[test]
fn sasl_numerics_cover_900_to_908() {
    assert!(!numeric::is_sasl(899));
    assert!(numeric::is_sasl(numeric::RPL_LOGGEDIN));
    assert!(numeric::is_sasl(numeric::RPL_SASLSUCCESS));
    assert!(numeric::is_sasl(numeric::RPL_SASLMECHS));
    assert!(!numeric::is_sasl(909));
}
