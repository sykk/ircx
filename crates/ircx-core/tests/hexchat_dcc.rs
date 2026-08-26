//! Drives DCC against HexChat, which is a different implementation of the
//! protocol and the only thing that can answer whether ircx reads it the same
//! way. Everything else in the suite is ircx against ircx, which agrees with
//! itself by construction.
//!
//! Ignored by default so `cargo test --workspace` never dials anything or
//! starts a window:
//!
//! ```text
//! cargo test -p ircx-core --test hexchat_dcc -- --ignored --nocapture
//! ```
//!
//! It needs three things running, and `scripts/dcc-interop.sh` starts all of
//! them:
//!
//! ```text
//! ergo    on 127.0.0.1:6699, plaintext
//! Xvfb    on the DISPLAY this runs with
//! hexchat on that display, connected to that server, as the nick in IRCX_DCC_PEER
//! ```
//!
//! HexChat is driven by `hexchat -e -c`, which sends the command over D-Bus to
//! the running instance, so `DBUS_SESSION_BUS_ADDRESS` and `DISPLAY` have to
//! name the session it is running in.
//!
//! What this does not cover is where a received file lands and what it is
//! called. That is `src-tauri/src/transfers.rs`, above this layer and unit
//! tested there; here the path is chosen by the test so that the assertions are
//! about the protocol.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use ircx_core::{spawn_network, NetworkHandle, SessionCommand, SessionConfig};
use ircx_ipc::{ConnectionStatus, IrcxEvent, Transfer, TransferState};
use ircx_net::dcc::partial;
use ircx_store::Store;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{timeout, Instant};

/// Long enough for a loopback transfer of a few hundred kilobytes and for
/// HexChat to notice a message; short enough that a rig which is not running
/// fails the run rather than hanging it.
const PATIENCE: Duration = Duration::from_secs(30);

fn host() -> String {
    std::env::var("IRCX_DCC_HOST").unwrap_or_else(|_| "127.0.0.1".into())
}

fn port() -> u16 {
    std::env::var("IRCX_DCC_PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(6699)
}

/// The nick HexChat is registered under.
fn peer() -> String {
    std::env::var("IRCX_DCC_PEER").unwrap_or_else(|_| "hexer".into())
}

/// Where the rig put its files: `files/` to send, `hexchat-downloads/` for what
/// HexChat received.
fn lab() -> PathBuf {
    PathBuf::from(std::env::var("IRCX_DCC_LAB").expect("IRCX_DCC_LAB names the rig's directory"))
}

/// Runs one command in the HexChat that is already up.
fn hexchat(command: &str) {
    let status = Command::new("hexchat")
        .args(["-e", "-c", command])
        .status()
        .expect("hexchat is on PATH");
    assert!(status.success(), "hexchat refused `{command}`");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the rig in scripts/dcc-interop.sh"]
async fn receives_a_file_hexchat_sends() {
    let room = tempfile::tempdir().expect("a temporary directory");
    let mut live = Live::start(room.path()).await;
    let landing = room.path().join("holiday.bin");
    let source = lab().join("files/from-hexchat.bin");

    hexchat(&format!(
        "dcc send {} {}",
        live.nick,
        source.to_string_lossy()
    ));

    let offer = live.offered().await;
    assert_eq!(offer.size, size_of_file(&source));
    live.accept(&offer.id, &landing, 0).await;
    let done = live.settled(&offer.id).await;

    assert_eq!(done.state, TransferState::Done, "{:?}", done.failure);
    assert_eq!(
        std::fs::read(&landing).expect("the received file"),
        std::fs::read(&source).expect("the sent file"),
        "the file HexChat sent is the file that landed"
    );
    live.stop().await;
}

/// The round trip that resume is: this client says how much it already holds,
/// HexChat agrees to skip it, and what arrives is the rest.
///
/// The part file is written by the test rather than left by an interrupted
/// transfer. Interrupting one is ircx's own business and is covered by
/// `ircx-net`'s tests; what needs a second implementation is whether HexChat
/// answers a `DCC RESUME` and starts where it said it would. Doing it this way
/// also removes a race that has nothing to do with the question: on loopback a
/// few hundred kilobytes arrive faster than a cancel can be sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the rig in scripts/dcc-interop.sh"]
async fn resumes_a_file_hexchat_sends() {
    let room = tempfile::tempdir().expect("a temporary directory");
    let mut live = Live::start(room.path()).await;
    let landing = room.path().join("holiday.bin");
    let source = lab().join("files/from-hexchat.bin");
    let whole = std::fs::read(&source).expect("the file to send");

    // What an interrupted transfer would have left: the first part of the
    // file, under the name a part file has.
    let held = 150_000;
    std::fs::write(partial(&landing), &whole[..held as usize]).expect("a part file");

    hexchat(&format!(
        "dcc send {} {}",
        live.nick,
        source.to_string_lossy()
    ));
    let offer = live.offered().await;
    live.accept(&offer.id, &landing, held).await;
    let done = live.settled(&offer.id).await;

    assert_eq!(done.state, TransferState::Done, "{:?}", done.failure);
    assert_eq!(
        std::fs::read(&landing).expect("the received file"),
        whole,
        "a resumed file is the whole file, not the tail written over the head"
    );
    assert!(
        done.at > held,
        "and the transfer carried on from {held} rather than starting again"
    );
    live.stop().await;
}

/// The other direction. HexChat is set to accept without asking, so what is
/// under test is the offer this client makes and the bytes behind it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the rig in scripts/dcc-interop.sh"]
async fn sends_a_file_hexchat_takes() {
    let room = tempfile::tempdir().expect("a temporary directory");
    let mut live = Live::start(room.path()).await;
    let source = lab().join("files/from-ircx.bin");
    let landing = lab().join("hexchat-downloads/from-ircx.bin");
    let _ = std::fs::remove_file(&landing);

    let offered = live.offer(&source).await;
    let done = live.settled(&offered.id).await;

    assert_eq!(done.state, TransferState::Done, "{:?}", done.failure);
    assert_eq!(done.at, size_of_file(&source));
    assert_eq!(
        std::fs::read(&landing).expect("the file HexChat received"),
        std::fs::read(&source).expect("the sent file"),
        "the file this client sent is the file HexChat wrote"
    );
    live.stop().await;
}

/// The answering side of a resume, which is the half the other tests do not
/// reach: HexChat holds part of the file already and asks this client to skip
/// what it has.
///
/// The rig sets HexChat to save and resume without asking, so seeding its
/// download directory with the head of the file is what makes it ask.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs the rig in scripts/dcc-interop.sh"]
async fn answers_a_resume_hexchat_asks_for() {
    let room = tempfile::tempdir().expect("a temporary directory");
    let mut live = Live::start(room.path()).await;
    let source = lab().join("files/from-ircx.bin");
    let landing = lab().join("hexchat-downloads/from-ircx.bin");
    let whole = std::fs::read(&source).expect("the file to send");

    let held = 120_000;
    std::fs::write(&landing, &whole[..held]).expect("what HexChat already holds");

    let offered = live.offer(&source).await;
    let done = live.settled(&offered.id).await;

    assert_eq!(done.state, TransferState::Done, "{:?}", done.failure);
    assert_eq!(
        std::fs::read(&landing).expect("the file HexChat received"),
        whole,
        "what HexChat ends up with is the whole file"
    );
    // `at` is a position in the file rather than a count of what was sent, so a
    // resumed send still ends at the size. What says only the tail went is
    // where it started: the first byte reported as moving is past what HexChat
    // already held.
    assert!(
        live.first_moving(&offered.id) >= held as u64,
        "this client sent only the rest of it, not all of it again"
    );
    live.stop().await;
}

fn size_of_file(path: &Path) -> u64 {
    std::fs::metadata(path)
        .unwrap_or_else(|error| panic!("{} could not be read: {error}", path.display()))
        .len()
}

struct Live {
    handle: Option<NetworkHandle>,
    commands: mpsc::Sender<SessionCommand>,
    events: mpsc::Receiver<IrcxEvent>,
    nick: String,
    /// Every transfer update seen, so a state reached between two waits is not
    /// missed by the one that comes after it.
    seen: Vec<Transfer>,
}

impl Live {
    async fn start(room: &Path) -> Self {
        let store = Arc::new(Store::open(&room.join("ircx.sqlite3")).expect("a temporary archive"));
        let nick = "ircx".to_string();
        let (sender, events) = mpsc::channel(4096);
        let handle = spawn_network(
            SessionConfig {
                network: "lab".into(),
                name: "lab".into(),
                host: host(),
                port: port(),
                tls: false,
                tls_verify: false,
                socks5_proxy: None,
                client_certificate: None,
                nick: nick.clone(),
                alt_nicks: Vec::new(),
                username: "ircxdcc".into(),
                realname: "ircx DCC interop".into(),
                sasl: None,
                connect_commands: Vec::new(),
                autojoin: Vec::new(),
            },
            store,
            sender,
        );
        let commands = handle.commands();
        let mut live = Self {
            handle: Some(handle),
            commands,
            events,
            nick,
            seen: Vec::new(),
        };
        live.registered().await;
        live
    }

    async fn send(&self, command: SessionCommand) {
        self.commands.send(command).await.expect("the session task");
    }

    async fn registered(&mut self) {
        self.wait("registration", |event| match event {
            IrcxEvent::ConnectionChanged {
                status: ConnectionStatus::Connected,
                ..
            } => Some(()),
            _ => None,
        })
        .await;
    }

    /// The next offer to arrive, or one already seen and not yet answered.
    async fn offered(&mut self) -> Transfer {
        if let Some(held) = self
            .seen
            .iter()
            .rev()
            .find(|transfer| transfer.state == TransferState::Offered)
        {
            return held.clone();
        }
        self.wait("an offer", |event| match event {
            IrcxEvent::TransferUpdated { transfer } if transfer.state == TransferState::Offered => {
                Some(transfer.as_ref().clone())
            }
            _ => None,
        })
        .await
    }

    async fn accept(&mut self, id: &str, landing: &Path, resume_from: u64) {
        let (reply, answer) = oneshot::channel();
        self.send(SessionCommand::AcceptTransfer {
            id: id.to_string(),
            path: landing.to_path_buf(),
            resume_from,
            ports: None,
            address: "127.0.0.1".parse().expect("a loopback address"),
            reply,
        })
        .await;
        answer
            .await
            .expect("the session answered")
            .expect("the offer was accepted");
    }

    async fn offer(&mut self, source: &Path) -> Transfer {
        let (reply, answer) = oneshot::channel();
        self.send(SessionCommand::OfferFile {
            nick: peer(),
            path: source.to_path_buf(),
            file: source
                .file_name()
                .expect("a file name")
                .to_string_lossy()
                .into_owned(),
            size: size_of_file(source),
            ports: None,
            address: "127.0.0.1".parse().expect("a loopback address"),
            passive: false,
            reply,
        })
        .await;
        answer
            .await
            .expect("the session answered")
            .expect("the file was offered")
    }

    /// Where this transfer was when it first reported moving, which is what
    /// says whether a resume was honoured on this side.
    fn first_moving(&self, id: &str) -> u64 {
        self.seen
            .iter()
            .find(|transfer| transfer.id == id && transfer.state == TransferState::Running)
            .map(|transfer| transfer.at)
            .expect("the transfer was seen moving")
    }

    /// Waits until this transfer has stopped, however it stopped.
    async fn settled(&mut self, id: &str) -> Transfer {
        if let Some(held) = self
            .seen
            .iter()
            .rev()
            .find(|transfer| transfer.id == id && is_over(transfer.state))
        {
            return held.clone();
        }
        let wanted = id.to_string();
        self.wait("the transfer to end", move |event| match event {
            IrcxEvent::TransferUpdated { transfer }
                if transfer.id == wanted && is_over(transfer.state) =>
            {
                Some(transfer.as_ref().clone())
            }
            _ => None,
        })
        .await
    }

    /// Reads events until one answers, recording every transfer update on the
    /// way so a later wait can look back at what it walked past.
    async fn wait<T>(
        &mut self,
        what: &str,
        mut answered: impl FnMut(&IrcxEvent) -> Option<T>,
    ) -> T {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let event = timeout(left, self.events.recv())
                .await
                .unwrap_or_else(|_| panic!("waited {PATIENCE:?} for {what}"))
                .expect("the event channel stayed open");
            if let IrcxEvent::TransferUpdated { transfer } = &event {
                self.seen.push(transfer.as_ref().clone());
            }
            if let Some(found) = answered(&event) {
                return found;
            }
        }
    }

    async fn stop(mut self) {
        if let Some(handle) = self.handle.take() {
            handle.shutdown(Some("interop run finished".into())).await;
        }
    }
}

fn is_over(state: TransferState) -> bool {
    matches!(
        state,
        TransferState::Done
            | TransferState::Declined
            | TransferState::Cancelled
            | TransferState::Failed
    )
}
