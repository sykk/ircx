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
use ircx_ipc::{ChatMessage, ConnectionStatus, IrcxEvent, MessageKind};
use ircx_store::Store;
use tokio::sync::mpsc;
use tokio::time::timeout;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 6667;
const CHANNEL: &str = "#ircx-drive";
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

    let plugins = annotator(&mut report, room.path());
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

    if !registered(&mut report, &mut live).await || !registered(&mut report, &mut other).await {
        live.stop().await;
        other.stop().await;
        report.finish();
        return;
    }
    if !other.join(CHANNEL).await {
        report.fail("setup", "the second client never joined");
        live.stop().await;
        other.stop().await;
        report.finish();
        return;
    }

    topic_on_join(&mut report, &mut live, &mut other).await;
    a_reply_carries_its_parent(&mut report, &mut live, &mut other).await;
    a_reaction_goes_out_as_a_tagmsg(&mut report, &mut live).await;
    an_annotator_sees_what_arrives(&mut report, &mut live, &mut other).await;

    if report.failed() {
        println!("\n--- transcript");
        for line in &live.transcript {
            println!("{line}");
        }
    }

    live.stop().await;
    other.stop().await;
    report.finish();
}

/// The example plugin from `examples/plugins/units`, installed and granted the
/// channel this run uses. `None` leaves the annotator step to report that it
/// could not run rather than silently passing.
fn annotator(report: &mut Report, room: &Path) -> Option<Arc<PluginRuntime>> {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/units");
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
    if let Err(error) = runtime.install(&source) {
        report.fail("plugins", &format!("could not install units: {error}"));
        return None;
    }
    let grants = Grants {
        permissions: [Permission::AnnotateMessages, Permission::AccessChannels]
            .into_iter()
            .collect(),
        channels: vec![CHANNEL.into()],
        hosts: Vec::new(),
    };
    if let Err(error) = runtime.set_grants("units", grants) {
        report.fail("plugins", &format!("could not grant units: {error}"));
        return None;
    }
    report.pass("plugins", "units installed and granted");
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
