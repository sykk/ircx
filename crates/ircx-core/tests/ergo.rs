//! Drives the real stack against a local `ergo` and prints what it found.
//!
//! Ignored by default so `cargo test --workspace` never dials anything:
//!
//! ```text
//! cargo test -p ircx-core --test ergo -- --ignored --nocapture
//! ```
//!
//! `tests/libera.rs` does the same against irc.libera.chat and answers a
//! different question. Libera is the network this milestone targets, so that
//! driver is about TLS, certificates, nick collisions and a channel with
//! thousands of people in it. None of that is what is unverified here.
//!
//! What is unverified here needs a server that **relays client tags**, which
//! Libera does not: it allows `+typing` and drops everything else, so reactions
//! and replies reach nobody there and cannot be exercised. Ergo relays all of
//! them. `docs/manual-verification.md` records how that was established.
//!
//! The plumbing is its own rather than shared with `libera.rs`. That harness
//! carries the TLS and collision machinery this has no use for, and a refactor
//! of it cannot be checked without dialling Libera.
//!
//! Set up with:
//!
//! ```text
//! ergo run --conf ircx-test.yaml   # loopback, plaintext, no :6697 listener
//! ```

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ircx_core::{
    spawn_network_with_plugins, Grants, NetworkHandle, Permission, PluginLimits, PluginRuntime,
    SessionCommand, SessionConfig,
};
use ircx_ipc::{ChatMessage, ConnectionStatus, Delivery, IrcxEvent, MessageKind, MessageSource};
use ircx_store::Store;
use tokio::sync::mpsc;
use tokio::time::timeout;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 6667;
const CHANNEL: &str = "#ircx-drive";
/// A channel this client opens itself, so it holds `+o` there.
const OWN_CHANNEL: &str = "#ircx-topic";
const TOPIC: &str = "read the FAQ before asking";
/// Long enough for a loopback server, short enough that a server which is not
/// running fails the run rather than hanging it.
const PATIENCE: Duration = Duration::from_secs(10);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a local ergo on 127.0.0.1:6667"]
async fn against_ergo() {
    let mut report = Report::default();
    let room = tempfile::tempdir().expect("a temporary directory");
    let store = match Store::open(&room.path().join("ircx.sqlite3")) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            report.fail("archive", &format!("Store::open failed: {error}"));
            report.finish();
            return;
        }
    };

    let plugins = on_arrival_plugins(&mut report, room.path());
    let runtime = plugins.clone();
    let mut live = Live::start(config("ergo", "ircx-drive"), Arc::clone(&store), plugins);

    // A second client, because one session alone cannot exercise any of this.
    // An empty channel ceases to exist, so parting one nobody else is in
    // destroys the topic with it; and a message of your own is handed back to
    // the caller rather than appended, so no annotator ever sees it.
    let other_store = match Store::open(&room.path().join("other.sqlite3")) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            report.fail("archive", &format!("second Store::open failed: {error}"));
            report.finish();
            return;
        }
    };
    let mut other = Live::start(config("ergo-2", "ircx-other"), other_store, None);

    // A third, under the nick `deploys` looks for. A rule decides on who said
    // it as much as on what was said, so the run needs a build bot to be one.
    let bot_store = match Store::open(&room.path().join("bot.sqlite3")) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            report.fail("archive", &format!("third Store::open failed: {error}"));
            report.finish();
            return;
        }
    };
    let mut bot = Live::start(config("ergo-3", "buildbot"), bot_store, None);

    if !registered(&mut report, &mut live).await
        || !registered(&mut report, &mut other).await
        || !registered(&mut report, &mut bot).await
    {
        live.stop().await;
        other.stop().await;
        bot.stop().await;
        report.finish();
        return;
    }
    if !other.join(CHANNEL).await || !bot.join(CHANNEL).await {
        report.fail("setup", "a second client never joined");
        live.stop().await;
        other.stop().await;
        bot.stop().await;
        report.finish();
        return;
    }

    topic_on_join(&mut report, &mut live, &mut other).await;
    a_topic_typed_here_comes_back_changed(&mut report, &mut live).await;
    a_topic_refused_says_why(&mut report, &mut live).await;
    a_reply_carries_its_parent(&mut report, &mut live, &mut other).await;
    a_reaction_goes_out_as_a_tagmsg(&mut report, &mut live).await;
    an_annotator_sees_what_arrives(&mut report, &mut live, &mut other).await;
    a_rule_raises_what_it_was_asked_about(&mut report, &mut live, &mut bot).await;
    a_backfill_fills_the_gap(&mut report, &mut live, &mut other).await;
    a_dropped_hook_comes_back(
        &mut report,
        &mut live,
        &mut other,
        runtime.as_deref(),
        room.path(),
    )
    .await;

    if report.failed() {
        println!("\n--- transcript");
        for line in &live.transcript {
            println!("{line}");
        }
    }

    live.stop().await;
    other.stop().await;
    bot.stop().await;
    report.finish();
}

/// Both example plugins that run on arrival, installed and granted the channel
/// this run uses. `None` leaves their steps to report that they could not run
/// rather than silently passing.
fn on_arrival_plugins(report: &mut Report, room: &Path) -> Option<Arc<PluginRuntime>> {
    let runtime = match PluginRuntime::open(
        room.join("plugins"),
        PluginLimits::default(),
        ircx_core::network_for_plugins(tokio::runtime::Handle::current()),
    ) {
        Ok(runtime) => runtime,
        Err(error) => {
            report.fail("plugins", &format!("could not open the library: {error}"));
            return None;
        }
    };

    for (id, hook) in [
        ("units", Permission::AnnotateMessages),
        ("deploys", Permission::RaiseNotifications),
    ] {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/plugins")
            .join(id);
        if let Err(error) = runtime.install(&source) {
            report.fail("plugins", &format!("could not install {id}: {error}"));
            return None;
        }
        let grants = Grants {
            permissions: [hook, Permission::AccessChannels].into_iter().collect(),
            channels: vec![CHANNEL.into()],
            hosts: Vec::new(),
        };
        if let Err(error) = runtime.set_grants(id, grants) {
            report.fail("plugins", &format!("could not grant {id}: {error}"));
            return None;
        }
        report.pass("plugins", &format!("{id} installed and granted"));
    }
    Some(Arc::new(runtime))
}

async fn registered(report: &mut Report, live: &mut Live) -> bool {
    let connected = live
        .wait(PATIENCE, |event| match event {
            IrcxEvent::ConnectionChanged { status, .. } => match status {
                ConnectionStatus::Connected => Some(Ok(())),
                ConnectionStatus::Failed { message } => Some(Err(message.clone())),
                _ => None,
            },
            _ => None,
        })
        .await;

    match connected {
        Some(Ok(())) => {
            report.pass("connect", &format!("registered on {HOST}:{PORT}"));
            true
        }
        Some(Err(why)) => {
            report.fail("connect", &format!("{HOST}:{PORT} refused: {why}"));
            false
        }
        None => {
            report.fail(
                "connect",
                &format!("no registration from {HOST}:{PORT} — is ergo running?"),
            );
            false
        }
    }
}

/// #153. The topic a channel already has arrives as `332` and `333`, which had
/// nothing to draw them until this.
///
/// The other client sets it, because it joined first and so holds the channel
/// operator that `+t` requires. That is also the case worth testing: somebody
/// else set the topic and you are joining afterwards.
async fn topic_on_join(report: &mut Report, live: &mut Live, other: &mut Live) {
    other.submit(CHANNEL, &format!("/topic {TOPIC}")).await;
    if other
        .said(PATIENCE, |message| {
            message.kind == MessageKind::Topic && message.text.contains(TOPIC)
        })
        .await
        .is_none()
    {
        report.fail("topic on join", "the other client could not set the topic");
        return;
    }

    if !live.join(CHANNEL).await {
        report.fail("topic on join", "never joined the channel");
        return;
    }

    let said = live
        .said(PATIENCE, |message| {
            message.kind == MessageKind::Topic && message.text.contains(TOPIC)
        })
        .await;
    match said {
        Some(message) => report.pass("topic on join", &message.text),
        None => report.fail("topic on join", "no topic message after joining"),
    }

    let who = live
        .said(Duration::from_secs(5), |message| {
            message.kind == MessageKind::Topic && message.text.starts_with("Set by")
        })
        .await;
    match who {
        Some(message) => report.pass("topic attribution", &message.text),
        None => report.fail("topic attribution", "no `Set by` line followed it"),
    }
}

/// The other half of the topic path, and the half no run had seen: a `/topic`
/// typed here rather than one somebody else set before we arrived.
///
/// It is a different code path from the one above, which is why setting the
/// topic as a precondition did not cover it. Joining a channel that has one
/// reads `332` and lands in `on_topic`; changing it reads the server's own
/// `TOPIC` line back and lands in `handle_topic`, which names who did it. The
/// two produce different sentences, so the assertion is on the wording as well
/// as on the text — matching only the topic would pass on either.
async fn a_topic_typed_here_comes_back_changed(report: &mut Report, live: &mut Live) {
    const CHANGED: &str = "mind the bots";
    // A channel this client opens, because ergo gives the first arrival `+o` and
    // every channel here is `+t`. Setting it in CHANNEL is what the refusal
    // below covers; this needs the case where the server says yes.
    if !live.join(OWN_CHANNEL).await {
        report.fail("topic changed here", "never joined the channel it opens");
        return;
    }
    live.submit(OWN_CHANNEL, &format!("/topic {CHANGED}")).await;

    match live
        .said(PATIENCE, |message| {
            message.kind == MessageKind::Topic && message.text.contains(CHANGED)
        })
        .await
    {
        Some(message) if message.text.contains("set the topic of") => {
            report.pass("topic changed here", &message.text)
        }
        Some(message) => report.fail(
            "topic changed here",
            &format!("came back as a join would read it: {}", message.text),
        ),
        None => {
            report.fail("topic changed here", "no topic message came back");
            return;
        }
    }

    // The sentence is what the timeline draws; this is what the header and the
    // sidebar draw, and nothing above would notice it going stale. Only an
    // update that carries a topic will do — joining raises several that do not,
    // and taking the first would assert nothing.
    let held = live
        .wait(PATIENCE, |event| match event {
            IrcxEvent::ChannelUpdated { channel }
                if channel.name == OWN_CHANNEL && channel.topic.is_some() =>
            {
                channel.topic.clone()
            }
            _ => None,
        })
        .await;
    match held {
        Some(topic) if topic.text == CHANGED => report.pass(
            "topic held on the channel",
            &format!(
                "{} (set by {})",
                topic.text,
                topic.set_by.unwrap_or_default()
            ),
        ),
        Some(topic) => report.fail(
            "topic held on the channel",
            &format!("the channel holds {:?}", topic.text),
        ),
        None => report.fail("topic held on the channel", "the channel holds no topic"),
    }
}

/// The same command where the server says no. Every channel ergo makes is `+t`,
/// so a topic typed in one this client does not hold `+o` in draws a `482` —
/// and a numeric nobody turns into a sentence is a command that silently does
/// nothing. The invite control's own `482` is verified in the application; this
/// is the same numeric arriving for a different command.
async fn a_topic_refused_says_why(report: &mut Report, live: &mut Live) {
    live.submit(CHANNEL, "/topic something this client may not set")
        .await;

    match live
        .said(PATIENCE, |message| {
            message.text.contains("channel operator status")
        })
        .await
    {
        Some(message) => report.pass("topic refused", &message.text),
        None => report.fail(
            "topic refused",
            "the server refused with 482 and nothing was said",
        ),
    }
}

/// #112. Libera drops `+reply`, so this is the only place the send half can be
/// seen leaving with its tag attached.
async fn a_reply_carries_its_parent(report: &mut Report, live: &mut Live, other: &mut Live) {
    other.submit(CHANNEL, "a line to answer").await;
    let Some(parent) = live
        .said(PATIENCE, |message| message.text == "a line to answer")
        .await
    else {
        report.fail("reply", "the other client's line never arrived");
        return;
    };
    let msgid = parent.id.clone();

    live.reply(CHANNEL, "answering it", &msgid).await;
    match live
        .sent(PATIENCE, |line| line.contains(&format!("+reply={msgid}")))
        .await
    {
        Some(line) => report.pass("reply", &line),
        None => report.fail("reply", "no outgoing line carried +reply"),
    }
}

/// #108. The same question for a reaction, which rides a `TAGMSG` instead.
async fn a_reaction_goes_out_as_a_tagmsg(report: &mut Report, live: &mut Live) {
    let Some(message) = live.seen_message(|message| message.text == "a line to answer") else {
        report.fail("reaction", "nothing to react to");
        return;
    };
    let msgid = message.id.clone();

    live.submit(CHANNEL, &format!("/react {msgid} \u{1f44d}"))
        .await;
    match live
        .sent(PATIENCE, |line| {
            line.contains("TAGMSG") && line.contains("+draft/react")
        })
        .await
    {
        Some(line) => report.pass("reaction", &line),
        None => report.fail("reaction", "no TAGMSG carried +draft/react"),
    }
}

/// #90. The annotator has a test for every part and had never run inside a
/// session. Saying a temperature is what makes `units` answer.
async fn an_annotator_sees_what_arrives(report: &mut Report, live: &mut Live, other: &mut Live) {
    other.submit(CHANNEL, "it is 72F outside").await;
    let noted = live
        .wait(PATIENCE, |event| match event {
            IrcxEvent::MessageAnnotated { plugin, text, .. } => {
                Some((plugin.clone(), text.clone()))
            }
            _ => None,
        })
        .await;

    match noted {
        Some((plugin, text)) => report.pass("annotator", &format!("{plugin}: {text}")),
        None => report.fail(
            "annotator",
            "no note came back — the plugin ran on nothing, or not at all",
        ),
    }
}

/// #90's third extension point, and the thing its unit tests cannot reach: an
/// arrival driving a rule, the raise reaching the archive, and the badge going
/// loud — every layer, in the order they really run.
///
/// Both halves matter. `deploys` has to raise the failure, and it has to leave
/// the line beside it alone: a rule that raises everything is one the user
/// turns off.
async fn a_rule_raises_what_it_was_asked_about(
    report: &mut Report,
    live: &mut Live,
    bot: &mut Live,
) {
    bot.submit(CHANNEL, "starting a build of main").await;
    bot.submit(CHANNEL, "deploy failed on main").await;

    let raised = live
        .wait(PATIENCE, |event| match event {
            IrcxEvent::MessageRaised {
                plugin, message, ..
            } => Some((plugin.clone(), message.clone())),
            _ => None,
        })
        .await;

    let Some((plugin, message)) = raised else {
        report.fail(
            "rule",
            "nothing was raised — the rule ran on nothing, or not at all",
        );
        return;
    };
    report.pass("rule", &format!("{plugin} raised {message}"));

    // The raise arrives after the message is drawn, so the badge moves a beat
    // later. That it moves at all is the whole of what a rule is for.
    let loud = live
        .wait(PATIENCE, |event| match event {
            IrcxEvent::ChannelUpdated { channel } if channel.name == CHANNEL => {
                (channel.highlights > 0).then_some(channel.highlights)
            }
            _ => None,
        })
        .await;

    match loud {
        Some(count) => report.pass("rule", &format!("the channel went loud: {count}")),
        None => report.fail("rule", "the raise never reached the channel's count"),
    }

    // The message the rule passed over must not have been raised too. Only one
    // of the two lines said anything failed.
    let again = live
        .wait(Duration::from_secs(2), |event| match event {
            IrcxEvent::MessageRaised { message: id, .. } if *id != message => Some(id.clone()),
            _ => None,
        })
        .await;

    match again {
        Some(id) => report.fail(
            "rule",
            &format!("it also raised {id}, which said nothing failed"),
        ),
        None => report.pass("rule", "the build starting was left alone"),
    }
}

/// #219. The capability was negotiated on every connection and never used.
///
/// The gap is made by parting: what the other client says meanwhile reached no
/// socket of ours, so a copy of it can only have come back from the server.
/// Libera has no history to ask for, which is why this step is here.
async fn a_backfill_fills_the_gap(report: &mut Report, live: &mut Live, other: &mut Live) {
    const MISSED: &str = "said while nobody was here";

    live.submit(CHANNEL, "/part").await;
    let parted = live
        .wait(PATIENCE, |event| match event {
            IrcxEvent::ChannelUpdated { channel } if channel.name == CHANNEL && !channel.joined => {
                Some(())
            }
            _ => None,
        })
        .await;
    if parted.is_none() {
        report.fail("backfill", "never left the channel, so there is no gap");
        return;
    }

    // The echo rather than the outgoing line: the line only says this client
    // wrote it, and rejoining before the server has read it makes the message
    // live and the step meaningless. The echo is the server having it.
    other.submit(CHANNEL, MISSED).await;
    let echoed = other
        .wait(PATIENCE, |event| match event {
            IrcxEvent::MessageUpdated { message }
                if message.text == MISSED && message.delivery == Delivery::Delivered =>
            {
                Some(())
            }
            _ => None,
        })
        .await;
    if echoed.is_none() {
        report.fail("backfill", "the server never took the other client's line");
        return;
    }

    if !live.join(CHANNEL).await {
        report.fail("backfill", "never rejoined the channel");
        return;
    }

    // Asserted separately from the answer: ergo can replay a channel on join by
    // itself, and a pass that came from its own setting would say nothing about
    // whether ircx ever asks.
    //
    // `AFTER` rather than any `CHATHISTORY`, because the first join of the run
    // asked for the latest page and that line is still in the transcript. Only
    // a rejoin with an archive behind it produces this one.
    match live
        .sent(PATIENCE, |line| line.starts_with("CHATHISTORY AFTER"))
        .await
    {
        Some(line) => report.pass("backfill request", &line),
        None => report.fail("backfill request", "no CHATHISTORY line went out"),
    }

    let missed = live.said(PATIENCE, |message| message.text == MISSED).await;
    match missed {
        Some(message) if message.source == MessageSource::ServerHistory => report.pass(
            "backfill",
            &format!("{} came back as history", message.text),
        ),
        Some(message) => report.fail(
            "backfill",
            &format!("it arrived as {:?} rather than history", message.source),
        ),
        None => report.fail("backfill", "what was said in the gap never came back"),
    }
}

/// A hook dropped for failing, and asked again once the plugin is repaired.
///
/// The clearing is unit tested at both ends — the strikes go when
/// `PluginChanged` arrives, and installing sends it — and until this the two
/// had never run together over a real connection. What that leaves is the
/// question the unit tests cannot ask: after three real failures against a real
/// server, does a repaired plugin actually answer again without a restart.
///
/// The plugin is written here rather than kept in `examples/`, because what it
/// is for is throwing. Installing over it is the repair a user makes: it is the
/// same call the sheet makes, and it replaces the code on disk.
async fn a_dropped_hook_comes_back(
    report: &mut Report,
    live: &mut Live,
    other: &mut Live,
    runtime: Option<&PluginRuntime>,
    room: &Path,
) {
    let Some(runtime) = runtime else {
        report.fail("repair", "no plugin library, so nothing could be broken");
        return;
    };

    let source = room.join("flaky-source");
    let grants = Grants {
        permissions: [Permission::AnnotateMessages, Permission::AccessChannels]
            .into_iter()
            .collect(),
        channels: vec![CHANNEL.into()],
        hosts: Vec::new(),
    };
    let install = |body: &str| -> Result<(), String> {
        std::fs::create_dir_all(&source).map_err(|error| error.to_string())?;
        std::fs::write(
            source.join("plugin.json"),
            r#"{"id":"flaky","name":"Flaky","version":"1.0.0",
               "description":"Throws until it is repaired","entry":"main.js",
               "annotates":true,
               "permissions":["annotate-messages","access-channels"],
               "channels":["*"]}"#,
        )
        .map_err(|error| error.to_string())?;
        std::fs::write(source.join("main.js"), body).map_err(|error| error.to_string())?;
        runtime
            .install(&source)
            .map_err(|error| error.to_string())?;
        runtime
            .set_grants("flaky", grants.clone())
            .map_err(|error| error.to_string())?;
        Ok(())
    };

    if let Err(error) = install("ircx.annotate(() => { throw new Error('broken on purpose'); });") {
        report.fail(
            "repair",
            &format!("could not install the broken one: {error}"),
        );
        return;
    }

    // One strike per batch, so the drop needs `HOOK_STRIKES` separate arrivals.
    for round in 0..3 {
        other
            .submit(CHANNEL, &format!("breaking it, {round}"))
            .await;
        let stopped = live
            .wait(Duration::from_secs(3), |event| match event {
                IrcxEvent::MessagesAppended { messages, .. } => messages
                    .iter()
                    .find(|message| message.text.contains("stopped asking it"))
                    .map(|message| message.text.clone()),
                _ => None,
            })
            .await;
        if let Some(text) = stopped {
            report.pass(
                "repair",
                &format!("dropped after {} said: {text}", round + 1),
            );
            break;
        }
        if round == 2 {
            report.fail(
                "repair",
                "three failures in a row and the hook was not dropped",
            );
            return;
        }
    }

    // Repaired, and installed over the broken one exactly as the sheet does.
    if let Err(error) =
        install("ircx.annotate((m) => m.text.includes('mended') ? 'mended' : undefined);")
    {
        report.fail(
            "repair",
            &format!("could not install the repaired one: {error}"),
        );
        return;
    }
    live.send(SessionCommand::PluginChanged {
        plugin: "flaky".into(),
    })
    .await;

    other.submit(CHANNEL, "mended now").await;
    let noted = live
        .wait(PATIENCE, |event| match event {
            IrcxEvent::MessageAnnotated { plugin, text, .. } if plugin == "flaky" => {
                Some(text.clone())
            }
            _ => None,
        })
        .await;

    match noted {
        Some(text) => report.pass(
            "repair",
            &format!("answering again without a restart: {text}"),
        ),
        None => report.fail(
            "repair",
            "the repaired plugin was never asked again — the strikes outlived the install",
        ),
    }
}

fn config(network: &str, nick: &str) -> SessionConfig {
    SessionConfig {
        network: network.into(),
        name: "ergo".into(),
        host: HOST.into(),
        port: PORT,
        tls: false,
        tls_verify: false,
        nick: nick.into(),
        alt_nicks: Vec::new(),
        username: "ircxdrive".into(),
        realname: "ircx verification run".into(),
        sasl: None,
        connect_commands: Vec::new(),
        autojoin: Vec::new(),
    }
}

// Plumbing.

struct Live {
    handle: Option<NetworkHandle>,
    commands: mpsc::Sender<SessionCommand>,
    events: mpsc::Receiver<IrcxEvent>,
    messages: Vec<ChatMessage>,
    outgoing: Vec<String>,
    /// Both directions in order, so a failed step can be read rather than
    /// guessed at.
    transcript: Vec<String>,
}

impl Live {
    fn start(
        config: SessionConfig,
        store: Arc<Store>,
        plugins: Option<Arc<PluginRuntime>>,
    ) -> Self {
        let (sender, events) = mpsc::channel(16384);
        let handle = spawn_network_with_plugins(config, store, sender, plugins);
        let commands = handle.commands();
        Self {
            handle: Some(handle),
            commands,
            events,
            messages: Vec::new(),
            outgoing: Vec::new(),
            transcript: Vec::new(),
        }
    }

    async fn send(&self, command: SessionCommand) {
        if self.commands.send(command).await.is_err() {
            println!("FAIL  the session task stopped taking commands");
        }
    }

    /// Waits for the channel to actually be joined, which is what tells a
    /// command sent into it from one the server will answer with `442`.
    async fn join(&mut self, channel: &str) -> bool {
        self.send(SessionCommand::Join {
            channel: channel.into(),
            key: None,
        })
        .await;
        self.wait(PATIENCE, |event| match event {
            IrcxEvent::ChannelUpdated { channel: seen } if seen.name == channel && seen.joined => {
                Some(())
            }
            _ => None,
        })
        .await
        .is_some()
    }

    async fn submit(&self, target: &str, input: &str) {
        let (reply, _) = tokio::sync::oneshot::channel();
        self.send(SessionCommand::Submit {
            target: target.into(),
            input: input.into(),
            reply_to: None,
            reply,
        })
        .await;
    }

    async fn reply(&self, target: &str, input: &str, parent: &str) {
        let (reply, _) = tokio::sync::oneshot::channel();
        self.send(SessionCommand::Submit {
            target: target.into(),
            input: input.into(),
            reply_to: Some(parent.into()),
            reply,
        })
        .await;
    }

    /// Reads events until `pick` matches or `limit` runs out, keeping every
    /// message and outgoing line that goes past on the way.
    async fn wait<T>(
        &mut self,
        limit: Duration,
        mut pick: impl FnMut(&IrcxEvent) -> Option<T>,
    ) -> Option<T> {
        let deadline = Instant::now() + limit;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            let Ok(Some(event)) = timeout(left, self.events.recv()).await else {
                return None;
            };
            let found = pick(&event);
            self.record(event);
            if found.is_some() {
                return found;
            }
        }
    }

    async fn said(
        &mut self,
        limit: Duration,
        mut pick: impl FnMut(&ChatMessage) -> bool,
    ) -> Option<ChatMessage> {
        self.wait(limit, |event| match event {
            IrcxEvent::MessagesAppended { messages, .. } => {
                messages.iter().find(|message| pick(message)).cloned()
            }
            _ => None,
        })
        .await
    }

    async fn sent(
        &mut self,
        limit: Duration,
        mut pick: impl FnMut(&str) -> bool,
    ) -> Option<String> {
        if let Some(line) = self.outgoing.iter().find(|line| pick(line)).cloned() {
            return Some(line);
        }
        self.wait(limit, |event| match event {
            IrcxEvent::RawLine {
                outgoing: true,
                line,
                ..
            } if pick(line) => Some(line.clone()),
            _ => None,
        })
        .await
    }

    fn seen_message(&self, mut pick: impl FnMut(&ChatMessage) -> bool) -> Option<ChatMessage> {
        self.messages.iter().rev().find(|m| pick(m)).cloned()
    }

    fn record(&mut self, event: IrcxEvent) {
        match event {
            IrcxEvent::RawLine { outgoing, line, .. } => {
                self.transcript
                    .push(format!("{} {line}", if outgoing { ">" } else { "<" }));
                if outgoing {
                    self.outgoing.push(line);
                }
            }
            IrcxEvent::MessagesAppended { messages, .. } => self.messages.extend(messages),
            _ => {}
        }
    }

    async fn stop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let quit = handle.shutdown(Some("ircx verification run".into()));
            let _ = timeout(Duration::from_secs(5), quit).await;
        }
    }
}

/// A diagnostic, not an assertion: a step that fails is printed and the run
/// carries on, so one broken thing does not hide the next.
#[derive(Default)]
struct Report {
    passed: usize,
    failed: Vec<String>,
}

impl Report {
    fn pass(&mut self, what: &str, detail: &str) {
        self.passed += 1;
        println!("PASS  {what}: {detail}");
    }

    fn fail(&mut self, what: &str, detail: &str) {
        self.failed.push(format!("{what}: {detail}"));
        println!("FAIL  {what}: {detail}");
    }

    fn failed(&self) -> bool {
        !self.failed.is_empty()
    }

    fn finish(&self) {
        println!("\n{} passed, {} failed", self.passed, self.failed.len());
        for failure in &self.failed {
            println!("  {failure}");
        }
        assert!(
            self.failed.is_empty(),
            "{} step(s) failed",
            self.failed.len()
        );
    }
}
