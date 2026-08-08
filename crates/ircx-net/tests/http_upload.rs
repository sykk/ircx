//! Sending a file to a provider, against a scripted loopback listener. Nothing
//! here resolves a name or opens a socket off this machine.

use std::time::Duration;

use ircx_net::http::{upload, HttpError, UploadMethod, UploadPolicy};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

fn policy() -> UploadPolicy {
    UploadPolicy {
        timeout: Duration::from_secs(5),
        ..UploadPolicy::default()
    }
}

/// Serves one scripted reply and reports the whole request it was sent, head
/// and body together — an upload is judged by what went out as much as by what
/// came back.
async fn serve(reply: &'static str) -> (String, oneshot::Receiver<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let base = format!("http://{}", listener.local_addr().expect("addr"));
    let (seen_tx, seen_rx) = oneshot::channel();

    tokio::spawn(async move {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        let mut request = Vec::new();
        let mut chunk = vec![0u8; 4096];
        // Read until the declared body has arrived, which for these sizes is
        // one or two reads.
        loop {
            let read = socket.read(&mut chunk).await.unwrap_or(0);
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            if let Some(at) = String::from_utf8_lossy(&request).find("\r\n\r\n") {
                let declared = String::from_utf8_lossy(&request[..at])
                    .to_lowercase()
                    .split("content-length:")
                    .nth(1)
                    .and_then(|rest| rest.split("\r\n").next()?.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if request.len() >= at + 4 + declared {
                    break;
                }
            }
        }
        let _ = seen_tx.send(request);
        let _ = socket.write_all(reply.as_bytes()).await;
        let _ = socket.shutdown().await;
    });

    (base, seen_rx)
}

fn head_of(request: &[u8]) -> String {
    let text = String::from_utf8_lossy(request);
    let at = text.find("\r\n\r\n").unwrap_or(text.len());
    text[..at].to_owned()
}

fn body_of(request: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(request).into_owned();
    match text.find("\r\n\r\n") {
        Some(at) => request[at + 4..].to_vec(),
        None => Vec::new(),
    }
}

#[tokio::test]
async fn the_file_goes_out_with_its_length_declared() {
    let (base, seen) =
        serve("HTTP/1.1 200 OK\r\nContent-Length: 24\r\n\r\nhttps://files/a1b2c3.png").await;

    let answer = upload(
        &format!("{base}/a1b2c3.png"),
        b"the bytes of a file",
        &policy(),
    )
    .await
    .expect("the provider took it");

    assert_eq!(answer.status, 200);
    assert_eq!(answer.body, "https://files/a1b2c3.png");

    let request = seen.await.expect("the request");
    let head = head_of(&request);
    assert!(head.starts_with("PUT /a1b2c3.png HTTP/1.1"), "{head}");
    assert!(head.contains("Content-Length: 19"), "{head}");
    assert_eq!(body_of(&request), b"the bytes of a file");
}

#[tokio::test]
async fn a_post_says_so() {
    let (base, seen) = serve("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nok!").await;

    upload(
        &format!("{base}/upload"),
        b"x",
        &UploadPolicy {
            method: UploadMethod::Post,
            ..policy()
        },
    )
    .await
    .expect("the provider took it");

    assert!(head_of(&seen.await.expect("the request")).starts_with("POST /upload HTTP/1.1"));
}

/// Where a token goes. Sent verbatim and last, so a provider wanting its own
/// `Content-Type` can say so and be believed.
#[tokio::test]
async fn configured_headers_are_sent() {
    let (base, seen) = serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await;

    upload(
        &format!("{base}/x"),
        b"x",
        &UploadPolicy {
            headers: vec![("Authorization".into(), "Bearer sekrit".into())],
            content_type: "image/png".into(),
            ..policy()
        },
    )
    .await
    .expect("uploaded");

    let head = head_of(&seen.await.expect("the request"));
    assert!(head.contains("Authorization: Bearer sekrit"), "{head}");
    assert!(head.contains("Content-Type: image/png"), "{head}");
}

/// A token pasted with a stray newline would otherwise write a second request
/// into the first, and the failure would read as the provider rejecting a good
/// token.
#[tokio::test]
async fn a_header_cannot_carry_a_second_request() {
    let (base, seen) = serve("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await;

    upload(
        &format!("{base}/x"),
        b"x",
        &UploadPolicy {
            headers: vec![("Authorization".into(), "Bearer a\r\nX-Injected: yes".into())],
            ..policy()
        },
    )
    .await
    .expect("uploaded");

    let head = head_of(&seen.await.expect("the request"));
    // The characters survive — they are part of the value the user pasted —
    // but not as a header of their own, which is the whole difference.
    assert!(!head.contains("\r\nX-Injected:"), "{head}");
    assert!(
        head.contains("Authorization: Bearer aX-Injected: yes"),
        "{head}"
    );
    assert_eq!(
        head.lines()
            .filter(|line| line.starts_with("Authorization:"))
            .count(),
        1,
        "{head}"
    );
}

/// A provider that answers 201 puts the object's address in `Location` and
/// leaves the body empty.
#[tokio::test]
async fn a_created_reply_is_read_from_its_location() {
    let (base, _seen) = serve(
        "HTTP/1.1 201 Created\r\nLocation: https://files.example.com/x.png\r\nContent-Length: 0\r\n\r\n",
    )
    .await;

    let answer = upload(&format!("{base}/x.png"), b"x", &policy())
        .await
        .expect("uploaded");

    assert_eq!(answer.status, 201);
    assert_eq!(answer.body, "https://files.example.com/x.png");
}

#[tokio::test]
async fn a_no_content_reply_is_not_a_failure() {
    let (base, _seen) = serve("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n").await;

    let answer = upload(&format!("{base}/x.png"), b"x", &policy())
        .await
        .expect("uploaded");

    assert_eq!(answer.status, 204);
    assert_eq!(answer.body, "");
}

/// Following it would put the user's file on a host they never configured.
#[tokio::test]
async fn a_redirect_is_refused_rather_than_followed() {
    let (base, _seen) = serve(
        "HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example.com/x\r\nContent-Length: 0\r\n\r\n",
    )
    .await;

    let failure = upload(&format!("{base}/x"), b"x", &policy())
        .await
        .expect_err("a redirect is not followed");

    assert!(
        matches!(&failure, HttpError::Redirected { to, .. } if to == "https://elsewhere.example.com/x"),
        "got {failure:?}"
    );
}

#[tokio::test]
async fn a_refusal_carries_the_status() {
    let (base, _seen) = serve("HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n").await;

    let failure = upload(&format!("{base}/x"), b"x", &policy())
        .await
        .expect_err("413 is a refusal");

    assert!(
        matches!(failure, HttpError::Status { status: 413, .. }),
        "got {failure:?}"
    );
}

/// The provider's answer is a URL, not a download.
#[tokio::test]
async fn an_overlong_reply_is_refused() {
    let long = "x".repeat(4096);
    let reply: &'static str = Box::leak(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{long}",
            long.len()
        )
        .into_boxed_str(),
    );
    let (base, _seen) = serve(reply).await;

    let failure = upload(
        &format!("{base}/x"),
        b"x",
        &UploadPolicy {
            max_reply_bytes: 128,
            ..policy()
        },
    )
    .await
    .expect_err("the reply is capped");

    assert!(
        matches!(failure, HttpError::TooLarge { .. }),
        "got {failure:?}"
    );
}

/// The opposite of a fetch, and deliberately so: self-hosted storage on a home
/// network is the provider kind the spec names first, and every test in this
/// file depends on it.
#[tokio::test]
async fn a_local_provider_is_allowed_by_default() {
    assert!(UploadPolicy::default().allow_local_addresses);
}

/// A host that frames its reply, which is most of them and is the whole of what
/// a form host's reply is for. Before this the framing came back as the answer
/// — `24\r\nhttps://…\r\n0` — which is not a link, so the client fell back to
/// the address it had posted to and put the API endpoint in the conversation.
/// Found against litterbox.
#[tokio::test]
async fn a_chunked_reply_is_the_link_rather_than_its_framing() {
    let (base, _seen) = serve(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
         24\r\nhttps://litter.catbox.moe/4hlzia.png\r\n0\r\n\r\n",
    )
    .await;

    let answer = upload(&format!("{base}/api"), b"x", &policy())
        .await
        .expect("the host accepted it");

    assert_eq!(answer.body, "https://litter.catbox.moe/4hlzia.png");
}
