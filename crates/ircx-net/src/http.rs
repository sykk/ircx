//! One capped GET over HTTP/1.1, for a fetch the user explicitly asked for.
//!
//! Not a general client: no cookies, no authentication, no compression, no
//! connection reuse, no proxy, no HTTP/2. It lives here so `ircx-net` stays
//! the only crate that opens an outbound socket, and so the same trust roots
//! and rustls configuration serve both this and the IRC transport.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use http::Uri;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;

use crate::tls;

/// The status line and headers are read before anything about the reply has
/// been agreed to, so this is the one buffer a server grows unilaterally.
const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_HEADERS: usize = 64;
const READ_CHUNK: usize = 16 * 1024;

#[derive(Debug, Clone)]
pub struct FetchPolicy {
    /// Refused from the declared `Content-Length` before the body is read, and
    /// enforced again while reading it for servers that declare nothing.
    pub max_bytes: usize,
    /// Covers name resolution, connect, handshake, every redirect and the body
    /// together. A user is watching a click, not a download.
    pub timeout: Duration,
    /// Only same-host redirects are followed, so this bounds a server looping
    /// back to itself rather than a chain across hosts.
    pub max_redirects: u8,
    /// Loopback, private, link-local and carrier-NAT addresses are refused:
    /// the URL came from whoever spoke in the channel, and the machines behind
    /// the user's router are not theirs to reach. Tests serving 127.0.0.1 set
    /// this true.
    pub allow_local_addresses: bool,
    /// Sent as `Accept`. Servers that content-negotiate get told what the
    /// caller can actually use.
    pub accept: String,
}

impl Default for FetchPolicy {
    fn default() -> Self {
        Self {
            max_bytes: 4 * 1024 * 1024,
            timeout: Duration::from_secs(10),
            max_redirects: 3,
            allow_local_addresses: false,
            accept: "*/*".to_owned(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Fetched {
    /// Where the bytes came from, which is not the requested URL if the server
    /// redirected.
    pub url: String,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    #[error("{url} is not an address ircx can fetch — it needs to start with http:// or https://")]
    UnsupportedUrl { url: String },

    #[error("{url} carries a username, which ircx will not send")]
    CredentialsInUrl { url: String },

    #[error(
        "{host} is on your own machine or local network, and ircx will not fetch there on a \
         link's say-so — open it in your browser if you meant to"
    )]
    LocalAddress { host: String },

    #[error("could not reach {host}: {source}")]
    Connect {
        host: String,
        #[source]
        source: std::io::Error,
    },

    #[error("TLS handshake with {host} failed: {source}")]
    Tls {
        host: String,
        #[source]
        source: std::io::Error,
    },

    #[error("{host} did not answer within {} seconds", .timeout.as_secs())]
    Timeout { host: String, timeout: Duration },

    #[error("{host} sent a reply ircx could not read as HTTP")]
    Malformed { host: String },

    #[error("{url} returned HTTP {status} — open it in your browser to see what it says")]
    Status { url: String, status: u16 },

    #[error(
        "{url} redirects to {target}, and ircx does not hand a second host the request without \
         being asked — open it in your browser if you trust it"
    )]
    CrossHostRedirect { url: String, target: String },

    #[error("{url} redirects to plain http, which would send the request in the clear")]
    InsecureRedirect { url: String },

    #[error("{url} redirects more than {max} times")]
    TooManyRedirects { url: String, max: u8 },

    #[error("{url} is larger than the {} MiB ircx will hold in memory for a preview", .max / (1024 * 1024))]
    TooLarge { url: String, max: usize },
}

/// Fetches `url` whole, or fails. Nothing calls this except on a user action.
pub async fn fetch(url: &str, policy: &FetchPolicy) -> Result<Fetched, HttpError> {
    let target = Target::parse(url)?;
    let host = target.host.clone();
    timeout(policy.timeout, follow(target, policy))
        .await
        .map_err(|_| HttpError::Timeout {
            host,
            timeout: policy.timeout,
        })?
}

async fn follow(mut target: Target, policy: &FetchPolicy) -> Result<Fetched, HttpError> {
    let first = target.url();
    for _ in 0..=policy.max_redirects {
        match request(&target, policy).await? {
            Reply::Body { content_type, body } => {
                return Ok(Fetched {
                    url: target.url(),
                    content_type,
                    body,
                })
            }
            Reply::Redirect(location) => target = redirect_target(&target, &location)?,
        }
    }
    Err(HttpError::TooManyRedirects {
        url: first,
        max: policy.max_redirects,
    })
}

enum Reply {
    Body {
        content_type: Option<String>,
        body: Vec<u8>,
    },
    Redirect(String),
}

async fn request(target: &Target, policy: &FetchPolicy) -> Result<Reply, HttpError> {
    let mut stream = connect(target, policy).await?;
    let io = |source| HttpError::Connect {
        host: target.host.clone(),
        source,
    };
    stream
        .write_all(&target.request_bytes(&policy.accept))
        .await
        .map_err(io)?;
    stream.flush().await.map_err(io)?;

    let mut buffer = Vec::with_capacity(READ_CHUNK);
    let head = loop {
        if let Some(head) = parse_head(&buffer, &target.host)? {
            break head;
        }
        if buffer.len() > MAX_HEAD_BYTES || !fill(&mut stream, &mut buffer).await.map_err(io)? {
            return Err(HttpError::Malformed {
                host: target.host.clone(),
            });
        }
    };

    if (300..400).contains(&head.status) {
        return match head.location {
            Some(location) => Ok(Reply::Redirect(location)),
            None => Err(HttpError::Status {
                url: target.url(),
                status: head.status,
            }),
        };
    }
    if head.status != 200 {
        return Err(HttpError::Status {
            url: target.url(),
            status: head.status,
        });
    }
    let too_large = || HttpError::TooLarge {
        url: target.url(),
        max: policy.max_bytes,
    };
    if head
        .content_length
        .is_some_and(|len| len > policy.max_bytes as u64)
    {
        return Err(too_large());
    }

    buffer.drain(..head.consumed);
    let body = if head.chunked {
        read_chunked(&mut stream, buffer, target, policy.max_bytes).await?
    } else {
        // One byte past the cap when the server declared no length, so an
        // overlong body is refused rather than quietly truncated.
        let limit = head
            .content_length
            .map_or(policy.max_bytes + 1, |len| len as usize);
        while buffer.len() < limit {
            if !fill(&mut stream, &mut buffer).await.map_err(io)? {
                break;
            }
        }
        if buffer.len() > policy.max_bytes {
            return Err(too_large());
        }
        buffer.truncate(limit);
        buffer
    };

    Ok(Reply::Body {
        content_type: head.content_type,
        body,
    })
}

/// A chunked body, with the running total and the unconsumed buffer both held
/// under the cap so a server cannot spend our memory on framing either.
async fn read_chunked(
    stream: &mut Box<dyn Socket>,
    mut buffer: Vec<u8>,
    target: &Target,
    max: usize,
) -> Result<Vec<u8>, HttpError> {
    let io = |source| HttpError::Connect {
        host: target.host.clone(),
        source,
    };
    let malformed = || HttpError::Malformed {
        host: target.host.clone(),
    };
    let mut body: Vec<u8> = Vec::new();

    loop {
        let line_end = loop {
            if let Some(at) = find_crlf(&buffer) {
                break at;
            }
            if buffer.len() > max + MAX_HEAD_BYTES
                || !fill(stream, &mut buffer).await.map_err(io)?
            {
                return Err(malformed());
            }
        };

        // The size may be followed by chunk extensions, which we do not use.
        let size_field = buffer[..line_end]
            .split(|byte| *byte == b';')
            .next()
            .unwrap_or_default();
        let size = std::str::from_utf8(size_field)
            .ok()
            .and_then(|text| usize::from_str_radix(text.trim(), 16).ok())
            .ok_or_else(malformed)?;
        buffer.drain(..line_end + 2);

        if size == 0 {
            return Ok(body);
        }
        // Subtraction rather than `body.len() + size`, which a chunk declaring
        // usize::MAX would wrap past the cap in release.
        if size > max.saturating_sub(body.len()) {
            return Err(HttpError::TooLarge {
                url: target.url(),
                max,
            });
        }
        while buffer.len() < size + 2 {
            if !fill(stream, &mut buffer).await.map_err(io)? {
                return Err(malformed());
            }
        }
        body.extend_from_slice(&buffer[..size]);
        buffer.drain(..size + 2);
    }
}

fn find_crlf(buffer: &[u8]) -> Option<usize> {
    buffer.windows(2).position(|pair| pair == b"\r\n")
}

async fn fill(stream: &mut Box<dyn Socket>, buffer: &mut Vec<u8>) -> std::io::Result<bool> {
    let mut chunk = [0u8; READ_CHUNK];
    let read = stream.read(&mut chunk).await?;
    buffer.extend_from_slice(&chunk[..read]);
    Ok(read > 0)
}

#[derive(Default)]
struct Head {
    status: u16,
    consumed: usize,
    content_length: Option<u64>,
    content_type: Option<String>,
    location: Option<String>,
    chunked: bool,
}

fn parse_head(buffer: &[u8], host: &str) -> Result<Option<Head>, HttpError> {
    let malformed = || HttpError::Malformed {
        host: host.to_owned(),
    };
    let mut headers = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut response = httparse::Response::new(&mut headers);
    let consumed = match response.parse(buffer) {
        Ok(httparse::Status::Complete(consumed)) => consumed,
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(_) => return Err(malformed()),
    };

    let mut head = Head {
        status: response.code.ok_or_else(malformed)?,
        consumed,
        ..Head::default()
    };
    for header in response.headers.iter() {
        let text = || std::str::from_utf8(header.value).ok().map(str::trim);
        if header.name.eq_ignore_ascii_case("content-length") {
            head.content_length = text().and_then(|value| value.parse().ok());
        } else if header.name.eq_ignore_ascii_case("content-type") {
            head.content_type = text().map(str::to_owned);
        } else if header.name.eq_ignore_ascii_case("location") {
            head.location = text().map(str::to_owned);
        } else if header.name.eq_ignore_ascii_case("transfer-encoding") {
            head.chunked = text().is_some_and(|value| {
                value
                    .split(',')
                    .any(|coding| coding.trim().eq_ignore_ascii_case("chunked"))
            });
        }
    }
    // Chunked framing carries its own end, so a length sent alongside it lies.
    if head.chunked {
        head.content_length = None;
    }
    Ok(Some(head))
}

#[derive(Debug)]
struct Target {
    https: bool,
    host: String,
    port: u16,
    /// Path and query together, always starting with `/`.
    path: String,
}

impl Target {
    fn parse(url: &str) -> Result<Self, HttpError> {
        let unsupported = || HttpError::UnsupportedUrl {
            url: url.to_owned(),
        };
        let uri: Uri = url.parse().map_err(|_| unsupported())?;
        let https = match uri.scheme_str() {
            Some("https") => true,
            Some("http") => false,
            _ => return Err(unsupported()),
        };
        let authority = uri.authority().ok_or_else(unsupported)?;
        if authority.as_str().contains('@') {
            return Err(HttpError::CredentialsInUrl {
                url: url.to_owned(),
            });
        }
        let host = authority.host();
        if host.is_empty() {
            return Err(unsupported());
        }
        let path = match uri.path_and_query().map(|path| path.as_str()) {
            Some("") | None => "/",
            Some(path) => path,
        };

        Ok(Self {
            https,
            host: host.to_owned(),
            port: uri.port_u16().unwrap_or(if https { 443 } else { 80 }),
            path: path.to_owned(),
        })
    }

    fn scheme(&self) -> &'static str {
        if self.https {
            "https"
        } else {
            "http"
        }
    }

    fn default_port(&self) -> bool {
        self.port == if self.https { 443 } else { 80 }
    }

    fn origin(&self) -> String {
        if self.default_port() {
            format!("{}://{}", self.scheme(), self.host)
        } else {
            format!("{}://{}:{}", self.scheme(), self.host, self.port)
        }
    }

    fn url(&self) -> String {
        format!("{}{}", self.origin(), self.path)
    }

    /// Absent by design: `Cookie`, `Referer`, `Authorization`, and any
    /// `Accept-Encoding` beyond identity. The User-Agent is honest rather than
    /// disguised — a blank one is refused by enough hosts to be useless, and
    /// the server already learns the IP and the URL.
    fn request_bytes(&self, accept: &str) -> Vec<u8> {
        let host = if self.default_port() {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        };
        format!(
            "GET {} HTTP/1.1\r\n\
             Host: {host}\r\n\
             User-Agent: ircx/{}\r\n\
             Accept: {accept}\r\n\
             Accept-Encoding: identity\r\n\
             Connection: close\r\n\r\n",
            self.path,
            env!("CARGO_PKG_VERSION"),
        )
        .into_bytes()
    }
}

/// Same-host redirects are followed because no new party learns anything from
/// them. A redirect to another host is refused and named, so the second host
/// gets the user's IP only if the user goes there deliberately.
fn redirect_target(from: &Target, location: &str) -> Result<Target, HttpError> {
    let location = location.trim();
    let candidate = if let Some(rest) = location.strip_prefix("//") {
        format!("{}://{rest}", from.scheme())
    } else if location.starts_with('/') {
        format!("{}{location}", from.origin())
    } else if location.contains("://") {
        location.to_owned()
    } else {
        let path = from.path.split('?').next().unwrap_or("/");
        let base = &path[..path.rfind('/').map_or(0, |at| at + 1)];
        format!("{}{base}{location}", from.origin())
    };

    let to = Target::parse(&candidate)?;
    if !to.host.eq_ignore_ascii_case(&from.host) {
        return Err(HttpError::CrossHostRedirect {
            url: from.url(),
            target: to.host,
        });
    }
    if from.https && !to.https {
        return Err(HttpError::InsecureRedirect { url: from.url() });
    }
    Ok(to)
}

trait Socket: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Socket for T {}

async fn connect(target: &Target, policy: &FetchPolicy) -> Result<Box<dyn Socket>, HttpError> {
    let addresses = tokio::net::lookup_host((target.host.as_str(), target.port))
        .await
        .map_err(|source| HttpError::Connect {
            host: target.host.clone(),
            source,
        })?;

    let mut permitted = 0usize;
    let mut last: Option<std::io::Error> = None;
    let mut tcp = None;
    for address in addresses {
        if !policy.allow_local_addresses && is_local(address.ip()) {
            continue;
        }
        permitted += 1;
        match TcpStream::connect(address).await {
            Ok(stream) => {
                tcp = Some(stream);
                break;
            }
            Err(error) => last = Some(error),
        }
    }
    let tcp = match tcp {
        Some(tcp) => tcp,
        None if permitted == 0 => {
            return Err(HttpError::LocalAddress {
                host: target.host.clone(),
            })
        }
        None => {
            return Err(HttpError::Connect {
                host: target.host.clone(),
                source: last.unwrap_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::NotFound, "no address to try")
                }),
            })
        }
    };
    let _ = tcp.set_nodelay(true);

    if !target.https {
        return Ok(Box::new(tcp));
    }

    let name = rustls_pki_types::ServerName::try_from(target.host.clone())
        .map_err(|_| HttpError::UnsupportedUrl { url: target.url() })?;
    let mut config = tls::client_config(true);
    // Offer only HTTP/1.1: this client cannot speak h2, and a server told
    // nothing about ALPN is free to assume otherwise.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let stream = TlsConnector::from(Arc::new(config))
        .connect(name, tcp)
        .await
        .map_err(|source| HttpError::Tls {
            host: target.host.clone(),
            source,
        })?;
    Ok(Box::new(stream))
}

/// Everything a link should not be able to reach through the user: their own
/// machine, their LAN, and the metadata addresses cloud hosts expose.
fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [first, second, ..] = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                // 100.64.0.0/10, carrier-grade NAT
                || (first == 100 && (second & 0xc0) == 0x40)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // fc00::/7 unique local, fe80::/10 link local
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(|v4| is_local(IpAddr::V4(v4)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(url: &str) -> Target {
        Target::parse(url).expect("a URL the tests wrote")
    }

    #[test]
    fn parses_the_pieces_of_a_url() {
        let parsed = target("https://files.example/a/b.png?v=2");
        assert!(parsed.https);
        assert_eq!(parsed.host, "files.example");
        assert_eq!(parsed.port, 443);
        assert_eq!(parsed.path, "/a/b.png?v=2");
        assert_eq!(parsed.url(), "https://files.example/a/b.png?v=2");
    }

    #[test]
    fn fills_in_an_empty_path_and_a_non_default_port() {
        let parsed = target("http://files.example:8080");
        assert_eq!(parsed.path, "/");
        assert_eq!(parsed.url(), "http://files.example:8080/");
    }

    #[test]
    fn refuses_schemes_that_are_not_http() {
        for url in ["ftp://files.example/a", "file:///etc/passwd", "/a/b.png"] {
            assert!(
                matches!(Target::parse(url), Err(HttpError::UnsupportedUrl { .. })),
                "{url}"
            );
        }
    }

    #[test]
    fn refuses_a_url_carrying_credentials() {
        let error = Target::parse("https://user:pw@files.example/a").expect_err("must refuse");
        assert!(
            matches!(error, HttpError::CredentialsInUrl { .. }),
            "{error}"
        );
    }

    #[test]
    fn writes_a_request_without_cookies_or_a_referer() {
        let bytes = target("https://files.example/a/b.png?v=2").request_bytes("image/png");
        let request = String::from_utf8(bytes).expect("ascii");
        assert!(
            request.starts_with("GET /a/b.png?v=2 HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(request.contains("Host: files.example\r\n"), "{request}");
        assert!(request.contains("Accept: image/png\r\n"), "{request}");
        assert!(request.contains("Connection: close\r\n"), "{request}");
        for absent in ["Cookie", "Referer", "Authorization", "gzip"] {
            assert!(!request.contains(absent), "{absent} in {request}");
        }
    }

    #[test]
    fn keeps_the_port_in_the_host_header_when_it_is_not_the_default() {
        let bytes = target("http://files.example:8080/a").request_bytes("*/*");
        let request = String::from_utf8(bytes).expect("ascii");
        assert!(
            request.contains("Host: files.example:8080\r\n"),
            "{request}"
        );
    }

    #[test]
    fn resolves_the_shapes_a_location_header_takes() {
        let from = target("https://files.example/a/b.png");
        for (location, expected) in [
            ("/c/d.png", "https://files.example/c/d.png"),
            ("d.png", "https://files.example/a/d.png"),
            ("//files.example/e.png", "https://files.example/e.png"),
            (
                "https://files.example:8443/f.png",
                "https://files.example:8443/f.png",
            ),
        ] {
            let to = redirect_target(&from, location).expect(location);
            assert_eq!(to.url(), expected, "{location}");
        }
    }

    #[test]
    fn resolves_a_relative_location_against_the_path_not_the_query() {
        let from = target("https://files.example/a/b.png?next=/z/");
        let to = redirect_target(&from, "c.png").expect("relative");
        assert_eq!(to.url(), "https://files.example/a/c.png");
    }

    #[test]
    fn refuses_a_redirect_to_another_host() {
        let from = target("https://files.example/a.png");
        let error =
            redirect_target(&from, "https://tracker.example/a.png").expect_err("must refuse");
        match error {
            HttpError::CrossHostRedirect { target, .. } => assert_eq!(target, "tracker.example"),
            other => panic!("expected a cross-host refusal, got {other}"),
        }
    }

    #[test]
    fn refuses_a_redirect_that_drops_to_plain_http() {
        let from = target("https://files.example/a.png");
        let error = redirect_target(&from, "http://files.example/a.png").expect_err("must refuse");
        assert!(
            matches!(error, HttpError::InsecureRedirect { .. }),
            "{error}"
        );
    }

    #[test]
    fn allows_a_same_host_upgrade_to_https() {
        let from = target("http://files.example/a.png");
        let to = redirect_target(&from, "https://files.example/a.png").expect("upgrade");
        assert!(to.https);
    }

    #[test]
    fn names_the_addresses_a_link_may_not_reach() {
        for address in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fd00::1",
            "::ffff:127.0.0.1",
        ] {
            let ip: IpAddr = address.parse().expect(address);
            assert!(is_local(ip), "{address} should be refused");
        }

        for address in ["1.1.1.1", "93.184.216.34", "2606:4700::1111"] {
            let ip: IpAddr = address.parse().expect(address);
            assert!(!is_local(ip), "{address} should be allowed");
        }
    }

    #[test]
    fn reads_a_head_and_the_headers_that_matter() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 12\r\n\r\nbody";
        let head = parse_head(raw, "files.example")
            .expect("parse")
            .expect("complete");
        assert_eq!(head.status, 200);
        assert_eq!(head.content_type.as_deref(), Some("image/png"));
        assert_eq!(head.content_length, Some(12));
        assert!(!head.chunked);
        assert_eq!(&raw[head.consumed..], b"body");
    }

    #[test]
    fn waits_for_the_rest_of_a_split_head() {
        assert!(
            parse_head(b"HTTP/1.1 200 OK\r\nContent-Ty", "files.example")
                .expect("parse")
                .is_none()
        );
    }

    #[test]
    fn ignores_a_content_length_sent_alongside_chunked_framing() {
        let raw =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\nContent-Length: 9\r\n\r\n";
        let head = parse_head(raw, "files.example")
            .expect("parse")
            .expect("complete");
        assert!(head.chunked);
        assert_eq!(head.content_length, None);
    }
}
