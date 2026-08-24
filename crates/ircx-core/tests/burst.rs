//! Times a netsplit-shaped burst through the real stack: socket, framing,
//! parse, session state and the archive write, up to the events the frontend
//! would be handed.
//!
//! `docs/measurements.md` measures the frontend halves of the same burst in
//! jsdom and says in as many words that it excludes all of the above. This is
//! that exclusion, measured. It prints a table and asserts nothing about the
//! timings — a measurement that fails the build on a slow machine is a
//! measurement nobody runs.
//!
//! Ignored by default so `cargo test --workspace` never dials anything:
//!
//! ```text
//! cargo test -p ircx-core --test burst -- --ignored --nocapture
//! ```
//!
//! Wants a local `ergo` with three changes from the shipped `default.yaml`,
//! none of which the client sees:
//!
//! ```text
//! server.listeners:   one loopback plaintext port, no :6697 and so no certificate
//! server.ip-limits:   count and throttle both false — the crowd is one address
//! fakelag.enabled:    false — the crowd registers as fast as it can
//! ```
//!
//! Those are not the settings `tests/ergo.rs` wants, and a machine can only
//! have one server on a port, so `IRCX_BURST_PORT` says where this one is.
//!
//! **It is a burst the shape of a netsplit, not a netsplit.** Nothing here
//! links two servers: the crowd is a few thousand ordinary clients whose
//! sockets close at once, so the quits carry their own reason rather than
//! `*.net *.split` and the server never sends a `NETSPLIT` batch. What is
//! being measured is the arrival rate, which is the same.

use std::sync::Arc;
use std::time::{Duration, Instant};

use ircx_core::{spawn_network, NetworkHandle, SessionCommand, SessionConfig};
use ircx_ipc::{ConnectionStatus, HistoryRequest, IrcxEvent};
use ircx_store::Store;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::timeout;

const HOST: &str = "127.0.0.1";

/// `IRCX_BURST_PORT` or 6667. A machine that already has an `ergo` on the
/// standard port — the one `tests/ergo.rs` wants — needs somewhere else to put
/// the one configured below, and a run against the wrong server looks like a
/// slow client rather than like a mistake.
fn port() -> u16 {
    std::env::var("IRCX_BURST_PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(6667)
}
/// Long enough for a loopback server under a crowd, short enough that a server
/// which is not running fails the run rather than hanging it.
const PATIENCE: Duration = Duration::from_secs(120);
const SIZES: [usize; 4] = [100, 500, 1_000, 2_500];
/// `getconf CLK_TCK`, which is 100 on every Linux this has run on.
const TICKS_PER_SECOND: u64 = 100;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs a local ergo, configured as the module comment says"]
async fn a_burst_through_the_real_stack() {
    println!("| channel | join wave | quit wave | on cpu | messages archived |");
    println!("|---|---|---|---|---|");
    for size in SIZES {
        match measure(size).await {
            Some(row) => println!("{row}"),
            None => println!("| {size} | gave up — see above |"),
        }
    }
}

/// One channel of `size` people, filled and then emptied at once.
async fn measure(size: usize) -> Option<String> {
    let room = archive_room();
    let store = Arc::new(Store::open(&room.path().join("ircx.sqlite3")).expect("an archive"));
    let channel = format!("#burst-{size}");

    let (sender, mut events) = mpsc::channel(16_384);
    let handle = spawn_network(config(&format!("burst-{size}")), Arc::clone(&store), sender);
    let commands = handle.commands();

    let registered = wait(&mut events, PATIENCE, |event| {
        matches!(
            event,
            IrcxEvent::ConnectionChanged {
                status: ConnectionStatus::Connected,
                ..
            }
        )
    })
    .await;
    if !registered {
        eprintln!(
            "{size}: never registered — is ergo running on {HOST}:{}?",
            port()
        );
        return None;
    }

    commands
        .send(SessionCommand::Join {
            channel: channel.clone(),
            key: None,
        })
        .await
        .ok()?;
    let joined = wait(&mut events, PATIENCE, |event| {
        matches!(event, IrcxEvent::ChannelUpdated { channel: seen } if seen.name == channel && seen.joined)
    })
    .await;
    if !joined {
        eprintln!("{size}: never joined {channel}");
        return None;
    }

    // The crowd connects. Each one reads and discards for as long as it is
    // here, because a channel of `size` sends every member every arrival and a
    // client that never reads is one the server disconnects for a full send
    // queue.
    let mut crowd = Vec::with_capacity(size);
    for i in 0..size {
        match Person::connect(i).await {
            Ok(person) => crowd.push(person),
            Err(error) => {
                eprintln!("{size}: crowd member {i} could not connect: {error}");
                stop(handle).await;
                return None;
            }
        }
    }

    // Everybody joins at once, having already registered. The wave is what the
    // server does with that, not what registering a few thousand clients costs.
    let started = Instant::now();
    for (i, person) in crowd.iter_mut().enumerate() {
        if let Err(error) = person.join(&channel).await {
            eprintln!("{size}: crowd member {i} could not join: {error}");
            stop(handle).await;
            return None;
        }
    }
    if !count(&mut events, PATIENCE, size, is_arrival(&channel)).await {
        eprintln!("{size}: only part of the crowd was seen arriving");
        stop(handle).await;
        return None;
    }
    let join_wave = started.elapsed();

    // Everyone stops reading before anybody leaves, so the wave below is timed
    // against a process doing nothing but being this client. What the crowd
    // has queued up unread goes with their sockets.
    let mut sockets = Vec::with_capacity(size);
    for person in crowd {
        if let Some(socket) = person.settle().await {
            sockets.push(socket);
        }
    }
    tokio::time::sleep(Duration::from_millis(250)).await;

    let on_cpu = on_cpu_ms();
    let started = Instant::now();
    drop(sockets);
    if !count(&mut events, PATIENCE, size, is_departure(&channel)).await {
        eprintln!("{size}: only part of the crowd was seen leaving");
        stop(handle).await;
        return None;
    }
    let quit_wave = started.elapsed();
    let spent = on_cpu_ms().saturating_sub(on_cpu);

    let archived = store
        .load_history(&HistoryRequest {
            network: format!("burst-{size}"),
            target: channel.clone(),
            before: None,
            before_id: None,
            limit: 100_000,
        })
        .map(|messages| messages.len())
        .unwrap_or(0);
    stop(handle).await;

    Some(format!(
        "| {size} | {} | {} | {spent} ms | {archived} |",
        ms(join_wave),
        ms(quit_wave),
    ))
}

/// One of the crowd. The reading half is a task that discards everything, and
/// the writing half stays here so that the whole crowd can be told to join in
/// one pass. Both halves are taken back before anybody leaves: the wave below
/// has to be one `drop` of a list rather than a few thousand tasks winding
/// down inside the window being timed.
struct Person {
    writer: OwnedWriteHalf,
    settle: oneshot::Sender<()>,
    reading: JoinHandle<OwnedReadHalf>,
}

impl Person {
    /// Connects and registers, but joins nothing. Registering the crowd is
    /// several thousand round trips and would otherwise be most of what the
    /// join wave below measures.
    async fn connect(which: usize) -> std::io::Result<Self> {
        let socket = TcpStream::connect((HOST, port())).await?;
        socket.set_nodelay(true)?;
        let mut reader = BufReader::new(socket);
        let nick = format!("crowd{which}");
        let hello = format!("NICK {nick}\r\nUSER {nick} 0 * :crowd\r\n");
        reader.get_mut().write_all(hello.as_bytes()).await?;

        // A JOIN sent before the server has registered you is answered with
        // 451, so the channel is asked for only once 001 has come back.
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).await? == 0 {
                return Err(std::io::Error::other("the server closed the connection"));
            }
            if line.starts_with("PING ") {
                let pong = line.replacen("PING", "PONG", 1);
                reader.get_mut().write_all(pong.as_bytes()).await?;
            }
            if line.contains(" 001 ") {
                break;
            }
        }

        // What the buffer still holds is the rest of the greeting, which is
        // discarded either way.
        let (rx, writer) = reader.into_inner().into_split();
        let (settle, mut told) = oneshot::channel();
        let reading = tokio::spawn(async move {
            let mut discard = [0u8; 8192];
            loop {
                tokio::select! {
                    _ = &mut told => return rx,
                    ready = rx.readable() => {
                        if ready.is_err() {
                            return rx;
                        }
                        match rx.try_read(&mut discard) {
                            Ok(0) => return rx,
                            Ok(_) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                            Err(_) => return rx,
                        }
                    }
                }
            }
        });

        Ok(Self {
            writer,
            settle,
            reading,
        })
    }

    async fn join(&mut self, channel: &str) -> std::io::Result<()> {
        self.writer
            .write_all(format!("JOIN {channel}\r\n").as_bytes())
            .await
    }

    /// Stops draining and takes both halves back, so that closing them later
    /// is this thread's own work and not a task's.
    async fn settle(self) -> Option<(OwnedWriteHalf, OwnedReadHalf)> {
        let _ = self.settle.send(());
        self.reading.await.ok().map(|rx| (self.writer, rx))
    }
}

fn is_arrival(channel: &str) -> impl Fn(&IrcxEvent) -> bool + '_ {
    move |event| {
        matches!(event, IrcxEvent::MemberUpdated { channel: seen, member, .. }
            if seen == channel && member.nick.starts_with("crowd"))
    }
}

fn is_departure(channel: &str) -> impl Fn(&IrcxEvent) -> bool + '_ {
    move |event| {
        matches!(event, IrcxEvent::MemberRemoved { channel: seen, nick, .. }
            if seen == channel && nick.starts_with("crowd"))
    }
}

/// Reads events until `pick` has matched `wanted` times, or until `limit` runs
/// out. The deadline is over the whole wait rather than per event: a server
/// pings an idle connection, so a run waiting for something that will never
/// arrive keeps being handed events and would otherwise wait for ever.
async fn count(
    events: &mut mpsc::Receiver<IrcxEvent>,
    limit: Duration,
    wanted: usize,
    pick: impl Fn(&IrcxEvent) -> bool,
) -> bool {
    let deadline = Instant::now() + limit;
    let mut seen = 0;
    while seen < wanted {
        let left = deadline.saturating_duration_since(Instant::now());
        let Ok(Some(event)) = timeout(left, events.recv()).await else {
            eprintln!("  saw {seen} of {wanted}");
            return false;
        };
        if pick(&event) {
            seen += 1;
        }
    }
    true
}

async fn wait(
    events: &mut mpsc::Receiver<IrcxEvent>,
    limit: Duration,
    pick: impl Fn(&IrcxEvent) -> bool,
) -> bool {
    count(events, limit, 1, pick).await
}

/// Where the archive goes, `IRCX_BURST_ROOM` or the system temporary
/// directory.
///
/// It matters which. A burst writes each quit in its own transaction, and a
/// transaction on a tmpfs is a memcpy where one on a disk is not: the same
/// 2,500 messages take 178 ms under `/tmp` and 444 ms under `~`. `/tmp` is a
/// tmpfs on most Linux now, so the default is the flattering one and the
/// figures in `docs/measurements.md` are not taken with it.
fn archive_room() -> tempfile::TempDir {
    match std::env::var("IRCX_BURST_ROOM") {
        Ok(room) => tempfile::tempdir_in(room).expect("a directory to put the archive in"),
        Err(_) => tempfile::tempdir().expect("a temporary directory"),
    }
}

/// Milliseconds this process has spent on a cpu, user and system together,
/// across every thread — `utime` and `stime` from `/proc/self/stat`. Linux
/// only, which everything in `docs/measurements.md` already is, and quantised
/// to the 10 ms clock tick, which is why the small sizes read as round
/// numbers.
///
/// `/proc/self/schedstat` reads better and was tried first: it is nanoseconds
/// rather than ticks. It counts one thread rather than the process, and on
/// this kernel that thread is the one doing nothing, so every figure was zero.
fn on_cpu_ms() -> u64 {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    // The second field is the executable name in brackets and can hold spaces,
    // so the fields are counted from after it rather than from the start.
    let Some(fields) = stat.rsplit_once(')') else {
        return 0;
    };
    let fields: Vec<&str> = fields.1.split_whitespace().collect();
    let ticks: u64 = [11, 12]
        .iter()
        .filter_map(|at| fields.get(*at)?.parse::<u64>().ok())
        .sum();
    ticks * 1_000 / TICKS_PER_SECOND
}

fn ms(span: Duration) -> String {
    format!("{:.1} ms", span.as_secs_f64() * 1_000.0)
}

async fn stop(handle: NetworkHandle) {
    let quit = handle.shutdown(Some("burst measurement".into()));
    let _ = timeout(Duration::from_secs(5), quit).await;
}

fn config(network: &str) -> SessionConfig {
    SessionConfig {
        network: network.into(),
        name: "ergo".into(),
        host: HOST.into(),
        port: port(),
        tls: false,
        tls_verify: false,
        socks5_proxy: None,
        client_certificate: None,
        nick: format!("ircx-{network}"),
        alt_nicks: Vec::new(),
        username: "ircxburst".into(),
        realname: "ircx burst measurement".into(),
        sasl: None,
        connect_commands: Vec::new(),
        autojoin: Vec::new(),
    }
}
