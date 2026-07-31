//! A plugin's slash command, end to end: installed, granted, typed, run, and
//! applied to the session — and the same again when the plugin misbehaves,
//! because #13's requirement is that the second case changes nothing about the
//! connection.
//!
//! Nothing here opens a socket. Lines go into `SessionState`, actions come out.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use ircx_core::{
    network_for_plugins, run_plugin, Action, CommandSpec, Grants, Manifest, Permission,
    PluginLimits, PluginRuntime, SessionConfig, SessionState,
};
use ircx_ipc::{CommandOutcome, IrcxEvent, MessageKind};

const CHANNEL: &str = "#ircx";

const GREETER: &str = r#"
ircx.command("greet", (call) => {
  ircx.send(call.target, "hello " + (call.args || "everyone"));
  return "greeted " + (call.args || "everyone");
});
"#;

const LOOPER: &str = r#"ircx.command("hog", () => { for (;;) {} });"#;

const READER: &str = r#"
ircx.command("last", (call) =>
  call.messages.map((message) => message.nick + " said " + message.text).join("; ") ||
  "nothing to read",
);
"#;

const PEEKER: &str = r#"ircx.command("peek", (call) => String(call.messages.length));"#;

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

/// A session registered far enough to have a nick and a channel, the way the
/// user would be when they type a command.
fn session() -> SessionState {
    let mut session = SessionState::new(config());
    session.on_connected(None);
    session.on_line(":irc.libera.chat 001 sykk :Welcome to the Libera.Chat IRC Network sykk");
    session.on_line(
        ":irc.libera.chat 005 sykk CHANTYPES=# PREFIX=(ov)@+ CASEMAPPING=rfc1459 \
         NETWORK=Libera.Chat :are supported by this server",
    );
    session.join(CHANNEL, None);
    session.on_line(&format!(":sykk!sykk@example JOIN {CHANNEL}"));
    session
}

/// A plugin as an author would ship it: a manifest asking for what it needs and
/// one file of code.
fn author(root: &Path, id: &str, command: &str, source: &str, requests: Grants) -> PathBuf {
    let manifest = Manifest {
        id: id.into(),
        name: id.into(),
        version: "1.0.0".into(),
        description: String::new(),
        entry: "main.js".into(),
        annotates: false,
        commands: vec![CommandSpec {
            name: command.into(),
            summary: String::new(),
        }],
        requests,
    };
    let directory = root.join(format!("{id}-source"));
    std::fs::create_dir_all(&directory).expect("write a plugin");
    let json = serde_json::to_vec(&manifest).expect("a manifest serialises");
    std::fs::write(directory.join("plugin.json"), json).expect("write the manifest");
    std::fs::write(directory.join("main.js"), source).expect("write the code");
    directory
}

fn grants(permissions: &[Permission], channels: &[&str]) -> Grants {
    Grants {
        permissions: permissions.iter().copied().collect(),
        channels: channels.iter().map(|name| (*name).to_owned()).collect(),
        hosts: Vec::new(),
    }
}

fn speaks() -> Grants {
    grants(
        &[
            Permission::AddCommands,
            Permission::SendMessages,
            Permission::AccessChannels,
            Permission::RenderContent,
        ],
        &[CHANNEL],
    )
}

/// Installs the plugin and grants it what it asked for, the way the install
/// dialogue would once the user agreed.
fn runtime(root: &Path, plugins: &[(&str, &str, &str, Grants)]) -> Arc<PluginRuntime> {
    let runtime = PluginRuntime::open(
        root.join("plugins"),
        PluginLimits::default(),
        network_for_plugins(tokio::runtime::Handle::current()),
    )
    .expect("open the library");
    for (id, command, source, requests) in plugins {
        let source = author(root, id, command, source, requests.clone());
        let installed = runtime.install(&source).expect("install");
        runtime
            .set_grants(id, installed.manifest.requests.clone())
            .expect("grant what it asked for");
    }
    Arc::new(runtime)
}

fn lines(actions: &[Action]) -> Vec<String> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Send(line) => Some(line.clone()),
            _ => None,
        })
        .collect()
}

/// The client notes an action produced, with the plugin each was attributed to.
fn attributed(actions: &[Action]) -> Vec<(String, Option<String>)> {
    client_notes(actions)
        .map(|message| (message.text, message.via))
        .collect()
}

/// Every message a call put into a conversation, whatever kind.
fn appended(actions: &[Action]) -> Vec<ircx_ipc::ChatMessage> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Emit(event) => match event.as_ref() {
                IrcxEvent::MessagesAppended { messages, .. } => Some(messages.clone()),
                _ => None,
            },
            _ => None,
        })
        .flatten()
        .collect()
}

fn client_notes(actions: &[Action]) -> impl Iterator<Item = ircx_ipc::ChatMessage> + '_ {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Emit(event) => match event.as_ref() {
                IrcxEvent::MessagesAppended { messages, .. } => Some(messages.clone()),
                _ => None,
            },
            _ => None,
        })
        .flatten()
        .filter(|message| message.kind == MessageKind::Client)
}

fn notes(actions: &[Action]) -> Vec<String> {
    actions
        .iter()
        .filter_map(|action| match action {
            Action::Emit(event) => match event.as_ref() {
                IrcxEvent::MessagesAppended { messages, .. } => Some(messages.clone()),
                _ => None,
            },
            _ => None,
        })
        .flatten()
        .filter(|message| message.kind == MessageKind::Client)
        .map(|message| message.text)
        .collect()
}

/// The whole of what the session task does with a plugin command.
async fn submit(
    runtime: &Arc<PluginRuntime>,
    session: &mut SessionState,
    input: &str,
) -> (CommandOutcome, Vec<Action>) {
    match session.plugin_command(runtime, CHANNEL, input) {
        Some(call) => {
            let answer = run_plugin(Arc::clone(runtime), &call).await;
            session.apply_plugin(&call, answer)
        }
        None => session.submit(CHANNEL, input, None),
    }
}

#[tokio::test]
async fn a_plugin_command_sends_as_the_user_and_answers_in_the_conversation() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = runtime(root.path(), &[("greeter", "greet", GREETER, speaks())]);
    let mut session = session();

    let (outcome, actions) = submit(&runtime, &mut session, "/greet #ircx").await;
    assert!(matches!(outcome, CommandOutcome::Handled), "{outcome:?}");
    assert_eq!(
        lines(&actions),
        vec![format!("PRIVMSG {CHANNEL} :hello #ircx")]
    );
    assert_eq!(notes(&actions), vec!["greeted #ircx".to_string()]);
}

/// A plugin's answer is the only text in a conversation that neither the client
/// nor the server said. Without a name on it, it reads as `/help` output; and
/// the sender it inherits from `local_message` is the user's own, so an
/// unnamed one is archived as something the user said.
#[tokio::test]
async fn a_plugin_answer_is_attributed_to_the_plugin_and_not_to_the_user() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = runtime(root.path(), &[("greeter", "greet", GREETER, speaks())]);
    let mut session = session();

    let (_, actions) = submit(&runtime, &mut session, "/greet #ircx").await;

    assert_eq!(
        attributed(&actions),
        vec![("greeted #ircx".to_string(), Some("greeter".to_string()))]
    );
    let note = client_notes(&actions).next().expect("the answer");
    assert!(!note.sender.is_self, "the user did not say this");
    assert_ne!(note.sender.nick, "sykk", "nor is it under their nick");
}

/// A standing constraint, per `docs/plugins.md`: a plugin may add to a
/// conversation and may not change what somebody else said. Nothing in the host
/// surface can do it today, and this is what would notice a hook that could.
///
/// Every message a call produces is either the user's own — what `ircx.send`
/// put on the wire, which is sent as them and by their choice to run it — or
/// the plugin's, named. Neither wears a third party's nick.
#[tokio::test]
async fn nothing_a_plugin_produces_speaks_as_another_person() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = runtime(root.path(), &[("greeter", "greet", GREETER, speaks())]);
    let mut session = session();
    // Somebody else is in the conversation and has spoken in it.
    session.on_line(":sable!~s@user/sable PRIVMSG #ircx :what I actually said");

    let (_, actions) = submit(&runtime, &mut session, "/greet #ircx").await;

    let produced = appended(&actions);
    assert!(!produced.is_empty(), "the call put something in the room");
    for message in produced {
        let mine = message.sender.is_self;
        let named = message.via.is_some();
        assert!(
            mine || named,
            "a plugin produced a message that is neither the user's nor its own: {message:?}"
        );
        assert_ne!(
            message.sender.nick, "sable",
            "and none of it wears her nick"
        );
    }
}

/// The client's own output keeps saying nothing about a plugin, so the field
/// means "a plugin produced this" rather than "this is a note".
#[tokio::test]
async fn the_clients_own_output_names_no_plugin() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = runtime(root.path(), &[("greeter", "greet", GREETER, speaks())]);
    let mut session = session();

    let (_, actions) = submit(&runtime, &mut session, "/help").await;

    let named: Vec<Option<String>> = client_notes(&actions).map(|note| note.via).collect();
    assert!(!named.is_empty(), "/help prints something");
    assert!(named.iter().all(Option::is_none), "{named:?}");
}

#[tokio::test]
async fn a_command_no_plugin_owns_is_still_the_client_saying_it_does_not_know_it() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = runtime(root.path(), &[("greeter", "greet", GREETER, speaks())]);
    let mut session = session();

    let (outcome, _) = submit(&runtime, &mut session, "/nonsense").await;
    assert!(
        matches!(&outcome, CommandOutcome::Rejected(why) if why.contains("not a command")),
        "{outcome:?}"
    );
}

/// A plugin cannot take a built-in over. `/quit` is the client's, whatever a
/// manifest says.
#[tokio::test]
async fn a_plugin_cannot_take_over_a_command_the_client_owns() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let runtime = runtime(
        root.path(),
        &[(
            "hijacker",
            "quit",
            r#"ircx.command("quit", () => "mine now");"#,
            speaks(),
        )],
    );
    let mut session = session();

    let (outcome, actions) = submit(&runtime, &mut session, "/quit goodbye").await;
    assert!(matches!(outcome, CommandOutcome::Handled), "{outcome:?}");
    assert_eq!(lines(&actions), vec!["QUIT goodbye".to_string()]);
    assert!(notes(&actions).is_empty(), "the plugin never ran");
}

/// The requirement in #13: a broken plugin is terminated and reported, and the
/// connection carries on. The session is asked to do something ordinary
/// afterwards to show it is still there.
#[tokio::test]
async fn a_plugin_that_will_not_stop_is_reported_and_the_session_carries_on() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let limits = PluginLimits {
        call: std::time::Duration::from_millis(100),
        ..PluginLimits::default()
    };
    let runtime = PluginRuntime::open(
        root.path().join("plugins"),
        limits,
        network_for_plugins(tokio::runtime::Handle::current()),
    )
    .expect("open");
    let source = author(root.path(), "hog", "hog", LOOPER, speaks());
    runtime.install(&source).expect("install");
    runtime.set_grants("hog", speaks()).expect("grant");
    let runtime = Arc::new(runtime);
    let mut session = session();

    let (outcome, actions) = submit(&runtime, &mut session, "/hog").await;
    let CommandOutcome::Rejected(why) = outcome else {
        panic!("a plugin that loops is reported: {outcome:?}");
    };
    assert!(why.contains("hog"), "the report names the plugin: {why}");
    assert!(why.contains("too long"), "and says what it did: {why}");
    assert!(lines(&actions).is_empty(), "nothing went to the server");

    let (outcome, actions) = submit(&runtime, &mut session, "hello everyone").await;
    assert!(matches!(outcome, CommandOutcome::Sent(_)), "{outcome:?}");
    assert_eq!(
        lines(&actions),
        vec![format!("PRIVMSG {CHANNEL} :hello everyone")],
        "the connection is untouched by the plugin that was stopped"
    );
}

/// `read messages` is the archive's, not the session's, so the caller decides
/// whether to read it. This asserts the decision rather than the reading: a
/// plugin without the grant is never asked for.
#[tokio::test]
async fn the_conversation_is_read_for_a_plugin_only_when_it_was_granted() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let reads = grants(
        &[
            Permission::AddCommands,
            Permission::ReadMessages,
            Permission::AccessChannels,
            Permission::RenderContent,
        ],
        &[CHANNEL],
    );
    let blind = grants(&[Permission::AddCommands, Permission::RenderContent], &[]);
    let runtime = runtime(
        root.path(),
        &[
            ("reader", "last", READER, reads),
            ("blind", "peek", PEEKER, blind),
        ],
    );
    let session = session();

    let reading = session
        .plugin_command(&runtime, CHANNEL, "/last")
        .expect("the reader owns /last");
    assert!(reading.wants_messages(), "the archive is worth reading");

    let blind = session
        .plugin_command(&runtime, CHANNEL, "/peek")
        .expect("the other owns /peek");
    assert!(
        !blind.wants_messages(),
        "a plugin without the grant costs no query"
    );
}

/// What the plugin is handed when the caller did read the archive.
#[tokio::test]
async fn a_granted_plugin_is_handed_the_recent_messages() {
    let root = tempfile::tempdir().expect("a temporary directory");
    let reads = grants(
        &[
            Permission::AddCommands,
            Permission::ReadMessages,
            Permission::AccessChannels,
            Permission::RenderContent,
        ],
        &[CHANNEL],
    );
    let runtime = runtime(root.path(), &[("reader", "last", READER, reads)]);
    let mut session = session();
    session.on_line(&format!(
        ":ana!ana@example PRIVMSG {CHANNEL} :the first thing"
    ));

    let call = session
        .plugin_command(&runtime, CHANNEL, "/last")
        .expect("routed")
        .with_messages(vec![message("ana", "the first thing")]);
    let answer = run_plugin(Arc::clone(&runtime), &call).await;
    let (outcome, actions) = session.apply_plugin(&call, answer);

    assert!(matches!(outcome, CommandOutcome::Handled), "{outcome:?}");
    assert_eq!(
        notes(&actions),
        vec!["ana said the first thing".to_string()]
    );
}

fn message(nick: &str, text: &str) -> ircx_ipc::ChatMessage {
    ircx_ipc::ChatMessage {
        id: "1".into(),
        id_is_local: true,
        network: "libera".into(),
        target: CHANNEL.into(),
        kind: MessageKind::Privmsg,
        sender: ircx_ipc::Sender {
            nick: nick.into(),
            user: None,
            host: None,
            account: None,
            is_self: false,
        },
        timestamp: "2026-07-30T12:00:00Z".into(),
        timestamp_is_local: false,
        text: text.into(),
        tags: Vec::new(),
        reply_to: None,
        batch: None,
        delivery: ircx_ipc::Delivery::Delivered,
        reactions: Vec::new(),
        attachments: Vec::new(),
        encryption: ircx_ipc::EncryptionState::Plaintext,
        via: None,
        raw: String::new(),
        source: ircx_ipc::MessageSource::Live,
    }
}

/// Every command the client answers itself stays the client's. If a name is
/// added to `dispatch` and not to the list plugin routing checks, a plugin
/// could take it over, and this is what would catch it.
#[test]
fn every_built_in_command_is_answered_by_the_client() {
    for name in [
        "join", "j", "part", "leave", "msg", "notice", "react", "unreact", "me", "query", "nick",
        "topic", "mode", "kick", "invite", "list", "whois", "away", "quit", "raw", "quote", "help",
    ] {
        let mut session = session();
        let (outcome, _) = session.submit(CHANNEL, &format!("/{name}"), None);
        let rejected = match &outcome {
            CommandOutcome::Rejected(why) => why.contains("not a command ircx knows"),
            _ => false,
        };
        assert!(!rejected, "/{name} is the client's: {outcome:?}");
    }
}

/// What an annotator is handed. A note sits beside something somebody wrote,
/// and handing over joins and server chatter would multiply the call count by
/// traffic that has nothing to annotate.
#[test]
fn only_what_a_person_said_reaches_an_annotator() {
    let mut session = session();
    let action = "\u{1}ACTION waves\u{1}";
    let mut appended = Vec::new();
    for line in [
        format!(":sable!s@h PRIVMSG {CHANNEL} :hello"),
        format!(":nyx!n@h JOIN {CHANNEL}"),
        format!(":nyx!n@h PRIVMSG {CHANNEL} :{action}"),
        format!(":kade!k@h PART {CHANNEL}"),
        format!(":serv NOTICE {CHANNEL} :heads up"),
    ] {
        for emitted in session.on_line(&line) {
            if let Action::Emit(event) = emitted {
                if let IrcxEvent::MessagesAppended { messages, .. } = *event {
                    appended.extend(messages);
                }
            }
        }
    }

    let handed = ircx_core::spoken(&appended);
    assert_eq!(
        handed.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["hello", "waves", "heads up"],
        "the join and the part are not things a person said"
    );
}
