//! Drives the real stack against irc.libera.chat and prints what it found.
//!
//! Ignored by default so `cargo test --workspace` never dials the internet:
//!
//! ```text
//! cargo test -p ircx-core --test libera -- --ignored --nocapture
//! ```
//!
//! One short session on a throwaway unregistered nick, no SASL, in `##test`,
//! plus a second brief connection whose only job is to collide with the first
//! one's nick. This is a diagnostic: a step that fails is printed and the run
//! carries on, so one broken thing does not hide the next.
//!
//! It also visits one busy channel, because a member list that fits in a single
//! 353 reply never exercises the assembly across replies. That visit is a join,
//! a read and a part: nothing is ever said in a channel with people in it.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use ircx_core::{
    spawn_network, Action, CaseMapping, ISupport, NetworkHandle, SessionCommand, SessionConfig,
    SessionState, SERVER_TARGET, SUPPORTED_CAPS,
};
use ircx_ipc::{
    Channel, ChatMessage, CommandOutcome, ConnectionStatus, Delivery, HistoryRequest, IrcxEvent,
    Member, MessageKind, MessageSource, Network, Query, SearchRequest,
};
use ircx_net::{ConnectionConfig, Transport, TransportEvent};
use ircx_proto::{Command, Message, Prefix};
use ircx_store::Store;
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use uuid::Uuid;

const HOST: &str = "irc.libera.chat";
const PORT: u16 = 6697;
/// The channel Libera keeps for exactly this. Never a project channel.
const CHANNEL: &str = "##test";
/// The network's own channel, big enough to split a member list over many
/// replies and busy enough that its membership moves while we watch. Joined
/// read-only and left again inside a minute.
const CROWD: &str = "#libera";
/// How long we stay in `CROWD` after its member list arrives.
const CHURN: Duration = Duration::from_secs(45);
/// Long enough for a registration and then a server ping timeout on top of it.
const PING_WINDOW: Duration = Duration::from_secs(300);
/// Every membership prefix any IRC server hands out, not just Libera's `@+`,
/// so a leak into a nick is caught whatever the server ranks by.
const PREFIX_CHARS: [char; 5] = ['@', '+', '~', '&', '%'];
const ARCHIVE_MESSAGES: usize = 3000;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "opens a real connection to irc.libera.chat"]
async fn against_libera() {
    let mut report = Report::default();
    let stamp = Uuid::new_v4().as_u128() % 100_000;
    let nick = format!("ircx-t{stamp:05}");
    let marker = format!("ircxprobe{stamp:05}");
    println!("\n=== ircx against Libera.Chat, nick {nick} ===\n");

    let dir = std::env::temp_dir().join(format!("ircx-libera-{}", Uuid::new_v4()));
    let Ok(()) = std::fs::create_dir_all(&dir) else {
        report.fail("archive", "could not create a temporary directory");
        return;
    };
    let db = dir.join("ircx.sqlite");

    let opened = Instant::now();
    let store = match Store::open(&db) {
        Ok(store) => Arc::new(store),
        Err(error) => {
            report.fail("archive", &format!("Store::open failed: {error}"));
            return;
        }
    };
    report.number("Store::open", &format!("{:?}", opened.elapsed()));

    session(&mut report, Arc::clone(&store), &nick, &marker).await;

    // Last, not first: dialling the host twice before the session would warm
    // the resolver and rustls, and the cold-start figure the session reports is
    // only worth anything if nothing has connected yet.
    tls(&mut report).await;
    certificate_is_actually_checked(&mut report).await;
    archive(&mut report, &db, &marker, Arc::clone(&store)).await;

    drop(store);
    let _ = std::fs::remove_dir_all(&dir);
    report.finish();
}

// Transport.

async fn tls(report: &mut Report) {
    let attempt = Transport::connect(ConnectionConfig {
        host: HOST.into(),
        port: PORT,
        ..ConnectionConfig::default()
    })
    .await;

    let (transport, mut events) = match attempt {
        Ok(connected) => connected,
        Err(error) => return report.fail("TLS handshake", &error.to_string()),
    };
    match timeout(Duration::from_secs(10), events.recv()).await {
        Ok(Some(TransportEvent::Connected {
            tls_info: Some(info),
        })) => report.pass(
            "TLS handshake",
            &format!(
                "{} {} — cert subject {}",
                info.protocol,
                info.cipher_suite,
                info.peer_cert_subject.as_deref().unwrap_or("<none>")
            ),
        ),
        other => report.fail("TLS handshake", &format!("first event was {other:?}")),
    }
    drop(transport);
}

/// Connecting by address means the certificate's names cannot match, so a
/// handshake that still succeeds would mean verification is not happening.
async fn certificate_is_actually_checked(report: &mut Report) {
    let resolved = tokio::net::lookup_host((HOST, PORT))
        .await
        .ok()
        .and_then(|mut addresses| addresses.next());
    let Some(address) = resolved else {
        return report.unverified("certificate verification", "could not resolve the host");
    };

    let attempt = Transport::connect(ConnectionConfig {
        host: address.ip().to_string(),
        port: PORT,
        ..ConnectionConfig::default()
    })
    .await;
    match attempt {
        Err(error) => report.pass(
            "certificate verification",
            &format!("{} rejected: {error}", address.ip()),
        ),
        Ok(_) => report.fail(
            "certificate verification",
            &format!(
                "the handshake with {} succeeded without a matching name",
                address.ip()
            ),
        ),
    }
}

// Session.

async fn session(report: &mut Report, store: Arc<Store>, nick: &str, marker: &str) {
    let started = Instant::now();
    let mut live = Live::start(config("libera", nick, nick), Arc::clone(&store));

    let welcome = live
        .wait(Duration::from_secs(60), |event| match event {
            IrcxEvent::ConnectionChanged {
                status: ConnectionStatus::Connected,
                ..
            } => Some(()),
            _ => None,
        })
        .await;
    if welcome.is_none() {
        report.fail("registration", "never reached RPL_WELCOME");
        live.dump("the last lines before giving up");
        live.stop().await;
        return;
    }
    report.pass(
        "registration",
        &format!("RPL_WELCOME after {:?}", started.elapsed()),
    );
    report.number(
        "connect to RPL_WELCOME",
        &format!("{:?}", started.elapsed()),
    );
    // Nothing has dialled anything yet, so this is the whole cold path with no
    // window on the end of it: exec, the tokio runtime, `Store::open` on a
    // fresh database, DNS, TCP, the TLS handshake, CAP and registration.
    report.number(
        "process exec to RPL_WELCOME, no UI",
        &since_exec()
            .map(|elapsed| format!("{elapsed:?}"))
            .unwrap_or_else(|| "unknown".into()),
    );

    // `Connected` is emitted on 001, so ISUPPORT and the MOTD are still in
    // flight. Read on until the MOTD ends before judging what the server said.
    live.wait(Duration::from_secs(30), |event| match event {
        IrcxEvent::RawLine { line, .. } if is_numeric(line, 376) || is_numeric(line, 422) => {
            Some(())
        }
        _ => None,
    })
    .await;

    capabilities(report, &live);
    isupport(report, &live);

    join_and_names(report, &mut live).await;
    names_for_a_channel_we_are_not_in(report, &mut live).await;
    a_busy_channel(report, &mut live).await;
    say_something(report, &mut live, marker).await;
    a_ban_list_is_read(report, &mut live).await;
    a_quiet_list_is_read(report, &mut live).await;
    a_query_window(report, &mut live, nick).await;
    part_and_rejoin(report, &mut live).await;
    nick_collision(report, &mut live, Arc::clone(&store), nick).await;

    // Runs alongside the two long waits below rather than after them, so the
    // idle socket it needs costs no extra minutes on someone else's server.
    // Never alongside the collision check above: that would be a third
    // connection from one address.
    let probe = tokio::spawn(a_server_initiated_ping(format!("{nick}p")));
    ping_and_lag(report, &mut live).await;
    reconnect(report, &mut live).await;
    a_record_of_somebody_who_has_gone(report, &mut live, nick).await;
    match probe.await {
        Ok(outcome) => outcome.report(report),
        Err(error) => report.fail("answering the server's own PING", &error.to_string()),
    }

    report.number(
        "resident memory, live session",
        &proc_field("VmRSS").unwrap_or_else(|| "unknown".into()),
    );

    let transcript = std::env::temp_dir().join(format!("ircx-libera-{nick}.log"));
    match std::fs::write(&transcript, live.transcript.join("\n")) {
        Ok(()) => report.note("protocol transcript", &transcript.display().to_string()),
        Err(error) => report.note("protocol transcript", &error.to_string()),
    }
    live.stop().await;
}

fn config(network: &str, nick: &str, primary: &str) -> SessionConfig {
    SessionConfig {
        network: network.into(),
        name: "Libera".into(),
        host: HOST.into(),
        port: PORT,
        tls: true,
        tls_verify: true,
        socks5_proxy: None,
        client_certificate: None,
        nick: primary.into(),
        alt_nicks: if nick == primary {
            Vec::new()
        } else {
            vec![nick.into()]
        },
        username: "ircxtest".into(),
        realname: "ircx verification run".into(),
        sasl: None,
        connect_commands: Vec::new(),
        autojoin: Vec::new(),
        quit_message: None,
        part_message: None,
        away_message: None,
    }
}

fn capabilities(report: &mut Report, live: &Live) {
    let offered = live.cap_list("LS");
    let acked = live.cap_list("ACK");
    let requested: Vec<String> = live
        .outgoing
        .iter()
        .filter_map(|line| line.strip_prefix("CAP REQ :"))
        .flat_map(|list| list.split_whitespace().map(String::from))
        .collect();
    let enabled = live
        .seen_any(|event| match event {
            IrcxEvent::CapsChanged { enabled, .. } => Some(enabled.clone()),
            _ => None,
        })
        .unwrap_or_default();

    for line in live.incoming.iter().filter(|line| {
        Message::parse(line).is_ok_and(|m| m.command == Command::Named("CAP".into()))
    }) {
        report.raw(line);
    }
    report.list("Libera offers", &offered);
    report.list(
        "ircx supports",
        &SUPPORTED_CAPS
            .iter()
            .map(|c| (*c).to_string())
            .collect::<Vec<_>>(),
    );
    report.list("ircx asked for", &requested);
    report.list("Libera acked", &acked);
    report.list("session reports enabled", &enabled);

    let mut wanted: Vec<String> = offered
        .iter()
        .filter(|cap| SUPPORTED_CAPS.contains(&cap.as_str()))
        .cloned()
        .collect();
    wanted.sort();
    let mut asked = requested.clone();
    asked.sort();
    report.check(
        "CAP REQ is the intersection of what we support and what is offered",
        wanted == asked,
        &format!("wanted {wanted:?}, asked {asked:?}"),
    );

    let never_offered: Vec<&str> = SUPPORTED_CAPS
        .iter()
        .filter(|cap| !offered.iter().any(|offer| offer == *cap))
        .copied()
        .collect();
    report.note(
        "supported but not offered here",
        &format!("{never_offered:?}"),
    );
    let ignored: Vec<&String> = offered
        .iter()
        .filter(|cap| !SUPPORTED_CAPS.contains(&cap.as_str()))
        .collect();
    report.note("offered but ignored", &format!("{ignored:?}"));

    report.check(
        "every acked capability is reported as enabled",
        acked.iter().all(|cap| enabled.contains(cap)),
        &format!("acked {acked:?}, enabled {enabled:?}"),
    );
}

fn isupport(report: &mut Report, live: &Live) {
    let mut parsed = ISupport::default();
    let mut lines = 0;
    for line in &live.incoming {
        let Ok(message) = Message::parse(line) else {
            continue;
        };
        if message.command != Command::Numeric(5) {
            continue;
        }
        // Drop the leading nick and the trailing "are supported by this server".
        let tokens: Vec<String> = message
            .params
            .iter()
            .skip(1)
            .cloned()
            .collect::<Vec<_>>()
            .split_last()
            .map(|(_, tokens)| tokens.to_vec())
            .unwrap_or_default();
        parsed.apply(&tokens);
        lines += 1;
        report.raw(line);
    }

    report.check("RPL_ISUPPORT arrived", lines > 0, &format!("{lines} lines"));
    report.check(
        "CHANTYPES",
        parsed.chantypes == "#",
        &format!("{:?}", parsed.chantypes),
    );
    report.check(
        "PREFIX",
        parsed.prefixes == vec![('o', '@'), ('v', '+')],
        &format!("{:?}", parsed.prefixes),
    );
    report.check(
        "CASEMAPPING",
        parsed.casemapping == CaseMapping::Rfc1459,
        &format!("{:?}", parsed.casemapping),
    );
    report.note("NETWORK", &format!("{:?}", parsed.network));
    report.note("CHANMODES", &format!("{:?}", parsed.chanmodes));
    report.check(
        "the channel we are about to join parses as a channel",
        parsed.is_channel(CHANNEL),
        CHANNEL,
    );
}

async fn join_and_names(report: &mut Report, live: &mut Live) {
    live.send(SessionCommand::Join {
        channel: CHANNEL.into(),
        key: None,
    })
    .await;

    let members = live
        .wait(Duration::from_secs(45), |event| match event {
            IrcxEvent::MembersReplaced {
                channel, members, ..
            } if channel == CHANNEL => Some(members.clone()),
            _ => None,
        })
        .await;
    let Some(members) = members else {
        report.fail("JOIN", &format!("no member list for {CHANNEL}"));
        live.dump("the last lines after the JOIN");
        return;
    };

    let replies = live
        .incoming
        .iter()
        .filter(|line| numeric_for(line, 353, CHANNEL))
        .count();
    report.pass(
        "JOIN",
        &format!(
            "{CHANNEL} joined, {} members over {replies} 353 replies",
            members.len()
        ),
    );
    report.check(
        "no membership prefix leaked into a nick",
        members
            .iter()
            .all(|member| !member.nick.starts_with(PREFIX_CHARS)),
        &sample(&members),
    );
    report.check(
        "no userhost leaked into a nick",
        members.iter().all(|member| !member.nick.contains('!')),
        &sample(&members),
    );

    let listed = live.members(CHANNEL).await.unwrap_or_default();
    report.check(
        "the member list the UI would ask for matches the one it was pushed",
        listed.len() == members.len(),
        &format!("pushed {}, queried {}", members.len(), listed.len()),
    );

    // Libera tags the JOIN it echoes back, which makes it the one inbound
    // message in this run that can show whether `server-time` is being read.
    let note = live.seen_any(|event| match event {
        IrcxEvent::MessagesAppended {
            target, messages, ..
        } if target == CHANNEL => messages
            .iter()
            .find(|message| message.kind == MessageKind::Join)
            .cloned(),
        _ => None,
    });
    match note {
        Some(note) => report.check(
            "server-time is read off a tagged line",
            !note.timestamp_is_local,
            &format!("{} (local: {})", note.timestamp, note.timestamp_is_local),
        ),
        None => report.unverified("server-time", "no JOIN reached the timeline"),
    }
}

async fn say_something(report: &mut Report, live: &mut Live, marker: &str) {
    let text = format!("ircx client verification run {marker} — please ignore");
    let outcome = live.submit(CHANNEL, &text).await;
    let Some(CommandOutcome::Sent(local)) = outcome else {
        report.fail("send a message", &format!("{outcome:?}"));
        return;
    };
    report.pass(
        "send a message",
        &format!("local copy {} in state {:?}", local.id, local.delivery),
    );

    let echoes = live
        .seen_any(|event| match event {
            IrcxEvent::CapsChanged { enabled, .. } => {
                Some(enabled.iter().any(|cap| cap == "echo-message"))
            }
            _ => None,
        })
        .unwrap_or(false);
    if !echoes {
        return report.unverified(
            "echo-message delivery confirmation",
            "Libera did not negotiate echo-message",
        );
    }
    report.check(
        "an unconfirmed message starts as Pending",
        local.delivery == Delivery::Pending,
        &format!("{:?}", local.delivery),
    );

    // A sent message is updated twice — `Sent` when the line leaves the socket
    // and `Delivered` when the echo comes back — so the confirmation is what
    // this waits for rather than the first update carrying the id. Taking the
    // first and asking afterwards is what had this step reporting that a
    // message the archive holds as `Delivered` was never confirmed.
    let wanted = local.id.clone();
    let confirmed = live
        .wait(Duration::from_secs(30), |event| match event {
            IrcxEvent::MessageUpdated { message }
                if message.id == wanted && message.delivery == Delivery::Delivered =>
            {
                Some(message.as_ref().clone())
            }
            _ => None,
        })
        .await;
    let Some(confirmed) = confirmed else {
        report.fail(
            "echo-message delivery confirmation",
            "the echo never confirmed the local copy",
        );
        live.dump("the last lines after the send");
        return;
    };
    report.pass(
        "echo-message delivery confirmation",
        "the echo was matched to the local copy",
    );

    // The state the timeline draws while a message is in flight, and the one
    // this step used to mistake for the confirmation.
    let sent = live.seen_any(|event| match event {
        IrcxEvent::MessageUpdated { message }
            if message.id == wanted && message.delivery == Delivery::Sent =>
        {
            Some(())
        }
        _ => None,
    });
    report.check(
        "a message is marked sent before it is confirmed",
        sent.is_some(),
        match sent {
            Some(()) => "the write was reported, then the echo",
            None => "nothing reported the write; the echo was the only update",
        },
    );

    // The echo is the only place the server's own identity for our message
    // appears. Whether the confirmation keeps it decides what a later replay
    // of the same message can be matched against.
    let echo = live
        .incoming
        .iter()
        .find(|line| line.contains(marker) && line.contains("PRIVMSG"))
        .cloned()
        .unwrap_or_default();
    report.raw(&echo);
    let parsed = Message::parse(&echo).ok();
    let msgid = parsed.as_ref().and_then(|m| m.tag("msgid")).unwrap_or("");
    let time = parsed.as_ref().and_then(|m| m.tag("time")).unwrap_or("");
    // The id stays the local one — that is what the frontend drew — so the
    // server's name for the message rides along as the tag it arrived as.
    let kept = confirmed
        .tags
        .iter()
        .find(|(name, _)| name == "msgid")
        .and_then(|(_, value)| value.as_deref());
    report.check(
        "a confirmed message keeps the server's msgid",
        !msgid.is_empty() && kept == Some(msgid),
        &format!("echo carried msgid {msgid:?}, the message kept {kept:?}"),
    );
    report.check(
        "a confirmed message takes the server's timestamp",
        !time.is_empty() && confirmed.timestamp == time,
        &format!(
            "echo carried time {time:?}, the message kept {:?}",
            confirmed.timestamp
        ),
    );
}

/// NickServ is the one correspondent guaranteed to answer, and one `INFO` is
/// the least traffic that gets a reply.
/// The ban list, read off solanum. #664 taught the client what a `367` means
/// and could only ask ergo, which names the setter as a whole `nick!user@host`
/// where Libera sends a bare nick, and ends an empty list in different words.
/// Both go through the one sentence.
///
/// A read and nothing else: listing bans needs no ops, and nothing here sets
/// one on a channel that is not ours.
async fn a_ban_list_is_read(report: &mut Report, live: &mut Live) {
    live.submit(CHANNEL, "/mode b").await;

    let row = live
        .wait(Duration::from_secs(30), |event| match event {
            IrcxEvent::MessagesAppended {
                target, messages, ..
            } if target == CHANNEL => messages
                .iter()
                .find(|message| message.text.contains("banned in"))
                .cloned(),
            _ => None,
        })
        .await;
    match row {
        Some(row) => {
            report.pass("ban list", &row.text);
            // Whether ##test has anything banned in it is not ours to arrange,
            // and the entry is the half of this only a real solanum can answer:
            // it names the setter as a bare nick where ergo sends a whole
            // `nick!user@host`.
            // An entry opens with the mask it is about; the empty list opens
            // with `Nobody`.
            if !row.text.starts_with('`') {
                report.unverified(
                    "a listed ban",
                    &format!("{CHANNEL} has nothing banned in it, so no entry was drawn"),
                );
            }
        }
        None => {
            report.fail(
                "ban list",
                "asking for the ban list said nothing in the channel",
            );
            live.dump("the last lines after asking for the ban list");
            return;
        }
    }

    // What the answer used to be: the numeric's parameters joined, in the
    // server tab, the `368` at the end of them and all. Both wordings, because
    // ergo ends the list `End of list` and solanum `End of channel ban list`.
    let leaked = live.seen_any(|event| match event {
        IrcxEvent::MessagesAppended {
            target, messages, ..
        } if target == SERVER_TARGET => messages
            .iter()
            .find(|message| {
                message.text.contains("End of channel ban list")
                    || message.text.contains("End of list")
            })
            .cloned(),
        _ => None,
    });
    report.check(
        "the ban list is not also in the server tab",
        leaked.is_none(),
        &leaked
            .map(|row| row.text)
            .unwrap_or_else(|| "the console said nothing about it".into()),
    );
}

/// The other list solanum keeps, under `+q`: who may come in and not speak.
///
/// `728` is the one list reply that names its own mode, between the channel and
/// everything else, so this is what says the letter is being taken out rather
/// than read as the mask.
async fn a_quiet_list_is_read(report: &mut Report, live: &mut Live) {
    live.submit(CHANNEL, "/mode q").await;

    let row = live
        .wait(Duration::from_secs(30), |event| match event {
            IrcxEvent::MessagesAppended {
                target, messages, ..
            } if target == CHANNEL => messages
                .iter()
                .find(|message| message.text.contains("speak"))
                .cloned(),
            _ => None,
        })
        .await;
    match row {
        Some(row) => {
            report.pass("quiet list", &row.text);
            // Whether anything is quieted in a channel this run is a guest in
            // is not ours to arrange, and the entry is the half that carries
            // the mode letter through.
            if !row.text.starts_with('`') {
                report.unverified(
                    "a listed quiet",
                    &format!("nobody is quieted in {CHANNEL}, so no entry was drawn"),
                );
            }
        }
        None => {
            report.fail(
                "quiet list",
                "asking for the quiet list said nothing in the channel",
            );
            live.dump("the last lines after asking for the quiet list");
        }
    }
}

async fn a_query_window(report: &mut Report, live: &mut Live, nick: &str) {
    live.submit("*", &format!("/msg NickServ INFO {nick}"))
        .await;

    let arrived = live
        .wait(Duration::from_secs(45), |event| match event {
            IrcxEvent::MessagesAppended {
                target, messages, ..
            } if target == "NickServ" => messages.iter().find(|m| !m.sender.is_self).cloned(),
            _ => None,
        })
        .await;
    let Some(reply) = arrived else {
        report.fail("receive a message", "NickServ never answered into a query");
        live.dump("the last lines after the NickServ message");
        return;
    };
    report.pass(
        "receive a message",
        &format!(
            "{} said {:?}",
            reply.sender.nick,
            reply.text.chars().take(60).collect::<String>()
        ),
    );
    report.check(
        "a live message is marked live",
        reply.source == MessageSource::Live,
        &format!("{:?}", reply.source),
    );
    report.note(
        "a NickServ notice carries no tags at all",
        &format!(
            "so it falls back to receipt time: {} (local: {}, id local: {})",
            reply.timestamp, reply.timestamp_is_local, reply.id_is_local
        ),
    );
    report.raw(&reply.raw);

    let query = live.seen_any(|event| match event {
        IrcxEvent::QueryUpdated { query } if query.nick == "NickServ" => Some(query.clone()),
        _ => None,
    });
    report.check(
        "query window",
        query.is_some(),
        &format!("{:?}", query.map(|q| (q.nick, q.online))),
    );
}

/// A bare `NAMES` is read-only: it joins nothing, says nothing, and nobody in
/// the channel sees it. The answer names a channel the user is not in, and none
/// of it should reach the sidebar.
async fn names_for_a_channel_we_are_not_in(report: &mut Report, live: &mut Live) {
    live.send(SessionCommand::Raw {
        line: format!("NAMES {CROWD}"),
    })
    .await;

    let leaked = live
        .wait(Duration::from_secs(60), |event| match event {
            IrcxEvent::MembersReplaced { channel, .. } if channel == CROWD => Some(()),
            _ => None,
        })
        .await;
    let replies = live
        .incoming
        .iter()
        .filter(|line| numeric_for(line, 353, CROWD))
        .count();
    report.check(
        "a NAMES reply for a channel we are not in is dropped",
        leaked.is_none(),
        &format!("{replies} replies came back for {CROWD}"),
    );

    let listed = live
        .snapshot()
        .await
        .map(|(_, channels, _)| channels.iter().any(|channel| channel.name == CROWD))
        .unwrap_or(true);
    report.check(
        "and does not put that channel in the list",
        !listed,
        &format!("{CROWD} in the channel list: {listed}"),
    );
}

/// `##test` holds five people, so its member list arrives in one 353 and the
/// assembly across replies is never touched. A channel with a thousand people
/// in it splits the list over dozens, and getting one wrong loses a batch
/// silently. We join, read the list, watch the membership move for a minute,
/// and leave. Nothing is sent to the channel.
async fn a_busy_channel(report: &mut Report, live: &mut Live) {
    // The read-only `NAMES` above answered for this same channel, so counting
    // 353 replies from the start of the log would count that one too.
    let before_join = live.incoming.len();
    live.send(SessionCommand::Join {
        channel: CROWD.into(),
        key: None,
    })
    .await;

    // Counted as they go past rather than afterwards, so the count is the one
    // that had arrived at the moment the member list was published.
    let mut replies = 0usize;
    let flushed = live
        .wait(Duration::from_secs(90), |event| match event {
            IrcxEvent::RawLine {
                outgoing: false,
                line,
                ..
            } => {
                if numeric_for(line, 353, CROWD) {
                    replies += 1;
                }
                None
            }
            IrcxEvent::MembersReplaced {
                channel, members, ..
            } if channel == CROWD => Some((members.clone(), replies)),
            _ => None,
        })
        .await;
    let Some((members, when_published)) = flushed else {
        report.fail(
            "NAMES spanning several 353 replies",
            &format!("no member list for {CROWD} after {replies} replies"),
        );
        live.dump("the last lines after the JOIN");
        return;
    };
    let after_the_list = live.incoming.len();

    let replies: Vec<&String> = live.incoming[before_join..]
        .iter()
        .filter(|line| numeric_for(line, 353, CROWD))
        .collect();
    let names: Vec<String> = replies
        .iter()
        .filter_map(|line| Message::parse(line).ok())
        .flat_map(|message| {
            message
                .params
                .last()
                .cloned()
                .unwrap_or_default()
                .split_whitespace()
                .map(|entry| entry.trim_start_matches(PREFIX_CHARS).to_string())
                .collect::<Vec<_>>()
        })
        .collect();
    let mut distinct: Vec<String> = names.iter().map(|nick| fold(nick)).collect();
    distinct.sort();
    distinct.dedup();

    report.check(
        "NAMES spanning several 353 replies",
        replies.len() > 1,
        &format!(
            "{CROWD} answered with {} replies carrying {} names",
            replies.len(),
            names.len()
        ),
    );
    if let Some(line) = replies.first() {
        report.raw(line);
    }
    report.check(
        "nothing is published until the last reply lands",
        when_published == replies.len(),
        &format!(
            "{when_published} of {} replies had arrived when the member list went out",
            replies.len()
        ),
    );

    let held: HashSet<String> = members.iter().map(|member| fold(&member.nick)).collect();
    let lost: Vec<&String> = distinct
        .iter()
        .filter(|nick| !held.contains(*nick))
        .take(8)
        .collect();
    report.check(
        "every name across every reply reaches the member list",
        members.len() == distinct.len() && lost.is_empty(),
        &format!(
            "{} distinct names on the wire, {} members held{}",
            distinct.len(),
            members.len(),
            match lost.is_empty() {
                true => String::new(),
                false => format!(", missing {lost:?}"),
            }
        ),
    );
    report.check(
        "no membership prefix leaked into a nick",
        members
            .iter()
            .all(|member| !member.nick.starts_with(PREFIX_CHARS)),
        &sample(&members),
    );
    report.note(
        "members carrying a prefix",
        &format!(
            "{} of {}",
            members
                .iter()
                .filter(|member| !member.prefixes.is_empty())
                .count(),
            members.len()
        ),
    );
    report.number(
        &format!("{CROWD} member list"),
        &format!(
            "{} members over {} replies, longest reply {} bytes",
            members.len(),
            replies.len(),
            replies.iter().map(|line| line.len()).max().unwrap_or(0)
        ),
    );

    membership_under_churn(report, live, after_the_list, &held).await;

    live.send(SessionCommand::Part {
        channel: CROWD.into(),
        reason: Some("ircx verification run".into()),
    })
    .await;
    let left = live
        .wait(Duration::from_secs(30), |event| match event {
            IrcxEvent::ChannelUpdated { channel } if channel.name == CROWD && !channel.joined => {
                Some(())
            }
            _ => None,
        })
        .await;
    report.check(
        "leaving the busy channel again",
        left.is_some(),
        &format!("parted {CROWD}"),
    );
}

/// A channel this size is never still. Every membership change over the next
/// stretch is replayed by hand off the raw lines and compared with what the
/// session holds — the same arithmetic a netsplit puts through, only spread
/// over a minute instead of arriving all at once.
async fn membership_under_churn(
    report: &mut Report,
    live: &mut Live,
    from: usize,
    start: &HashSet<String>,
) {
    let _: Option<()> = live.wait(CHURN, |_| None).await;
    let churn: Vec<String> = live.incoming[from..].to_vec();

    let mut expected = start.clone();
    let (mut joins, mut parts, mut quits, mut kicks, mut renames) = (0, 0, 0, 0, 0);
    for line in &churn {
        let Ok(message) = Message::parse(line) else {
            continue;
        };
        let Some(Prefix::User { nick, .. }) = &message.prefix else {
            continue;
        };
        let Command::Named(name) = &message.command else {
            continue;
        };
        let who = fold(nick);
        let here = message
            .param(0)
            .is_some_and(|param| fold(param) == fold(CROWD));
        match name.to_ascii_uppercase().as_str() {
            "JOIN" if here => {
                expected.insert(who);
                joins += 1;
            }
            "PART" if here => {
                expected.remove(&who);
                parts += 1;
            }
            "QUIT" => {
                if expected.remove(&who) {
                    quits += 1;
                }
            }
            "KICK" if here => {
                if let Some(target) = message.param(1) {
                    expected.remove(&fold(target));
                    kicks += 1;
                }
            }
            "NICK" => {
                if let Some(new) = message.param(0) {
                    if expected.remove(&who) {
                        expected.insert(fold(new));
                        renames += 1;
                    }
                }
            }
            _ => {}
        }
    }

    let now: HashSet<String> = live
        .members(CROWD)
        .await
        .unwrap_or_default()
        .iter()
        .map(|member| fold(&member.nick))
        .collect();
    let extra: Vec<&String> = now.difference(&expected).take(8).collect();
    let gone: Vec<&String> = expected.difference(&now).take(8).collect();
    report.check(
        "the member list tracks a live channel's churn",
        now == expected,
        &format!(
            "{joins} joins, {parts} parts, {quits} quits, {kicks} kicks and {renames} nick \
             changes over {CHURN:?}: the session holds {}, the raw lines say {} \
             (held but not expected {extra:?}, expected but not held {gone:?})",
            now.len(),
            expected.len()
        ),
    );

    let all_quits: Vec<&String> = churn
        .iter()
        .filter(|line| {
            Message::parse(line).is_ok_and(|m| m.command == Command::Named("QUIT".into()))
        })
        .collect();
    let split: Vec<&&String> = all_quits
        .iter()
        .filter(|line| {
            Message::parse(line)
                .ok()
                .and_then(|m| m.param(0).map(looks_like_a_netsplit))
                .unwrap_or(false)
        })
        .collect();
    match split.first() {
        Some(line) => {
            report.raw(line);
            report.pass(
                "netsplit recovery",
                &format!(
                    "{} of {} QUITs in {CROWD} carried a netsplit reason",
                    split.len(),
                    all_quits.len()
                ),
            );
        }
        None => report.unverified(
            "netsplit recovery",
            &format!(
                "no netsplit reached {CROWD} in the {CHURN:?} we were there — {} ordinary QUITs \
                 did, and the client kept the member list right across them, but the burst and \
                 the rejoin storm were never seen",
                all_quits.len()
            ),
        ),
    }
}

/// Two hostnames and nothing else is what a server puts in the QUIT it sends
/// for everyone on the far side of a split. Libera masks the names as
/// `*.net *.split`, which has the same shape.
fn looks_like_a_netsplit(reason: &str) -> bool {
    let mut halves = reason.split(' ');
    let (Some(left), Some(right), None) = (halves.next(), halves.next(), halves.next()) else {
        return false;
    };
    left.contains('.') && right.contains('.')
}

async fn part_and_rejoin(report: &mut Report, live: &mut Live) {
    live.send(SessionCommand::Part {
        channel: CHANNEL.into(),
        reason: Some("ircx verification run".into()),
    })
    .await;

    let parted = live
        .wait(Duration::from_secs(30), |event| match event {
            IrcxEvent::ChannelUpdated { channel } if channel.name == CHANNEL && !channel.joined => {
                Some(channel.member_count)
            }
            _ => None,
        })
        .await;
    match parted {
        Some(count) => report.check(
            "PART",
            count == 0,
            &format!("left {CHANNEL}, {count} members still held"),
        ),
        None => {
            report.fail("PART", "the channel never reported itself as left");
            live.dump("the last lines after the PART");
        }
    }

    live.send(SessionCommand::Join {
        channel: CHANNEL.into(),
        key: None,
    })
    .await;
    let rejoined = live
        .wait(Duration::from_secs(45), |event| match event {
            IrcxEvent::MembersReplaced {
                channel, members, ..
            } if channel == CHANNEL => Some(members.len()),
            _ => None,
        })
        .await;
    match rejoined {
        Some(count) => report.pass("rejoin", &format!("{count} members")),
        None => report.fail("rejoin", "no member list came back"),
    }
}

/// Collides with our own nick rather than someone else's: a second connection
/// asking for the nick the first one holds exercises both the registration
/// fallback and the after-registration warning without involving a stranger.
async fn nick_collision(report: &mut Report, live: &mut Live, store: Arc<Store>, nick: &str) {
    let alt = format!("{nick}a");
    let mut second = Live::start(config("libera-2", &alt, nick), store);

    let connected = second
        .wait(Duration::from_secs(60), |event| match event {
            IrcxEvent::ConnectionChanged {
                status: ConnectionStatus::Connected,
                ..
            } => Some(()),
            _ => None,
        })
        .await;
    if connected.is_none() {
        report.fail(
            "nick collision at registration",
            "the second connection never registered",
        );
        second.dump("the last lines from the second connection");
        second.stop().await;
        return;
    }

    let taken = second.seen_any(|event| match event {
        IrcxEvent::Notice { text, .. } if text.contains("is taken") => Some(text.clone()),
        _ => None,
    });
    let landed = second
        .snapshot()
        .await
        .and_then(|(network, _, _)| network.current_nick);
    report.check(
        "nick collision at registration",
        landed.as_deref() == Some(alt.as_str()),
        &format!("fell back to {landed:?}; said {taken:?}"),
    );

    live.submit("*", &format!("/nick {alt}")).await;
    let warned = live
        .wait(Duration::from_secs(30), |event| match event {
            IrcxEvent::Notice { text, .. } if text.contains("is taken") => Some(text.clone()),
            _ => None,
        })
        .await;
    match warned {
        Some(text) => report.pass("nick collision after registration", &text),
        None => {
            report.fail(
                "nick collision after registration",
                "no warning reached the UI",
            );
            live.dump("the last lines after the NICK");
        }
    }

    second.stop().await;
}

/// `WHOWAS`, off solanum and after the reconnect — which is what makes this
/// free: the socket this run dropped left a record of its own nick behind, so
/// nothing here has to connect again to have somebody to ask about.
///
/// Libera is the reason the block is tracked at all. It answers a nickname it
/// has never heard of with `369` and no `406` whatever, and it sends `312` and
/// `338` inside the block, where they mean where somebody was last seen rather
/// than where they are.
async fn a_record_of_somebody_who_has_gone(report: &mut Report, live: &mut Live, nick: &str) {
    live.submit(SERVER_TARGET, &format!("/whowas {nick}")).await;

    let seen = live
        .wait(Duration::from_secs(30), |event| match event {
            IrcxEvent::MessagesAppended { messages, .. } => messages
                .iter()
                .find(|message| message.text.starts_with(nick) && message.text.contains("was "))
                .cloned(),
            _ => None,
        })
        .await;
    match seen {
        Some(message) => report.pass("whowas", &message.text),
        None => {
            report.fail(
                "whowas",
                "the server remembered our own dropped session not at all",
            );
            live.dump("the last lines after the whowas");
        }
    }

    // `312` is the numeric a whois uses for the server somebody is connected
    // to, and it arrives after the `314` above rather than before it — waited
    // for rather than looked back at, or the answer is always that it never
    // came.
    let last_seen = live
        .wait(Duration::from_secs(15), |event| match event {
            IrcxEvent::MessagesAppended { messages, .. } => messages
                .iter()
                .find(|message| message.text.contains("was last seen on"))
                .cloned(),
            _ => None,
        })
        .await;
    match last_seen {
        Some(message) => report.pass("whowas says where they were last seen", &message.text),
        None => report.unverified("whowas 312", "no 312 arrived inside the block"),
    }

    live.submit(SERVER_TARGET, "/whowas nobodyeverhadthisnickatall")
        .await;
    match live
        .wait(Duration::from_secs(30), |event| match event {
            IrcxEvent::MessagesAppended { messages, .. } => messages
                .iter()
                .find(|message| message.text.contains("remembers no nickname"))
                .cloned(),
            _ => None,
        })
        .await
    {
        Some(message) => report.pass("whowas for a nickname nobody had", &message.text),
        None => report.fail(
            "whowas for a nickname nobody had",
            "Libera answered with 369 alone and the client said nothing",
        ),
    }
}

async fn ping_and_lag(report: &mut Report, live: &mut Live) {
    let lag = live
        .wait(Duration::from_secs(210), |event| match event {
            IrcxEvent::LagChanged { lag_ms, .. } => Some(*lag_ms),
            _ => None,
        })
        .await;
    match lag {
        Some(lag_ms) => report.pass("keepalive PING and lag", &format!("{lag_ms} ms")),
        None => report.fail("keepalive PING and lag", "no LagChanged inside 210 seconds"),
    }

    let server_pings = live
        .incoming
        .iter()
        .filter(|line| {
            Message::parse(line).is_ok_and(|m| m.command == Command::Named("PING".into()))
        })
        .count();
    let pongs = live
        .outgoing
        .iter()
        .filter(|line| line.starts_with("PONG"))
        .count();
    match server_pings {
        0 => report.unverified(
            "answering the server's own PING",
            "Libera never pinged us; our traffic kept the connection warm",
        ),
        _ => report.check(
            "answering the server's own PING",
            pongs >= server_pings,
            &format!("{server_pings} pings in, {pongs} pongs out"),
        ),
    }

    let snapshot = live
        .snapshot()
        .await
        .and_then(|(network, _, _)| network.lag_ms);
    report.check(
        "the measured lag reaches a snapshot",
        snapshot.is_some() || lag.is_none(),
        &format!("LagChanged said {lag:?}, the snapshot says {snapshot:?}"),
    );
}

/// Libera only pings a client that has gone quiet, and `ircx-core` sends its
/// own keepalive every two minutes, which resets that timer before it can
/// expire. The live session therefore cannot see an inbound PING however long
/// it runs. This is a bare socket that registers and then says nothing: the
/// PING it gets is a real one, and the answer is the one `SessionState`
/// produces when that exact line is fed to it.
async fn a_server_initiated_ping(nick: String) -> PingProbe {
    let attempt = Transport::connect(ConnectionConfig {
        host: HOST.into(),
        port: PORT,
        ..ConnectionConfig::default()
    })
    .await;
    let (mut transport, mut events) = match attempt {
        Ok(connected) => connected,
        Err(error) => return PingProbe::Refused(format!("could not connect: {error}")),
    };
    let sender = transport.sender();
    let _ = sender.send(format!("NICK {nick}"), 1).await;
    let _ = sender
        .send("USER ircxtest 0 * :ircx verification run", 2)
        .await;

    let deadline = Instant::now() + PING_WINDOW;
    let mut registered: Option<Instant> = None;
    let mut last = String::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let Ok(Some(event)) = timeout(left, events.recv()).await else {
            transport.shutdown().await;
            return match registered {
                Some(at) => PingProbe::Silent { idle: at.elapsed() },
                None => PingProbe::Refused(format!("never registered; last line {last:?}")),
            };
        };
        let line = match event {
            TransportEvent::Line(line) => line,
            TransportEvent::Connected { .. } => continue,
            TransportEvent::Disconnected { reason } => {
                return PingProbe::Refused(format!("the server hung up: {reason:?}"))
            }
        };
        let Ok(message) = Message::parse(&line) else {
            continue;
        };
        last = line.clone();
        match &message.command {
            Command::Numeric(1) => registered = Some(Instant::now()),
            Command::Named(name) if name.eq_ignore_ascii_case("ERROR") => {
                return PingProbe::Refused(line)
            }
            Command::Named(name) if name.eq_ignore_ascii_case("PING") => {
                let idle = registered.map(|at| at.elapsed()).unwrap_or_default();
                let pong = answer_for(&line);
                if let Some(pong) = pong.clone() {
                    let _ = sender.send(pong, 3).await;
                }
                let _ = sender.send("QUIT :ircx verification run finished", 4).await;
                // Let the QUIT reach the wire before the socket goes.
                let _ = timeout(Duration::from_secs(5), events.recv()).await;
                transport.shutdown().await;
                return PingProbe::Answered {
                    ping: line,
                    pong,
                    idle,
                };
            }
            _ => {}
        }
    }
}

/// What the client would reply, produced by the state machine the live session
/// runs on rather than written out by hand here.
fn answer_for(ping: &str) -> Option<String> {
    let nick = "ircx-probe";
    let mut state = SessionState::new(config("libera-ping", nick, nick));
    state.on_connected(None);
    state.on_line(":cadmium.libera.chat CAP * LS :");
    state.on_line(&format!(":cadmium.libera.chat 001 {nick} :Welcome"));
    state
        .on_line(ping)
        .into_iter()
        .find_map(|action| match action {
            Action::Send { line, .. } if line.to_ascii_uppercase().starts_with("PONG") => {
                Some(line)
            }
            _ => None,
        })
}

enum PingProbe {
    Answered {
        ping: String,
        pong: Option<String>,
        idle: Duration,
    },
    Silent {
        idle: Duration,
    },
    Refused(String),
}

impl PingProbe {
    fn report(self, report: &mut Report) {
        match self {
            PingProbe::Answered { ping, pong, idle } => {
                report.raw(&ping);
                let token = Message::parse(&ping)
                    .ok()
                    .and_then(|message| message.params.last().cloned())
                    .unwrap_or_default();
                let answered = pong
                    .as_deref()
                    .and_then(|line| Message::parse(line).ok())
                    .filter(|message| message.command == Command::Named("PONG".into()))
                    .and_then(|message| message.params.last().cloned());
                report.check(
                    "answering the server's own PING",
                    !token.is_empty() && answered.as_deref() == Some(token.as_str()),
                    &format!(
                        "after {idle:?} of silence the server sent PING {token:?}; the session \
                         answers {pong:?}"
                    ),
                );
                report.note(
                    "what that covers",
                    "the PING is off the wire and the PONG is the one SessionState emits for \
                     that line — the socket it arrived on is a bare Transport, not a running \
                     session task",
                );
            }
            PingProbe::Silent { idle } => report.unverified(
                "answering the server's own PING",
                &format!("Libera sent nothing to a socket idle for {idle:?} after registering"),
            ),
            PingProbe::Refused(why) => report.unverified(
                "answering the server's own PING",
                &format!("the probe never got an idle socket to wait on: {why}"),
            ),
        }
    }
}

/// Kills the socket from the far side by sending a bare `QUIT` that the session
/// never routed through `/quit`, so nothing asks the task to stop retrying.
async fn reconnect(report: &mut Report, live: &mut Live) {
    // Every JOIN after this point is the session's own idea, not this test's.
    let before_drop = live.outgoing.len();
    live.send(SessionCommand::Raw {
        line: "QUIT :ircx socket drop check".into(),
    })
    .await;

    let dropped = live
        .wait(Duration::from_secs(30), |event| match event {
            IrcxEvent::ConnectionChanged {
                status: ConnectionStatus::Disconnected,
                ..
            } => Some(()),
            _ => None,
        })
        .await;
    if dropped.is_none() {
        report.fail("socket drop", "the session never noticed the socket close");
        return;
    }

    let started = Instant::now();
    let back = live
        .wait(Duration::from_secs(120), |event| match event {
            IrcxEvent::ConnectionChanged {
                status: ConnectionStatus::Connected,
                ..
            } => Some(()),
            _ => None,
        })
        .await;
    match back {
        Some(()) => report.pass(
            "reconnect after the socket drops",
            &format!("registered again after {:?}", started.elapsed()),
        ),
        None => {
            report.fail("reconnect after the socket drops", "never came back");
            live.dump("the last lines during the reconnect");
            return;
        }
    }

    // `Connected` goes out on 001 and the rejoin is sent in answer to it, so
    // the channel is not joined again until the server echoes that JOIN back.
    // Waiting for the member list is waiting for exactly that; reading the
    // snapshot the moment the connection comes up reads it mid-flight.
    let members = live
        .wait(Duration::from_secs(45), |event| match event {
            IrcxEvent::MembersReplaced {
                channel, members, ..
            } if channel == CHANNEL => Some(members.len()),
            _ => None,
        })
        .await;
    let asked = live.outgoing[before_drop..]
        .iter()
        .filter(|line| {
            line.strip_prefix("JOIN ")
                .is_some_and(|rest| rest == CHANNEL)
        })
        .count();
    report.check(
        "a channel joined by hand comes back after a reconnect",
        members.is_some() && asked == 1,
        &format!(
            "{CHANNEL} came back with {members:?} members after {asked} JOIN the session sent \
             on its own; autojoin was empty and nothing here asked for it"
        ),
    );

    let rejoined = live.snapshot().await.and_then(|(_, channels, _)| {
        channels
            .iter()
            .find(|channel| channel.name == CHANNEL)
            .map(|channel| (channel.joined, channel.member_count))
    });
    report.check(
        "the reconnected session is usable",
        rejoined.map(|(joined, _)| joined) == Some(true),
        &format!("{CHANNEL} reads back as {rejoined:?}"),
    );
}

// Archive.

async fn archive(report: &mut Report, db: &Path, marker: &str, store: Arc<Store>) {
    let request = HistoryRequest {
        network: "libera".into(),
        target: CHANNEL.into(),
        before: None,
        before_id: None,
        limit: 500,
    };
    let live_rows = match store.load_history(&request) {
        Ok(rows) => rows,
        Err(error) => return report.fail("archive persists messages", &error.to_string()),
    };
    report.check(
        "archive persists messages",
        live_rows.iter().any(|row| row.text.contains(marker)),
        &format!("{} messages held for {CHANNEL}", live_rows.len()),
    );

    // The one message in here whose delivery the server confirmed. What the
    // archive kept for it is what a restart would show.
    if let Some(mine) = live_rows.iter().find(|row| row.text.contains(marker)) {
        report.check(
            "a confirmed delivery is written back to the archive",
            mine.delivery == Delivery::Delivered,
            &format!("stored as {:?}", mine.delivery),
        );
        report.note(
            "what the archive holds for our own message",
            &format!(
                "id {} (local: {}), timestamp {} (local: {})",
                mine.id, mine.id_is_local, mine.timestamp, mine.timestamp_is_local
            ),
        );
    }

    let seeded = seed(&store, &live_rows, ARCHIVE_MESSAGES);
    report.check(
        "the archive takes a few thousand messages",
        seeded,
        &format!("{ARCHIVE_MESSAGES} synthetic messages appended"),
    );
    let loaded = store
        .load_history(&HistoryRequest {
            limit: ARCHIVE_MESSAGES as u32 + 500,
            ..request.clone()
        })
        .unwrap_or_default();
    report.number(
        &format!("resident memory holding {} messages", loaded.len()),
        &proc_field("VmRSS").unwrap_or_else(|| "unknown".into()),
    );
    report.number(
        "peak resident memory for the whole run",
        &proc_field("VmHWM").unwrap_or_else(|| "unknown".into()),
    );

    drop(store);
    let reopened = Instant::now();
    let store = match Store::open(db) {
        Ok(store) => store,
        Err(error) => return report.fail("a fresh Store::open reloads them", &error.to_string()),
    };
    let elapsed = reopened.elapsed();
    let reloaded = store.load_history(&request).unwrap_or_default();
    report.check(
        "a fresh Store::open reloads them",
        reloaded.iter().any(|row| row.text.contains(marker)),
        &format!(
            "{} messages back after reopening in {elapsed:?}",
            reloaded.len()
        ),
    );
    report.number(
        &format!("Store::open over a {ARCHIVE_MESSAGES}-message archive"),
        &format!("{elapsed:?}"),
    );

    let hits = store
        .search(&SearchRequest {
            query: marker.into(),
            network: Some("libera".into()),
            target: None,
            sender: None,
            after: None,
            limit: 20,
        })
        .unwrap_or_default();
    report.check(
        "search finds them",
        hits.iter().any(|hit| hit.message.text.contains(marker)),
        &format!(
            "{} hits, first snippet {:?}",
            hits.len(),
            hits.first().map(|hit| hit.snippet.as_str()).unwrap_or("")
        ),
    );

    let archived = reloaded
        .iter()
        .find(|row| row.text.contains(marker))
        .map(|row| row.source);
    report.check(
        "source distinguishes live from archived",
        archived == Some(MessageSource::LocalArchive),
        &format!("a live message reports Live, the same row reloaded reports {archived:?}"),
    );

    let size = std::fs::metadata(db).map(|meta| meta.len()).unwrap_or(0);
    report.number(
        &format!("archive on disk, {} rows", loaded.len()),
        &format!("{} KiB", size / 1024),
    );
}

/// Copies a real message into `count` distinct rows so the archive numbers are
/// measured over something the same shape as real traffic.
fn seed(store: &Store, rows: &[ChatMessage], count: usize) -> bool {
    let Some(template) = rows.first() else {
        return false;
    };
    let batch: Vec<ChatMessage> = (0..count)
        .map(|index| ChatMessage {
            id: Uuid::new_v4().to_string(),
            id_is_local: true,
            text: format!("{} filler line {index}", template.text),
            ..template.clone()
        })
        .collect();
    store.append_messages(&batch).is_ok()
}

// Plumbing.

/// One running network plus everything it has said so far.
struct Live {
    handle: Option<NetworkHandle>,
    commands: mpsc::Sender<SessionCommand>,
    events: mpsc::Receiver<IrcxEvent>,
    seen: Vec<IrcxEvent>,
    incoming: Vec<String>,
    outgoing: Vec<String>,
    /// Both directions in the order they happened, for quoting in a bug report.
    transcript: Vec<String>,
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
            seen: Vec::new(),
            incoming: Vec::new(),
            outgoing: Vec::new(),
            transcript: Vec::new(),
        }
    }

    async fn send(&self, command: SessionCommand) {
        if self.commands.send(command).await.is_err() {
            println!("FAIL  the session task stopped taking commands");
        }
    }

    /// Reads events until `pick` matches or `limit` runs out, recording
    /// everything that goes past on the way.
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

    fn record(&mut self, event: IrcxEvent) {
        match event {
            IrcxEvent::RawLine {
                outgoing: true,
                line,
                ..
            } => {
                self.transcript.push(format!("> {line}"));
                self.outgoing.push(line);
            }
            IrcxEvent::RawLine {
                outgoing: false,
                line,
                ..
            } => {
                self.transcript.push(format!("< {line}"));
                self.incoming.push(line);
            }
            event => self.seen.push(event),
        }
    }

    fn seen_any<T>(&self, pick: impl FnMut(&IrcxEvent) -> Option<T>) -> Option<T> {
        self.seen.iter().rev().find_map(pick)
    }

    /// Every capability list under one `CAP` subcommand, values stripped.
    fn cap_list(&self, subcommand: &str) -> Vec<String> {
        let mut caps = Vec::new();
        for line in &self.incoming {
            let Ok(message) = Message::parse(line) else {
                continue;
            };
            if message.command != Command::Named("CAP".into())
                || message.param(1) != Some(subcommand)
            {
                continue;
            }
            let list = message
                .params
                .last()
                .map(String::as_str)
                .unwrap_or_default();
            for entry in list.split_whitespace() {
                let name = entry.split_once('=').map_or(entry, |(name, _)| name);
                caps.push(name.to_string());
            }
        }
        caps
    }

    async fn snapshot(&self) -> Option<(Network, Vec<Channel>, Vec<Query>)> {
        let (reply, answer) = oneshot::channel();
        self.send(SessionCommand::Snapshot { reply }).await;
        timeout(Duration::from_secs(10), answer).await.ok()?.ok()
    }

    async fn members(&self, channel: &str) -> Option<Vec<Member>> {
        let (reply, answer) = oneshot::channel();
        self.send(SessionCommand::Members {
            channel: channel.into(),
            reply,
        })
        .await;
        timeout(Duration::from_secs(10), answer).await.ok()?.ok()
    }

    async fn submit(&self, target: &str, input: &str) -> Option<CommandOutcome> {
        let (reply, answer) = oneshot::channel();
        self.send(SessionCommand::Submit {
            target: target.into(),
            input: input.into(),
            reply_to: None,
            reply,
        })
        .await;
        timeout(Duration::from_secs(10), answer).await.ok()?.ok()
    }

    fn dump(&self, why: &str) {
        println!("      {why}:");
        for line in self.incoming.iter().rev().take(15).rev() {
            println!("      < {line}");
        }
        for line in self.outgoing.iter().rev().take(5).rev() {
            println!("      > {line}");
        }
    }

    async fn stop(mut self) {
        if let Some(handle) = self.handle.take() {
            handle
                .shutdown(Some("ircx verification run finished".into()))
                .await;
        }
    }
}

fn numeric_for(line: &str, code: u16, target: &str) -> bool {
    Message::parse(line).is_ok_and(|message| {
        message.command == Command::Numeric(code)
            && message.params.iter().any(|param| param == target)
    })
}

fn is_numeric(line: &str, code: u16) -> bool {
    Message::parse(line).is_ok_and(|message| message.command == Command::Numeric(code))
}

fn sample(members: &[Member]) -> String {
    format!(
        "{:?}",
        members
            .iter()
            .take(6)
            .map(|member| format!("{}{}", member.prefixes.concat(), member.nick))
            .collect::<Vec<_>>()
    )
}

/// The run asserts `CASEMAPPING=rfc1459` before any of this, so comparing nicks
/// the way the server does means folding them the way the server said.
fn fold(text: &str) -> String {
    CaseMapping::Rfc1459.fold(text)
}

/// How long ago this process was exec'd, from the kernel's own record, so a
/// cold-start figure covers what happened before `main` as well as after it.
fn since_exec() -> Option<Duration> {
    /// `/proc` reports process times in these, whatever the kernel's own tick.
    const USER_HZ: f64 = 100.0;

    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    // The command name can hold spaces and brackets, so fields are counted from
    // its closing bracket. `starttime` is field 22, the twentieth after it.
    let after_comm = stat.rsplit_once(')')?.1;
    let ticks: f64 = after_comm.split_whitespace().nth(19)?.parse().ok()?;
    let uptime = std::fs::read_to_string("/proc/uptime").ok()?;
    let uptime: f64 = uptime.split_whitespace().next()?.parse().ok()?;
    Duration::try_from_secs_f64(uptime - ticks / USER_HZ).ok()
}

fn proc_field(name: &str) -> Option<String> {
    let status = std::fs::read_to_string(PathBuf::from("/proc/self/status")).ok()?;
    status
        .lines()
        .find(|line| line.starts_with(name))
        .map(|line| line[name.len() + 1..].trim().to_string())
}

#[derive(Default)]
struct Report {
    failures: Vec<String>,
    unverified: Vec<String>,
    numbers: Vec<(String, String)>,
}

impl Report {
    fn pass(&mut self, what: &str, detail: &str) {
        println!("PASS  {what}: {detail}");
    }

    fn fail(&mut self, what: &str, detail: &str) {
        println!("FAIL  {what}: {detail}");
        self.failures.push(format!("{what}: {detail}"));
    }

    fn check(&mut self, what: &str, ok: bool, detail: &str) {
        match ok {
            true => self.pass(what, detail),
            false => self.fail(what, detail),
        }
    }

    fn unverified(&mut self, what: &str, why: &str) {
        println!("SKIP  {what}: {why}");
        self.unverified.push(format!("{what}: {why}"));
    }

    fn note(&mut self, what: &str, detail: &str) {
        println!("NOTE  {what}: {detail}");
    }

    fn raw(&mut self, line: &str) {
        println!("RAW   < {line}");
    }

    fn list(&mut self, what: &str, items: &[String]) {
        println!("LIST  {what} ({}): {}", items.len(), items.join(" "));
    }

    fn number(&mut self, what: &str, value: &str) {
        println!("NUM   {what}: {value}");
        self.numbers.push((what.into(), value.into()));
    }

    fn finish(&self) {
        println!("\n=== measured ===");
        for (what, value) in &self.numbers {
            println!("  {what}: {value}");
        }
        if !self.unverified.is_empty() {
            println!("\n=== not verified ===");
            for line in &self.unverified {
                println!("  {line}");
            }
        }
        println!("\n=== {} failures ===", self.failures.len());
        for line in &self.failures {
            println!("  {line}");
        }
        // The run is a report, not a gate: the failures above are the output.
    }
}
