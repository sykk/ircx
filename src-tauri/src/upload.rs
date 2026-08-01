//! Sending a file to the configured provider and getting a link back.
//!
//! The window reads nothing and sends nothing: it hands over a path the user
//! chose and receives the address the file now has. What goes into the
//! conversation is that address, typed into the composer like any other line —
//! which is what "fall back to a normal link in traditional clients" means when
//! there is no attachment protocol to fall back from.

use std::path::Path;

use ircx_ipc::{FileToUpload, S3Credentials, UploadMethod, UploadProvider, UploadedFile};
use ircx_net::http::{
    head, signing_target, upload, FetchPolicy, HttpError, UploadMethod as NetMethod, UploadPolicy,
};
use time::OffsetDateTime;

use crate::sigv4::{self, Credentials};
use crate::state::{describe, App};

/// The largest file this will read into memory before sending it.
///
/// The upload is one buffer rather than a stream, which is the simple thing and
/// costs a copy of the file. A cap is what keeps that honest: a user who drags
/// a disc image should be told no, not watched while the client tries.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Random bytes in front of the file's own name.
///
/// Two people uploading `screenshot.png` must not overwrite each other, and a
/// provider addressed by path has no other way to keep them apart.
const PREFIX_BYTES: usize = 8;

/// What the provider is told the file is.
///
/// Short on purpose: these are the types the client itself previews, and
/// claiming a type for anything else would be guessing on the user's behalf
/// about a file it cannot read. Everything else is bytes, which is true.
fn content_type(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// The name the file is stored under: a random prefix, then as much of the
/// user's own name as is safe to repeat back.
///
/// Path separators and control characters go, because this is interpolated into
/// a URL the client then requests. `..` would otherwise let a file name choose
/// where on the provider it lands.
pub fn object_name(file_name: &str, random: &[u8]) -> String {
    let prefix = sigv4::hex(random);
    let safe: String = file_name
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => c,
            _ => '-',
        })
        .collect();
    // A leading dot would make a hidden file of it on some providers, and a
    // name that was entirely unsafe characters would leave nothing at all.
    let safe = safe.trim_matches(['.', '-']);
    let safe: String = safe.chars().take(64).collect();
    match safe.is_empty() {
        true => prefix,
        false => format!("{prefix}-{safe}"),
    }
}

/// Where the file is sent. An endpoint naming `{name}` addresses the object by
/// path; one that does not is a host that names the object itself.
fn endpoint_for(endpoint: &str, name: &str) -> String {
    endpoint.replace("{name}", name)
}

/// The address the file now has.
///
/// A provider that answered with a URL is believed — that is the whole of what
/// a POST host's reply is for. One that answered with nothing has stored the
/// object where it was put, so the request URL is the answer.
pub fn link_from(reply: &str, request_url: &str) -> String {
    let answer = reply.trim();
    match answer.starts_with("https://") || answer.starts_with("http://") {
        true => answer.to_owned(),
        false => request_url.to_owned(),
    }
}

fn net_method(method: UploadMethod) -> NetMethod {
    match method {
        UploadMethod::Put => NetMethod::Put,
        UploadMethod::Post => NetMethod::Post,
    }
}

/// What the confirmation says about each file, before anything is sent.
///
/// Answers for every path rather than failing on the first: a drop of four
/// files where one has gone is three uploads and one line saying so.
pub async fn describe_files(paths: &[String]) -> Vec<FileToUpload> {
    let mut described = Vec::with_capacity(paths.len());
    for path in paths {
        let file = Path::new(path);
        let name = file
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(path.as_str())
            .to_owned();
        let (bytes, unreadable) = match tokio::fs::metadata(file).await {
            Ok(meta) => (meta.len(), None),
            Err(error) => (0, Some(error.to_string())),
        };
        described.push(FileToUpload {
            path: path.clone(),
            name,
            bytes: u32::try_from(bytes).unwrap_or(u32::MAX),
            too_large: bytes > MAX_BYTES,
            unreadable,
        });
    }
    described
}

/// Reads `path` and sends it, returning the link.
///
/// Every error is a sentence for whoever has to fix it: the file, the provider
/// and the size are all things the user chose and can change.
pub async fn send_file(app: &App, path: &str) -> Result<UploadedFile, String> {
    let Some(provider) = app.store().upload_provider().map_err(describe)? else {
        return Err(
            "No upload provider is configured. Set one from the command palette, or paste a \
             link you already have."
                .into(),
        );
    };

    let file = Path::new(path);
    let name = file
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{path} has no file name ircx can read"))?
        .to_owned();

    let size = tokio::fs::metadata(file)
        .await
        .map_err(|error| format!("{name} could not be read: {error}"))?
        .len();
    if size > MAX_BYTES {
        // Rounded up: 25.5 MB reported as "25 MB" reads as a contradiction of
        // the limit it just hit.
        return Err(format!(
            "{name} is {} MB, and ircx uploads files up to {} MB",
            size.div_ceil(1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }

    let bytes = tokio::fs::read(file)
        .await
        .map_err(|error| format!("{name} could not be read: {error}"))?;

    let mut random = [0u8; PREFIX_BYTES];
    getrandom(&mut random)?;
    let url = endpoint_for(&provider.endpoint, &object_name(&name, &random));

    let host = host_of(&provider.endpoint);
    let policy = policy(&provider, &name, &url, &bytes, app)?;
    let answer = upload(&url, &bytes, &policy)
        .await
        .map_err(|error| refusal(&name, &host, error))?;

    let link = link_from(&answer.body, &url);
    Ok(UploadedFile {
        unreadable: unreadable(&link).await,
        link,
    })
}

/// Why the address will not open for whoever it is sent to, or `None`.
///
/// A `HEAD` rather than a fetch: the file may be 25 MB and the question is only
/// what the server answers. A provider that will not answer a `HEAD` at all
/// says nothing either way, and silence is not a reason to warn about a link
/// that is probably fine.
async fn unreadable(link: &str) -> Option<String> {
    let policy = FetchPolicy {
        allow_local_addresses: true,
        ..FetchPolicy::default()
    };
    match head(link, &policy).await {
        Ok(200..=399) | Err(_) => None,
        Ok(status @ (401 | 403)) => Some(format!(
            "The file was stored, but the address is not public ({status}), so this link will \
             not open for anyone you send it to. Allow public reads on the bucket, or send a \
             link you made elsewhere."
        )),
        Ok(status) => Some(format!(
            "The file was stored, but the address answered HTTP {status}, so this link may not \
             open for anyone you send it to."
        )),
    }
}

/// Why the provider would not take it, for whoever has to fix it.
///
/// `HttpError` is shared with the preview fetch, whose wording tells the reader
/// to open the URL in a browser. That is good advice about a link somebody
/// posted and useless about an upload: a browser sends a `GET`, which cannot
/// say why a `PUT` was refused, and the reader is left without the one thing
/// they can act on. Found by walking it.
fn refusal(name: &str, host: &str, error: HttpError) -> String {
    match error {
        HttpError::Status {
            status: status @ (401 | 403),
            ..
        } => format!(
            "{host} would not accept the credential ({status}). Check the header and token in \
             the upload provider settings."
        ),
        HttpError::Status { status: 413, .. } => {
            format!("{host} refused {name} as too large for it to store.")
        }
        HttpError::Status { status, .. } => {
            format!("{host} refused {name} with HTTP {status}.")
        }
        other => other.to_string(),
    }
}

/// The host, for a sentence that names where the file was going. A malformed
/// endpoint is repeated whole rather than hidden.
fn host_of(endpoint: &str) -> String {
    endpoint
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?']).next())
        .unwrap_or(endpoint)
        .to_owned()
}

fn policy(
    provider: &UploadProvider,
    name: &str,
    url: &str,
    body: &[u8],
    app: &App,
) -> Result<UploadPolicy, String> {
    let content_type = content_type(name).to_owned();

    // S3-compatible storage signs the request rather than carrying a token, so
    // the credential never goes on the wire and a signature is good for one
    // request. The secret is read here, at the moment of the upload.
    if let Some(s3) = provider.s3.as_ref() {
        let secret = app
            .store()
            .upload_token()
            .map_err(describe)?
            .ok_or_else(|| {
                "The provider signs with an S3 secret key and none is saved. Set one from the \
                 upload provider settings."
                    .to_owned()
            })?;
        return s3_policy(s3, &secret, &content_type, url, body);
    }

    let mut headers = Vec::new();
    if let Some(header) = provider.auth_header.as_deref().filter(|h| !h.is_empty()) {
        // Read at the moment of the upload rather than held anywhere it could
        // be shown, which is the whole reason it is write-only.
        let token = app.store().upload_token().map_err(describe)?;
        match token {
            Some(token) => headers.push((header.to_owned(), token)),
            None => {
                return Err(format!(
                    "The provider expects a {header} header and no token is saved. Set one from \
                     the command palette."
                ))
            }
        }
    }
    Ok(UploadPolicy {
        method: net_method(provider.method),
        content_type,
        headers,
        ..UploadPolicy::default()
    })
}

/// The request as S3 wants it: signed, and therefore a `PUT` sent to exactly
/// the host and path the signature covers.
///
/// Split out from `policy` so the walk against a real bucket goes through the
/// same code an upload does rather than a copy of it that could drift.
fn s3_policy(
    s3: &S3Credentials,
    secret: &str,
    content_type: &str,
    url: &str,
    body: &[u8],
) -> Result<UploadPolicy, String> {
    let (host, path) = signing_target(url).map_err(|error| error.to_string())?;
    // Content-Type is sent by the request builder, so it is signed too.
    let sent = [("content-type".to_owned(), content_type.to_owned())];
    let headers = sigv4::signed(
        "PUT",
        &host,
        &path,
        &sigv4::sha256_hex(body),
        &sent,
        &Credentials {
            access_key_id: &s3.access_key_id,
            secret,
            region: &s3.region,
        },
        OffsetDateTime::now_utc(),
    );
    Ok(UploadPolicy {
        // Signed as a PUT, so it has to be sent as one. A POST would be a
        // signature over a request nobody made.
        method: NetMethod::Put,
        content_type: content_type.to_owned(),
        headers,
        ..UploadPolicy::default()
    })
}

fn getrandom(into: &mut [u8]) -> Result<(), String> {
    use ring::rand::SecureRandom;
    ring::rand::SystemRandom::new()
        .fill(into)
        .map_err(|_| "This computer would not give ircx random bytes to name the file with".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The name is interpolated into a URL the client then requests, so a file
    /// called `../../etc/passwd` must not choose where on the provider it
    /// lands.
    #[test]
    fn a_name_cannot_climb_out_of_where_it_was_put() {
        let name = object_name("../../etc/passwd", &[0xab, 0xcd]);
        assert!(!name.contains('/'), "{name}");
        assert!(!name.contains(".."), "{name}");
        assert!(name.starts_with("abcd-"), "{name}");
    }

    #[test]
    fn the_users_own_name_survives_where_it_is_safe() {
        assert_eq!(
            object_name("holiday-photo.png", &[0x01]),
            "01-holiday-photo.png"
        );
    }

    /// Two people uploading `screenshot.png` must not overwrite each other.
    #[test]
    fn the_same_name_twice_is_two_objects() {
        assert_ne!(
            object_name("screenshot.png", &[0x01, 0x02]),
            object_name("screenshot.png", &[0x03, 0x04])
        );
    }

    #[test]
    fn a_name_that_was_entirely_unsafe_still_leaves_something() {
        let name = object_name("///", &[0xff]);
        assert_eq!(name, "ff");
    }

    #[test]
    fn a_long_name_is_cut_rather_than_sent_whole() {
        let name = object_name(&"a".repeat(400), &[0x00]);
        assert!(name.len() <= 3 + 64, "{name}");
    }

    #[test]
    fn an_endpoint_naming_the_object_gets_the_name() {
        assert_eq!(
            endpoint_for("https://files.example.com/{name}", "01-a.png"),
            "https://files.example.com/01-a.png"
        );
    }

    /// A host that names the object itself takes the file at a fixed address.
    #[test]
    fn an_endpoint_without_a_name_is_used_as_it_stands() {
        assert_eq!(endpoint_for("https://0x0.st", "01-a.png"), "https://0x0.st");
    }

    #[test]
    fn a_provider_that_answered_with_a_url_is_believed() {
        assert_eq!(
            link_from(
                "  https://files.example.com/x.png\n",
                "https://put.example.com/y"
            ),
            "https://files.example.com/x.png"
        );
    }

    /// A `204` says the object is where it was put, so the request URL is the
    /// answer — which is the ordinary case for storage addressed by path.
    #[test]
    fn a_provider_that_answered_with_nothing_leaves_the_link_where_it_put_it() {
        assert_eq!(
            link_from("", "https://files.example.com/01-a.png"),
            "https://files.example.com/01-a.png"
        );
    }

    /// A body that is not a URL is a message, not an address — an error page,
    /// or a receipt. Treating it as a link would put nonsense in the channel.
    #[test]
    fn a_reply_that_is_not_a_url_is_not_treated_as_one() {
        assert_eq!(
            link_from("stored ok", "https://files.example.com/01-a.png"),
            "https://files.example.com/01-a.png"
        );
    }

    /// The walk that found this got fetch advice — "open it in your browser to
    /// see what it says" — for an upload a browser cannot even attempt.
    #[test]
    fn a_refused_credential_says_so_and_where_to_fix_it() {
        let said = refusal(
            "a.png",
            "127.0.0.1:8080",
            HttpError::Status {
                url: "http://127.0.0.1:8080/x-a.png".into(),
                status: 401,
            },
        );

        assert!(said.contains("credential"), "{said}");
        assert!(said.contains("upload provider settings"), "{said}");
        assert!(!said.contains("browser"), "{said}");
    }

    #[test]
    fn a_provider_that_thinks_it_too_large_says_that_rather_than_a_number() {
        let said = refusal(
            "a.png",
            "files.example.com",
            HttpError::Status {
                url: "https://files.example.com/x".into(),
                status: 413,
            },
        );

        assert!(said.contains("too large"), "{said}");
    }

    /// Anything else names the host, the file and the status, which is what a
    /// person has to go on when the provider said nothing useful.
    #[test]
    fn any_other_refusal_names_what_it_can() {
        let said = refusal(
            "a.png",
            "files.example.com",
            HttpError::Status {
                url: "https://files.example.com/x".into(),
                status: 500,
            },
        );

        assert!(said.contains("files.example.com"), "{said}");
        assert!(said.contains("a.png"), "{said}");
        assert!(said.contains("500"), "{said}");
    }

    /// A failure that is not a status keeps the wording `ircx-net` wrote for
    /// it: a timeout or a refused connection says the same thing either way.
    #[test]
    fn a_failure_that_is_not_a_status_is_left_alone() {
        let said = refusal(
            "a.png",
            "files.example.com",
            HttpError::Redirected {
                url: "https://files.example.com/x".into(),
                to: "https://elsewhere/x".into(),
            },
        );

        assert!(said.contains("elsewhere"), "{said}");
    }

    #[test]
    fn the_host_is_read_out_of_the_endpoint() {
        assert_eq!(host_of("http://127.0.0.1:8080/{name}"), "127.0.0.1:8080");
        assert_eq!(
            host_of("https://files.example.com/a/b"),
            "files.example.com"
        );
        assert_eq!(host_of("not a url"), "not a url");
    }

    #[test]
    fn the_type_is_claimed_only_for_what_the_client_itself_previews() {
        assert_eq!(content_type("a.PNG"), "image/png");
        assert_eq!(content_type("a.jpeg"), "image/jpeg");
        assert_eq!(content_type("a.tar.gz"), "application/octet-stream");
        assert_eq!(content_type("noextension"), "application/octet-stream");
    }
}

/// Against a real S3-compatible server, because the arithmetic being right and
/// the request being accepted are different questions.
///
/// Ignored by default so `cargo test --workspace` dials nothing. Set up with:
///
/// ```text
/// podman run -d --rm --name ircx-minio -p 9000:9000 \
///   -e MINIO_ROOT_USER=ircxtest -e MINIO_ROOT_PASSWORD=ircxtestsecret \
///   docker.io/minio/minio:latest server /data
/// cargo test -p ircx --lib minio -- --ignored --nocapture
/// ```
#[cfg(test)]
mod minio {
    use super::*;
    use ircx_net::http::upload;

    const ORIGIN: &str = "http://127.0.0.1:9000";
    const BUCKET: &str = "ircx-walk";
    /// A second bucket, because the first one documents the default and a
    /// bucket cannot be private and public at once.
    const PUBLIC_BUCKET: &str = "ircx-walk-public";
    const SECRET: &str = "ircxtestsecret";

    fn credentials() -> S3Credentials {
        S3Credentials {
            // MinIO accepts any region and signs with the one it is told, which
            // is the case worth covering: a provider that does not care still
            // has to agree with the signature.
            region: "us-east-1".into(),
            access_key_id: "ircxtest".into(),
        }
    }

    async fn put(url: &str, body: &[u8], content_type: &str) -> Result<u16, String> {
        let policy = s3_policy(&credentials(), SECRET, content_type, url, body)?;
        upload(url, body, &policy)
            .await
            .map(|answer| answer.status)
            .map_err(|error| error.to_string())
    }

    #[tokio::test]
    #[ignore = "needs a local MinIO on :9000"]
    async fn a_signed_upload_reaches_a_real_bucket() {
        // Creating the bucket is itself a signed PUT, so a failure here is the
        // signature rather than anything about objects.
        let made = put(
            &format!("{ORIGIN}/{BUCKET}"),
            b"",
            "application/octet-stream",
        )
        .await;
        match made {
            Ok(status) => println!("PASS  bucket: HTTP {status}"),
            // Already there from a previous run, which is not a failure.
            Err(error) if error.contains("409") => println!("PASS  bucket: already exists"),
            Err(error) => panic!("the bucket could not be made: {error}"),
        }

        let name = object_name(
            "walk.png",
            &[0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6, 0x07, 0x18],
        );
        let url = endpoint_for(&format!("{ORIGIN}/{BUCKET}/{{name}}"), &name);
        let body = b"the bytes ircx put there";

        let status = put(&url, body, content_type("walk.png"))
            .await
            .expect("the object is stored");
        println!("PASS  object: HTTP {status} at {url}");

        // The link this client is about to put in a conversation, fetched the
        // way anybody reading that conversation would fetch it.
        //
        // It is refused, and that is the finding: a bucket is private until
        // somebody makes it otherwise, so a signed upload can succeed and hand
        // back an address that opens for nobody. The bytes did arrive — the
        // walk read them out of MinIO's own storage — so this is the object
        // being private rather than the object being wrong.
        let read = ircx_net::http::fetch(
            &url,
            &ircx_net::http::FetchPolicy {
                allow_local_addresses: true,
                ..Default::default()
            },
        )
        .await;
        let refusal = read.expect_err("a private bucket refuses an anonymous read");
        println!("NOTE  the link is private: {refusal}");
        assert!(refusal.to_string().contains("403"), "{refusal}");
    }

    /// The other half: a bucket somebody has made readable, which is the
    /// configuration this feature is for and the path where the link goes out.
    ///
    /// Setting the policy is a signed `PUT` carrying a query string, which no
    /// other request here does — so it is also the only cover the canonical
    /// query string has.
    #[tokio::test]
    #[ignore = "needs a local MinIO on :9000"]
    async fn a_public_bucket_hands_back_a_link_that_opens() {
        let bucket = format!("{ORIGIN}/{PUBLIC_BUCKET}");
        match put(&bucket, b"", "application/octet-stream").await {
            Ok(status) => println!("PASS  bucket: HTTP {status}"),
            Err(error) if error.contains("409") => println!("PASS  bucket: already exists"),
            Err(error) => panic!("the bucket could not be made: {error}"),
        }

        let policy = format!(
            r#"{{"Version":"2012-10-17","Statement":[{{"Effect":"Allow","Principal":{{"AWS":["*"]}},"Action":["s3:GetObject"],"Resource":["arn:aws:s3:::{PUBLIC_BUCKET}/*"]}}]}}"#
        );
        let status = put(
            &format!("{bucket}?policy="),
            policy.as_bytes(),
            "application/json",
        )
        .await
        .expect("the policy is accepted, which is a signature over a query string");
        println!("PASS  policy: HTTP {status}");

        let name = object_name("public.png", &[1, 2, 3, 4, 5, 6, 7, 8]);
        let url = endpoint_for(&format!("{bucket}/{{name}}"), &name);
        let body = b"anybody can read this one";
        put(&url, body, content_type("public.png"))
            .await
            .expect("the object is stored");

        // The whole point, and the path that had never been taken: the client
        // asks whether the address it is about to hand over will open.
        let refusal = unreadable(&url).await;
        assert_eq!(refusal, None, "a readable link is not warned about");
        println!("PASS  the client would send this link");

        let read = ircx_net::http::fetch(
            &url,
            &FetchPolicy {
                allow_local_addresses: true,
                ..FetchPolicy::default()
            },
        )
        .await
        .expect("anybody can read it");
        assert_eq!(read.body, body, "what came back is what went in");
        println!("PASS  read back {} bytes anonymously", read.body.len());
    }

    /// A wrong secret has to be told apart from a wrong everything else, since
    /// both come back as a refusal with nothing in it.
    #[tokio::test]
    #[ignore = "needs a local MinIO on :9000"]
    async fn a_wrong_secret_is_refused() {
        let url = format!("{ORIGIN}/{BUCKET}/never-stored");
        let policy = s3_policy(&credentials(), "not the secret", "text/plain", &url, b"x")
            .expect("a policy");

        let answer = upload(&url, b"x", &policy).await;

        let error = answer
            .expect_err("a wrong signature is refused")
            .to_string();
        println!("refusal: {error}");
        assert!(error.contains("403"), "{error}");
    }
}
