//! Transport behaviour against a plaintext loopback listener. TLS needs a
//! certificate fixture and is not covered here.

use std::time::Duration;

use ircx_net::{
    ConnectionConfig, DisconnectReason, NetError, RateLimit, Transport, TransportEvent,
    MAX_LINE_BYTES,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc::Receiver;

async fn listener() -> (TcpListener, ConnectionConfig) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local addr");
    let config = ConnectionConfig {
        host: addr.ip().to_string(),
        port: addr.port(),
        tls: false,
        connect_timeout: Duration::from_secs(5),
        ..ConnectionConfig::default()
    };
    (listener, config)
}

async fn connected() -> (TcpStream, Transport, Receiver<TransportEvent>) {
    let (listener, config) = listener().await;
    let client = tokio::spawn(Transport::connect(config));
    let (server, _) = listener.accept().await.expect("accept");
    let (transport, mut events) = client.await.expect("join").expect("connect");

    match events.recv().await {
        Some(TransportEvent::Connected { tls_info }) => assert!(tls_info.is_none()),
        other => panic!("expected Connected, got {other:?}"),
    }
    (server, transport, events)
}

async fn next_line(events: &mut Receiver<TransportEvent>) -> String {
    match events.recv().await {
        Some(TransportEvent::Line(line)) => line,
        other => panic!("expected a line, got {other:?}"),
    }
}

async fn next_reason(events: &mut Receiver<TransportEvent>) -> DisconnectReason {
    match events.recv().await {
        Some(TransportEvent::Disconnected { reason }) => reason,
        other => panic!("expected Disconnected, got {other:?}"),
    }
}

#[tokio::test]
async fn frames_lines_split_across_reads() {
    let (mut server, _transport, mut events) = connected().await;

    server.write_all(b":srv 001 me :Wel").await.expect("write");
    server.flush().await.expect("flush");
    tokio::task::yield_now().await;
    server
        .write_all(b"come\r\nPING :a\nPING :b\r")
        .await
        .expect("write");
    server.flush().await.expect("flush");
    tokio::task::yield_now().await;
    server.write_all(b"\n").await.expect("write");

    assert_eq!(next_line(&mut events).await, ":srv 001 me :Welcome");
    assert_eq!(next_line(&mut events).await, "PING :a");
    assert_eq!(next_line(&mut events).await, "PING :b");
}

#[tokio::test]
async fn recovers_from_an_overlong_line_and_invalid_utf8() {
    let (mut server, _transport, mut events) = connected().await;

    let mut flood = vec![b'x'; MAX_LINE_BYTES * 2];
    flood.extend_from_slice(b"\r\n");
    server.write_all(&flood).await.expect("write");
    server
        .write_all(b"PRIVMSG #a :caf\xe9\r\n")
        .await
        .expect("write");

    assert_eq!(next_line(&mut events).await, "PRIVMSG #a :caf\u{fffd}");
}

#[tokio::test]
async fn sends_lines_with_crlf() {
    let (mut server, transport, _events) = connected().await;
    let sender = transport.sender();

    sender.send("NICK me").await.expect("send");
    sender
        .send(String::from("USER me 0 * :me"))
        .await
        .expect("send");

    let mut buf = vec![0u8; 64];
    let read = server.read(&mut buf).await.expect("read");
    assert_eq!(&buf[..read], b"NICK me\r\nUSER me 0 * :me\r\n");
}

#[tokio::test]
async fn refuses_a_line_carrying_its_own_terminator() {
    let (_server, transport, _events) = connected().await;

    let error = transport
        .sender()
        .send("NICK me\r\nJOIN #ops")
        .await
        .expect_err("embedded newline must be refused");
    assert!(matches!(error, NetError::EmbeddedNewline));
}

#[tokio::test]
async fn reports_the_server_hanging_up() {
    let (server, _transport, mut events) = connected().await;
    drop(server);

    assert_eq!(
        next_reason(&mut events).await,
        DisconnectReason::ServerClosed
    );
}

#[tokio::test]
async fn shutdown_closes_the_socket_without_sending_anything() {
    let (mut server, mut transport, mut events) = connected().await;

    transport.shutdown().await;

    assert_eq!(next_reason(&mut events).await, DisconnectReason::Shutdown);
    let mut buf = Vec::new();
    server.read_to_end(&mut buf).await.expect("read to end");
    assert!(buf.is_empty(), "shutdown wrote {buf:?}");
}

#[tokio::test]
async fn sending_after_shutdown_reports_a_closed_connection() {
    let (_server, mut transport, _events) = connected().await;
    let sender = transport.sender();
    transport.shutdown().await;
    drop(transport);

    let error = sender.send("PING :x").await.expect_err("send must fail");
    assert!(matches!(error, NetError::Closed));
}

#[tokio::test]
async fn a_dropped_event_receiver_tears_the_connection_down() {
    let (mut server, _transport, events) = connected().await;
    drop(events);

    server.write_all(b"PING :x\r\n").await.expect("write");

    let mut buf = Vec::new();
    server.read_to_end(&mut buf).await.expect("read to end");
    assert!(buf.is_empty(), "expected a clean close, got {buf:?}");
}

#[tokio::test]
async fn connect_reports_a_refused_port() {
    let (listener, config) = listener().await;
    drop(listener);

    let error = Transport::connect(config)
        .await
        .err()
        .expect("connect must fail");
    assert!(matches!(error, NetError::Connect { .. }), "{error}");
}

#[tokio::test]
async fn connect_gives_up_after_the_timeout() {
    // 203.0.113.0/24 is reserved for documentation, so nothing answers.
    let config = ConnectionConfig {
        host: "203.0.113.1".to_owned(),
        port: 6697,
        connect_timeout: Duration::from_millis(150),
        ..ConnectionConfig::default()
    };

    let error = Transport::connect(config)
        .await
        .err()
        .expect("connect must fail");
    assert!(
        matches!(
            error,
            NetError::ConnectTimeout { .. } | NetError::Connect { .. }
        ),
        "{error}"
    );
}

#[tokio::test(start_paused = true)]
async fn outbound_lines_are_paced_after_the_burst() {
    let (listener, config) = listener().await;
    let limit = RateLimit {
        burst: 2,
        interval: Duration::from_millis(500),
    };
    let client = tokio::spawn(Transport::connect_with(config, limit));
    let (mut server, _) = listener.accept().await.expect("accept");
    let (transport, _events) = client.await.expect("join").expect("connect");

    let sender = transport.sender();
    for index in 0..4 {
        sender.send(format!("PING :{index}")).await.expect("send");
    }

    let start = tokio::time::Instant::now();
    let mut seen = Vec::new();
    while seen.len() < 4 {
        let mut buf = vec![0u8; 128];
        let read = server.read(&mut buf).await.expect("read");
        for line in buf[..read].split(|b| *b == b'\n') {
            if !line.is_empty() {
                seen.push(String::from_utf8_lossy(line).trim_end().to_owned());
            }
        }
    }

    assert_eq!(seen, vec!["PING :0", "PING :1", "PING :2", "PING :3"]);
    assert!(
        start.elapsed() >= Duration::from_millis(1000),
        "{:?}",
        start.elapsed()
    );
}
