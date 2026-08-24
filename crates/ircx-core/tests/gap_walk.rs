//! What a gap too wide to fetch whole does against a real server. #520.
//!
//! Ignored by default so `cargo test --workspace` never dials anything:
//!
//! ```text
//! cargo test -p ircx-core --test gap_walk -- --ignored --nocapture
//! ```
//!
//! Every defect this client has had in this area came back from a server rather
//! than from a test: the resume point poisoned by live traffic (#239), the
//! message lost inside a shared millisecond (#253), the label a page back is
//! matched on (#472). None of them could be produced by a fake, because what
//! produced them was a real batch arriving beside real traffic.
//!
//! The server this needs is its own, because the walk is only interesting past
//! the cap and the cap is ten pages: against the 1000 ergo advertises by
//! default that is two thousand messages before anything under test happens.
//! With `chathistory-maxmessages: 5` it is fifty, and seventy lines is a gap
//! wider than the budget with room for a hole in the middle.
//!
//! ```text
//! sed -e 's/chathistory-maxmessages: 1000/chathistory-maxmessages: 5/' \
//!     -e 's/6667/6687/' ircd.yaml > ircd-6687.yaml   # and fakelag off
//! ergo initdb --conf ircd-6687.yaml && ergo run --conf ircd-6687.yaml
//! ```

use std::sync::Arc;
use std::time::{Duration, Instant};

use ircx_core::{spawn_network, NetworkHandle, SessionCommand, SessionConfig};
use ircx_ipc::{ChatMessage, ConnectionStatus, Delivery, IrcxEvent};
use ircx_store::Store;
use tokio::sync::mpsc;
use tokio::time::timeout;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 6687;
const CHANNEL: &str = "#gap";
/// Wider than the fifty messages the whole budget can fetch, by enough that
/// neither half of the walk can reach across what is left.
const FLOOD: usize = 70;
const PATIENCE: Duration = Duration::from_secs(20);
/// The flood is paced by this client's own rate limiter — half a second a line
/// once the burst allowance is out — so saying it takes about as long as the
/// server would make a real one take.
const FLOODING: Duration = Duration::from_secs(120);

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs an ergo on 127.0.0.1:6687 with chathistory-maxmessages: 5"]
async fn a_gap_wider_than_the_budget() {
    let mut report = Report::default();
    let room = tempfile::tempdir().expect("a temporary directory");
    let archive = match Store::open(&room.path().join("ircx.sqlite3")) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            report.fail("archive", &format!("Store::open failed: {error}"));
            return report.finish();
        }
    };
    let elsewhere = match Store::open(&room.path().join("talker.sqlite3")) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            report.fail("archive", &format!("second Store::open failed: {error}"));
            return report.finish();
        }
    };

    // The reader, here long enough to archive where the conversation had got
    // to. That watermark is the whole premise: without one the rejoin is a
    // conversation met for the first time rather than a gap.
    let mut reader = Live::start(config("gap", "ircx-gap"), Arc::clone(&archive));
    let mut talker = Live::start(config("talk", "ircx-talk"), elsewhere);
    if !reader.registered().await || !talker.registered().await {
        report.fail("connect", "no 001 from the server on 6687");
        return report.finish();
    }
    reader.join(CHANNEL).await;
    talker.join(CHANNEL).await;
    talker.submit(CHANNEL, "where the reader left off").await;
    if reader
        .said(PATIENCE, |message| {
            message.text == "where the reader left off"
        })
        .await
        .is_none()
    {
        report.fail("watermark", "the reader never saw the line it left on");
        return report.finish();
    }
    reader.stop().await;

    // ...and away, while the channel says more than the client can catch up on.
    for line in 1..=FLOOD {
        talker.submit(CHANNEL, &format!("line {line:03}")).await;
    }
    // The echo, not the write. An outgoing `RawLine` is emitted as the line is
    // queued, so waiting for one says the client meant to send it and nothing
    // about the server having it — and a reader that reconnects into the middle
    // of the flood is handed the rest of it live, which is not a gap at all.
    if talker
        .delivered(FLOODING, &format!("line {FLOOD:03}"))
        .await
        .is_none()
    {
        report.fail("flood", "the last line was never echoed back");
        return report.finish();
    }

    // Back, against the same archive, which is what makes this a gap.
    let mut reader = Live::start(config("gap", "ircx-gap"), archive);
    if !reader.registered().await {
        report.fail("reconnect", "no 001 the second time");
        return report.finish();
    }
    reader.join(CHANNEL).await;
    let stopped = reader
        .said(PATIENCE, |message| message.text.contains("moved faster"))
        .await;

    // Named on the request, because a reconnect also asks `CHATHISTORY TARGETS`
    // — which conversations were spoken in while nobody was here — and that is
    // a question about every conversation rather than about this one.
    let walk: Vec<String> = reader
        .outgoing
        .iter()
        .filter(|line| line.starts_with("CHATHISTORY") && line.contains(CHANNEL))
        .map(|line| line.split_whitespace().nth(1).unwrap_or("?").to_string())
        .collect();
    for line in reader.outgoing.iter().filter(|line| line.contains(CHANNEL)) {
        println!("      > {line}");
    }
    let expected = ["AFTER", "AFTER", "AFTER", "AFTER", "AFTER"]
        .into_iter()
        .chain(["LATEST"])
        .chain(["BEFORE"; 4])
        .collect::<Vec<_>>();
    match walk == expected {
        true => report.pass("the walk", &format!("{walk:?}")),
        false => report.fail("the walk", &format!("{walk:?}, wanted {expected:?}")),
    }

    // A page a reader scrolled for is matched to them on its label. Nobody is
    // waiting on these, and an answer that carried one would be taken for an
    // answer to somebody.
    let labelled = reader
        .outgoing
        .iter()
        .filter(|line| line.contains("CHATHISTORY BEFORE") && line.contains("@label="))
        .count();
    match labelled {
        0 => report.pass("bare requests", "no BEFORE went out under a label"),
        n => report.fail("bare requests", &format!("{n} of them carried one")),
    }

    let held = lines_held(&reader.messages);
    match (held.first(), held.last()) {
        (Some(&first), Some(&last)) => report.pass(
            "what came back",
            &format!("{} messages, line {first:03} to line {last:03}", held.len()),
        ),
        _ => report.fail("what came back", "no numbered lines arrived at all"),
    }
    // The near end is the half the old walk lost: it spent the whole budget
    // going forward and stopped a hundred lines short of what was being said.
    match held.last() {
        Some(&FLOOD) => report.pass("the near end", &format!("line {FLOOD:03} is held")),
        other => report.fail(
            "the near end",
            &format!("the newest line held is {other:?}"),
        ),
    }

    let holes: Vec<(usize, usize)> = held
        .windows(2)
        .filter(|pair| pair[1] > pair[0] + 1)
        .map(|pair| (pair[0], pair[1]))
        .collect();
    let Some(&(above, below)) = holes.first() else {
        report.fail(
            "the hole",
            "the flood came back whole, so nothing was capped",
        );
        return report.finish();
    };
    match holes.len() {
        1 => report.pass(
            "the hole",
            &format!("one, between line {above:03} and line {below:03}"),
        ),
        n => report.fail("the hole", &format!("{n} of them: {holes:?}")),
    }

    // The half a reader meets. Said at the bottom of the conversation it
    // explains a discontinuity they have already read across.
    match stopped {
        None => report.fail("the sentence", "the cap said nothing"),
        Some(said) => {
            let at = said.timestamp.as_str();
            let ends = |line: usize| {
                reader
                    .messages
                    .iter()
                    .find(|message| message.text == format!("line {line:03}"))
                    .map(|message| message.timestamp.clone())
            };
            match (ends(above), ends(below)) {
                (Some(over), Some(under)) if over.as_str() < at && at < under.as_str() => report
                    .pass(
                        "the sentence",
                        &format!("drawn between line {above:03} and line {below:03}"),
                    ),
                (over, under) => report.fail(
                    "the sentence",
                    &format!("stamped {at}, between {over:?} and {under:?}"),
                ),
            }
        }
    }

    reader.stop().await;
    talker.stop().await;
    report.finish();
}

/// The flood's own lines, in order, as numbers. Everything else the channel
/// carries — the joins, the line the reader left on, the sentence itself — is
/// not part of the sequence a hole is a hole in.
fn lines_held(messages: &[ChatMessage]) -> Vec<usize> {
    let mut held: Vec<usize> = messages
        .iter()
        .filter_map(|message| message.text.strip_prefix("line "))
        .filter_map(|number| number.parse().ok())
        .collect();
    held.sort_unstable();
    held.dedup();
    held
}

fn config(network: &str, nick: &str) -> SessionConfig {
    SessionConfig {
        network: network.into(),
        name: "ergo".into(),
        host: HOST.into(),
        port: PORT,
        tls: false,
        tls_verify: false,
        socks5_proxy: None,
        client_certificate: None,
        nick: nick.into(),
        alt_nicks: Vec::new(),
        username: "ircxgap".into(),
        realname: "ircx gap walk".into(),
        sasl: None,
        connect_commands: Vec::new(),
        autojoin: Vec::new(),
    }
}

// Plumbing. Its own rather than `ergo.rs`'s, for the reason that file gives:
// what is shared there is carried for tests this one does not run.

struct Live {
    handle: Option<NetworkHandle>,
    commands: mpsc::Sender<SessionCommand>,
    events: mpsc::Receiver<IrcxEvent>,
    messages: Vec<ChatMessage>,
    outgoing: Vec<String>,
}

impl Live {
    fn start(config: SessionConfig, store: Arc<Store>) -> Self {
        let (sender, events) = mpsc::channel(16384);
        let handle = spawn_network(config, store, sender);
        let commands = handle.commands();
        Self {
            handle: Some(handle),
            commands,
            events,
            messages: Vec::new(),
            outgoing: Vec::new(),
        }
    }

    async fn send(&self, command: SessionCommand) {
        if self.commands.send(command).await.is_err() {
            println!("FAIL  the session task stopped taking commands");
        }
    }

    async fn registered(&mut self) -> bool {
        self.wait(PATIENCE, |event| match event {
            IrcxEvent::ConnectionChanged { status, .. }
                if *status == ConnectionStatus::Connected =>
            {
                Some(())
            }
            _ => None,
        })
        .await
        .is_some()
    }

    /// The rejoin is what asks for the gap, so waiting for the channel rather
    /// than for the command to be taken is what makes the next step mean
    /// anything.
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
        if let Some(message) = self.messages.iter().find(|message| pick(message)).cloned() {
            return Some(message);
        }
        self.wait(limit, |event| match event {
            IrcxEvent::MessagesAppended { messages, .. } => {
                messages.iter().find(|message| pick(message)).cloned()
            }
            _ => None,
        })
        .await
    }

    /// Waits for the server to hand this client's own line back, which is what
    /// `echo-message` buys and the only thing that says the server has it.
    async fn delivered(&mut self, limit: Duration, text: &str) -> Option<ChatMessage> {
        self.wait(limit, |event| match event {
            IrcxEvent::MessageUpdated { message }
                if message.text == text && message.delivery == Delivery::Delivered =>
            {
                Some((**message).clone())
            }
            _ => None,
        })
        .await
    }

    fn record(&mut self, event: IrcxEvent) {
        match event {
            IrcxEvent::RawLine {
                outgoing: true,
                line,
                ..
            } => self.outgoing.push(line),
            IrcxEvent::MessagesAppended { messages, .. } => self.messages.extend(messages),
            _ => {}
        }
    }

    async fn stop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let quit = handle.shutdown(Some("ircx gap walk".into()));
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
