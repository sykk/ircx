//! What a slow annotator costs a busy channel.
//!
//! `crates/ircx-plugin/tests/failure_modes.rs` covers a plugin that is broken —
//! throwing, looping, allocating, never returning — one call at a time, and
//! every one of those is caught and reported. This asks the question those
//! cannot: what an annotator that is *not* broken does when the messages
//! outpace it.
//!
//! The shape it is testing for: outside a server `BATCH`, `append` emits one
//! `MessagesAppended` per line, and `Context::annotate` spawns a task per
//! event. A plugin that answers inside its deadline never fails and never
//! strikes out, so nothing here is a failure the host is watching for.
//!
//! The server is scripted rather than real: what is being measured is the
//! arrival rate against the annotator's rate, and a real server's flood
//! protection is exactly what would stop the measurement being taken.
//!
//! ```text
//! cargo test -p ircx-core --test annotator_backlog -- --ignored --nocapture
//! ```

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ircx_core::{
    network_for_plugins, spawn_network_with_plugins, CommandSpec, Grants, Manifest, Permission,
    PluginLimits, PluginRuntime, SessionConfig,
};
use ircx_ipc::IrcxEvent;
use ircx_store::Store;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

const CHANNEL: &str = "#load";
const MESSAGES: usize = 200;

/// Roughly 40ms of arithmetic per batch of messages, well inside any sane
/// deadline. Slow rather than broken is the whole point: a plugin that fails is
/// struck out after three, and this one never fails.
const SLOW_ANNOTATOR: &str = r#"
ircx.annotate((message) => {
  const until = Date.now() + 40;
  let churn = 0;
  while (Date.now() < until) churn += 1;
  return "seen " + churn.toString().slice(0, 1);
});
"#;

fn config(port: u16) -> SessionConfig {
    SessionConfig {
        network: "scripted".into(),
        name: "scripted".into(),
        host: "127.0.0.1".into(),
        port,
        tls: false,
        tls_verify: false,
        client_certificate: None,
        nick: "reader".into(),
        alt_nicks: Vec::new(),
        username: "reader".into(),
        realname: "annotator backlog probe".into(),
        sasl: None,
        connect_commands: Vec::new(),
        autojoin: vec![CHANNEL.into()],
    }
}

/// 300ms a message: three times the rate the channel below speaks at, and
/// well inside the two-second deadline a call is allowed.
const SLOWER_ANNOTATOR: &str = r#"
ircx.annotate((message) => {
  const until = Date.now() + 300;
  let churn = 0;
  while (Date.now() < until) churn += 1;
  return "seen " + churn.toString().slice(0, 1);
});
"#;

const STEADY_MESSAGES: usize = 100;

fn install(root: &Path) -> Arc<PluginRuntime> {
    install_with(root, SLOW_ANNOTATOR)
}

fn install_with(root: &Path, source: &str) -> Arc<PluginRuntime> {
    let runtime = PluginRuntime::open(
        root.join("library"),
        PluginLimits::default(),
        network_for_plugins(tokio::runtime::Handle::current()),
    )
    .map(Arc::new)
    .expect("a plugin runtime");

    let manifest = Manifest {
        id: "slowpoke".into(),
        name: "Slowpoke".into(),
        version: "1.0.0".into(),
        description: "Answers every message, slowly".into(),
        entry: "main.js".into(),
        annotates: true,
        notifies: false,
        commands: Vec::<CommandSpec>::new(),
        requests: Grants {
            permissions: [Permission::AnnotateMessages, Permission::AccessChannels]
                .into_iter()
                .collect(),
            channels: vec!["*".into()],
            hosts: Vec::new(),
        },
    };
    let body = source;
    let source = root.join("slowpoke-source");
    std::fs::create_dir_all(&source).expect("a source directory");
    std::fs::write(
        source.join("plugin.json"),
        serde_json::to_vec(&manifest).expect("a manifest serialises"),
    )
    .expect("write the manifest");
    std::fs::write(source.join("main.js"), body).expect("write the code");

    runtime.install(&source).expect("install");
    runtime
        .set_grants(
            "slowpoke",
            Grants {
                permissions: [Permission::AnnotateMessages, Permission::AccessChannels]
                    .into_iter()
                    .collect(),
                channels: vec![CHANNEL.into()],
                hosts: Vec::new(),
            },
        )
        .expect("grant");
    runtime
}

/// Accepts one client and takes it through registration and a join, leaving the
/// write half for the caller to talk on.
async fn registered(listener: TcpListener) -> tokio::net::tcp::OwnedWriteHalf {
    let (socket, _) = listener.accept().await.expect("the client connects");
    let (reader, mut writer) = socket.into_split();
    let mut lines = BufReader::new(reader).lines();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.starts_with("USER") {
            let welcome = ":scripted 001 reader :Welcome\r\n\
                           :scripted 005 reader CHANTYPES=# PREFIX=(ov)@+ NETWORK=scripted \
                           :are supported by this server\r\n";
            writer.write_all(welcome.as_bytes()).await.expect("welcome");
        }
        if line.starts_with("JOIN") {
            writer
                .write_all(format!(":reader!r@h JOIN {CHANNEL}\r\n").as_bytes())
                .await
                .expect("join");
            break;
        }
        if line.starts_with("PING") {
            let token = line.split_once(' ').map(|(_, rest)| rest).unwrap_or("");
            writer
                .write_all(format!("PONG {token}\r\n").as_bytes())
                .await
                .expect("pong");
        }
    }

    writer
}

/// Registers the client and then says `MESSAGES` things as fast as the socket
/// takes them.
async fn scripted_server(listener: TcpListener) {
    let mut writer = registered(listener).await;
    let mut burst = String::new();
    for i in 0..MESSAGES {
        burst.push_str(&format!(":talker!t@h PRIVMSG {CHANNEL} :line {i}\r\n"));
    }
    writer.write_all(burst.as_bytes()).await.expect("the burst");

    // Held open: dropping the socket would end the session before the
    // annotations have anywhere to arrive.
    tokio::time::sleep(Duration::from_secs(120)).await;
}

/// Says `STEADY_MESSAGES` things at a steady rate rather than all at once.
async fn steady_server(listener: TcpListener) {
    let mut writer = registered(listener).await;
    for i in 0..STEADY_MESSAGES {
        let line = format!(":talker!t@h PRIVMSG {CHANNEL} :line {i}\r\n");
        writer.write_all(line.as_bytes()).await.expect("a line");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_secs(120)).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "measures a plugin against a flood, and takes as long as the backlog does"]
async fn a_slow_annotator_against_a_busy_channel() {
    let room = tempfile::tempdir().expect("a temp directory");
    let runtime = install(room.path());

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(scripted_server(listener));

    let store = Arc::new(Store::open_in_memory().expect("store"));
    let (tx, mut rx) = mpsc::channel(8192);
    let handle = spawn_network_with_plugins(config(port), store, tx, Some(runtime));

    let started = Instant::now();
    let mut arrived = 0usize;
    let mut annotated = 0usize;
    let mut last_arrival = None;
    let mut last_annotation = None;

    // Long enough for the backlog to drain if it is going to: 200 messages at
    // 40ms each is eight seconds of work, and this allows five times that.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        match event {
            IrcxEvent::MessagesAppended { messages, .. } => {
                arrived += messages.len();
                if arrived >= MESSAGES {
                    last_arrival.get_or_insert(started.elapsed());
                }
            }
            IrcxEvent::MessageAnnotated { .. } => {
                annotated += 1;
                last_annotation = Some(started.elapsed());
                if annotated >= MESSAGES {
                    break;
                }
            }
            _ => {}
        }
    }

    handle.shutdown(Some("probe done".into())).await;

    println!();
    println!("  messages sent        {MESSAGES}");
    println!("  messages arrived     {arrived}");
    println!("  annotations          {annotated}");
    println!("  all arrived at       {:?}", last_arrival);
    println!("  last annotation at   {:?}", last_annotation);
    if let (Some(arrival), Some(annotation)) = (last_arrival, last_annotation) {
        println!(
            "  the annotator ran {:?} behind the conversation",
            annotation.saturating_sub(arrival)
        );
    }
}

/// The same plugin against a channel that keeps talking, which is the case a
/// burst does not answer: does the lag settle, or does it grow for as long as
/// the traffic does?
///
/// The rate is one message every 100ms against an annotator that takes 300ms,
/// so the work arrives three times faster than it can be done. Nothing about
/// that is a failure the host can see — the per-call deadline is two seconds,
/// and 300ms is well inside it.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "measures a plugin against a channel that keeps talking"]
async fn a_slow_annotator_against_a_channel_that_keeps_talking() {
    let room = tempfile::tempdir().expect("a temp directory");
    let runtime = install_with(room.path(), SLOWER_ANNOTATOR);

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("addr").port();
    tokio::spawn(steady_server(listener));

    let store = Arc::new(Store::open_in_memory().expect("store"));
    let (tx, mut rx) = mpsc::channel(8192);
    let handle = spawn_network_with_plugins(config(port), store, tx, Some(runtime));

    let started = Instant::now();
    let mut arrival: HashMap<String, Duration> = HashMap::new();
    let mut lags: Vec<(usize, Duration)> = Vec::new();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        match event {
            IrcxEvent::MessagesAppended { messages, .. } => {
                for message in messages {
                    arrival.insert(message.id.clone(), started.elapsed());
                }
            }
            IrcxEvent::MessageAnnotated { message, .. } => {
                if let Some(came) = arrival.get(&message) {
                    let lag = started.elapsed().saturating_sub(*came);
                    lags.push((lags.len() + 1, lag));
                }
                if lags.len() >= STEADY_MESSAGES {
                    break;
                }
            }
            _ => {}
        }
    }

    handle.shutdown(Some("probe done".into())).await;

    println!();
    println!("  a message every 100ms, an annotator taking 300ms");
    println!("  annotations       {}", lags.len());
    println!("  {:>10}  {:>12}", "message", "lag");
    for (index, lag) in &lags {
        if index % 20 == 0 || *index == 1 {
            println!("  {index:>10}  {lag:>12?}");
        }
    }
    if let (Some((_, first)), Some((_, last))) = (lags.first(), lags.last()) {
        println!();
        println!("  the first note was {first:?} behind its message");
        println!("  the last was {last:?} behind its own");
    }
}
