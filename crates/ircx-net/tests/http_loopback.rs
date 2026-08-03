//! The preview fetch against a scripted loopback listener. Nothing here
//! resolves a name or opens a socket off this machine.

use std::time::Duration;

use ircx_net::http::{fetch, FetchPolicy, HttpError};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

fn policy() -> FetchPolicy {
    FetchPolicy {
        allow_local_addresses: true,
        timeout: Duration::from_secs(5),
        accept: "image/png".to_owned(),
        ..FetchPolicy::default()
    }
}

/// Serves each connection one scripted reply in turn, and reports the first
/// request it was sent. Replies are raw bytes so a test can send framing no
/// well-behaved server would.
async fn serve(replies: Vec<Vec<u8>>) -> (String, oneshot::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let (seen_tx, seen_rx) = oneshot::channel();

    tokio::spawn(async move {
        let mut seen_tx = Some(seen_tx);
        for reply in replies {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut request = vec![0u8; 2048];
            let read = socket.read(&mut request).await.unwrap_or(0);
            if let Some(tx) = seen_tx.take() {
                let _ = tx.send(String::from_utf8_lossy(&request[..read]).into_owned());
            }
            let _ = socket.write_all(&reply).await;
            let _ = socket.shutdown().await;
        }
    });

    (base, seen_rx)
}

fn reply(head: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = head.replace('\n', "\r\n").into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

#[tokio::test]
async fn reads_a_body_with_a_declared_length() {
    let (base, seen) = serve(vec![reply(
        "HTTP/1.1 200 OK\nContent-Type: image/png\nContent-Length: 5\n\n",
        b"bytes",
    )])
    .await;

    let fetched = fetch(&format!("{base}/a.png"), &policy())
        .await
        .expect("fetch");
    assert_eq!(fetched.body, b"bytes");
    assert_eq!(fetched.content_type.as_deref(), Some("image/png"));
    assert_eq!(fetched.url, format!("{base}/a.png"));

    let request = seen.await.expect("request");
    assert!(request.starts_with("GET /a.png HTTP/1.1\r\n"), "{request}");
    assert!(request.contains("Accept: image/png\r\n"), "{request}");
    assert!(request.contains("Connection: close\r\n"), "{request}");
    assert!(
        !request.to_ascii_lowercase().contains("cookie"),
        "{request}"
    );
    assert!(
        !request.to_ascii_lowercase().contains("referer"),
        "{request}"
    );
}

#[tokio::test]
async fn reads_a_chunked_body_with_an_extension_on_a_chunk() {
    let (base, _) = serve(vec![reply(
        "HTTP/1.1 200 OK\nTransfer-Encoding: chunked\n\n",
        b"3;name=x\r\nabc\r\n2\r\nde\r\n0\r\n\r\n",
    )])
    .await;

    let fetched = fetch(&format!("{base}/a.png"), &policy())
        .await
        .expect("fetch");
    assert_eq!(fetched.body, b"abcde");
}

#[tokio::test]
async fn reads_a_body_that_ends_only_when_the_server_hangs_up() {
    let (base, _) = serve(vec![reply("HTTP/1.1 200 OK\n\n", b"trailing bytes")]).await;

    let fetched = fetch(&format!("{base}/a.png"), &policy())
        .await
        .expect("fetch");
    assert_eq!(fetched.body, b"trailing bytes");
}

#[tokio::test]
async fn refuses_a_declared_length_over_the_cap_without_reading_the_body() {
    let (base, _) = serve(vec![reply(
        "HTTP/1.1 200 OK\nContent-Length: 104857600\n\n",
        b"only a little arrives",
    )])
    .await;

    let error = fetch(&format!("{base}/big.png"), &policy())
        .await
        .expect_err("must refuse");
    assert!(matches!(error, HttpError::TooLarge { .. }), "{error}");
}

#[tokio::test]
async fn refuses_an_undeclared_body_over_the_cap() {
    let limits = FetchPolicy {
        max_bytes: 16,
        ..policy()
    };
    let (base, _) = serve(vec![reply("HTTP/1.1 200 OK\n\n", &[b'x'; 64])]).await;

    let error = fetch(&format!("{base}/big.png"), &limits)
        .await
        .expect_err("must refuse");
    assert!(matches!(error, HttpError::TooLarge { .. }), "{error}");
}

#[tokio::test]
async fn refuses_a_chunked_body_over_the_cap() {
    let limits = FetchPolicy {
        max_bytes: 16,
        ..policy()
    };
    let (base, _) = serve(vec![reply(
        "HTTP/1.1 200 OK\nTransfer-Encoding: chunked\n\n",
        b"40\r\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n0\r\n\r\n",
    )])
    .await;

    let error = fetch(&format!("{base}/big.png"), &limits)
        .await
        .expect_err("must refuse");
    assert!(matches!(error, HttpError::TooLarge { .. }), "{error}");
}

/// A size that would wrap the running total past the cap if it were added to
/// it rather than subtracted from it.
#[tokio::test]
async fn refuses_a_chunk_declaring_the_whole_address_space() {
    let (base, _) = serve(vec![reply(
        "HTTP/1.1 200 OK\nTransfer-Encoding: chunked\n\n",
        b"ffffffffffffffff\r\nxxxx\r\n0\r\n\r\n",
    )])
    .await;

    let error = fetch(&format!("{base}/big.png"), &policy())
        .await
        .expect_err("must refuse");
    assert!(matches!(error, HttpError::TooLarge { .. }), "{error}");
}

#[tokio::test]
async fn refuses_a_head_that_never_ends() {
    let mut head = "HTTP/1.1 200 OK\r\n".to_owned();
    for index in 0..2000 {
        head.push_str(&format!("X-Pad-{index}: {}\r\n", "y".repeat(64)));
    }
    let (base, _) = serve(vec![head.into_bytes()]).await;

    let error = fetch(&format!("{base}/a.png"), &policy())
        .await
        .expect_err("must refuse");
    assert!(matches!(error, HttpError::Malformed { .. }), "{error}");
}

#[tokio::test]
async fn refuses_a_reply_that_is_not_http() {
    let (base, _) = serve(vec![b"NOTICE * :this is an irc server\r\n".to_vec()]).await;

    let error = fetch(&format!("{base}/a.png"), &policy())
        .await
        .expect_err("must refuse");
    assert!(matches!(error, HttpError::Malformed { .. }), "{error}");
}

#[tokio::test]
async fn follows_a_redirect_within_the_same_host() {
    let (base, _) = serve(vec![
        reply(
            "HTTP/1.1 302 Found\nLocation: /b.png\nContent-Length: 0\n\n",
            b"",
        ),
        reply("HTTP/1.1 200 OK\nContent-Length: 2\n\n", b"ok"),
    ])
    .await;

    let fetched = fetch(&format!("{base}/a.png"), &policy())
        .await
        .expect("fetch");
    assert_eq!(fetched.body, b"ok");
    assert_eq!(fetched.url, format!("{base}/b.png"));
}

#[tokio::test]
async fn reports_a_status_that_is_not_success() {
    let (base, _) = serve(vec![reply(
        "HTTP/1.1 404 Not Found\nContent-Length: 0\n\n",
        b"",
    )])
    .await;

    let error = fetch(&format!("{base}/gone.png"), &policy())
        .await
        .expect_err("must fail");
    match error {
        HttpError::Status { status, .. } => assert_eq!(status, 404),
        other => panic!("expected a status error, got {other}"),
    }
}

#[tokio::test]
async fn refuses_a_redirect_to_another_host() {
    let (base, _) = serve(vec![reply(
        "HTTP/1.1 301 Moved Permanently\nLocation: https://tracker.example/a.png\nContent-Length: 0\n\n",
        b"",
    )])
    .await;

    let error = fetch(&format!("{base}/a.png"), &policy())
        .await
        .expect_err("must refuse");
    match error {
        HttpError::CrossHostRedirect { target, .. } => assert_eq!(target, "tracker.example"),
        other => panic!("expected a cross-host refusal, got {other}"),
    }
}

#[tokio::test]
async fn gives_up_on_a_server_redirecting_to_itself() {
    let looping = reply(
        "HTTP/1.1 302 Found\nLocation: /a.png\nContent-Length: 0\n\n",
        b"",
    );
    let (base, _) = serve(vec![
        looping.clone(),
        looping.clone(),
        looping.clone(),
        looping,
    ])
    .await;

    let error = fetch(&format!("{base}/a.png"), &policy())
        .await
        .expect_err("must give up");
    assert!(
        matches!(error, HttpError::TooManyRedirects { .. }),
        "{error}"
    );
}

#[tokio::test]
async fn refuses_a_loopback_address_unless_the_caller_allows_it() {
    let (base, _) = serve(vec![reply("HTTP/1.1 200 OK\nContent-Length: 2\n\n", b"ok")]).await;

    let error = fetch(&format!("{base}/a.png"), &FetchPolicy::default())
        .await
        .expect_err("must refuse");
    assert!(matches!(error, HttpError::LocalAddress { .. }), "{error}");
}

#[tokio::test]
async fn gives_up_on_a_server_that_never_answers() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    tokio::spawn(async move {
        let _accepted = listener.accept().await;
        std::future::pending::<()>().await;
    });

    let limits = FetchPolicy {
        timeout: Duration::from_millis(200),
        ..policy()
    };
    let error = fetch(&format!("{base}/a.png"), &limits)
        .await
        .expect_err("must time out");
    assert!(matches!(error, HttpError::Timeout { .. }), "{error}");
}

#[tokio::test]
async fn refuses_a_url_that_is_not_http() {
    for url in ["ftp://files.example/a.png", "data:image/png;base64,AAAA"] {
        let error = fetch(url, &policy()).await.expect_err("must refuse");
        assert!(
            matches!(error, HttpError::UnsupportedUrl { .. }),
            "{url}: {error}"
        );
    }
}

/// A URL is the one part of a request that comes from whoever spoke in the
/// channel. `Target::parse` builds the request line and the `Host` header from
/// it without going through `single_line`, so what stops a newline reaching the
/// wire is the `http` crate's `Uri` refusing to parse one — a property of a
/// dependency rather than of this file, and worth a test that would notice it
/// changing.
///
/// The percent-encoded form is not the same question: `%0d%0a` stays encoded
/// through the path and is one token on the wire, which is correct.
#[tokio::test]
async fn a_url_carrying_a_newline_never_reaches_the_wire() {
    for url in [
        "http://example.invalid/a\r\nX-Injected: 1",
        "http://example.invalid/a\nX-Injected: 1",
        "http://example.invalid\r\n/a",
        "http://exam\r\nple.invalid/a",
    ] {
        let error = fetch(url, &policy()).await.expect_err("must refuse");
        assert!(
            matches!(error, HttpError::UnsupportedUrl { .. }),
            "{url:?}: {error}"
        );
    }
}

/// Sending them would hand a password to whichever host the link named, and
/// the link was written by somebody else.
#[tokio::test]
async fn a_url_carrying_credentials_is_refused_by_name() {
    let error = fetch("http://user:pass@example.invalid/a", &policy())
        .await
        .expect_err("must refuse");
    assert!(
        matches!(error, HttpError::CredentialsInUrl { .. }),
        "{error}"
    );
    assert!(
        error.to_string().contains("username"),
        "the sentence should say what is wrong: {error}"
    );
}
