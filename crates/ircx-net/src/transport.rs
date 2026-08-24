use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tracing::{debug, warn};

use crate::error::{DisconnectReason, NetError};
use crate::framing::{Framed, Framer};
use crate::rate_limit::{RateLimit, TokenBucket};
use crate::tls::{self, TlsInfo};

const EVENT_QUEUE: usize = 512;
const OUTBOUND_QUEUE: usize = 256;
const READ_CHUNK: usize = 8 * 1024;

pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    /// `false` accepts any certificate the server offers. It is a per-network
    /// opt-in for self-signed servers, never a fallback: `Default` sets it
    /// `true` and a failed handshake stays failed.
    pub tls_verify: bool,
    pub socks5_proxy: Option<String>,
    /// A PEM file holding the certificate to present and the key that signs for
    /// it. What SASL EXTERNAL authenticates with, and read at connect time
    /// rather than held in memory, so replacing an expired one takes a
    /// reconnect rather than a restart.
    pub client_certificate: Option<PathBuf>,
    /// Covers name resolution, the TCP connect, and the TLS handshake together.
    pub connect_timeout: Duration,
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self {
            host: String::new(),
            port: 6697,
            tls: true,
            tls_verify: true,
            socks5_proxy: None,
            client_certificate: None,
            connect_timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, Clone)]
pub enum TransportEvent {
    Connected { tls_info: Option<TlsInfo> },
    Line(String),
    Disconnected { reason: DisconnectReason },
}

/// A queued line and the ticket the caller knows it by. The ticket means
/// nothing here beyond being the number reported once the line is written.
struct Outbound {
    line: String,
    ticket: u64,
}

#[derive(Clone)]
pub struct LineSender {
    outbound: mpsc::Sender<Outbound>,
}

impl LineSender {
    /// Queues a line for sending. The terminator is added here; the rate
    /// limiter may hold the line back, so returning does not mean it is on the
    /// wire. `Transport::written` reaching `ticket` is what means that.
    pub async fn send(&self, line: impl Into<String>, ticket: u64) -> Result<(), NetError> {
        let line = line.into();
        if line.contains(['\r', '\n']) {
            return Err(NetError::EmbeddedNewline);
        }
        self.outbound
            .send(Outbound { line, ticket })
            .await
            .map_err(|_| NetError::Closed)
    }
}

pub struct Transport {
    outbound: mpsc::Sender<Outbound>,
    written: watch::Receiver<u64>,
    stop: Arc<watch::Sender<Option<DisconnectReason>>>,
    tasks: Vec<JoinHandle<()>>,
}

impl Transport {
    pub async fn connect(
        config: ConnectionConfig,
    ) -> Result<(Self, mpsc::Receiver<TransportEvent>), NetError> {
        Self::connect_with(config, RateLimit::default()).await
    }

    pub async fn connect_with(
        config: ConnectionConfig,
        rate_limit: RateLimit,
    ) -> Result<(Self, mpsc::Receiver<TransportEvent>), NetError> {
        let deadline = config.connect_timeout;
        let host = config.host.clone();
        let port = config.port;

        let (stream, tls_info) = timeout(deadline, establish(config)).await.map_err(|_| {
            NetError::ConnectTimeout {
                host,
                port,
                timeout: deadline,
            }
        })??;

        let (event_tx, event_rx) = mpsc::channel(EVENT_QUEUE);
        let (outbound_tx, outbound_rx) = mpsc::channel(OUTBOUND_QUEUE);
        let (stop_tx, stop_rx) = watch::channel(None);
        let stop_tx = Arc::new(stop_tx);
        // Tickets start at 1, so nothing written is a mark of 0.
        let (written_tx, written_rx) = watch::channel(0);

        let _ = event_tx.send(TransportEvent::Connected { tls_info }).await;

        let (reader, writer) = tokio::io::split(stream);
        let tasks = vec![
            tokio::spawn(read_task(
                reader,
                event_tx,
                stop_rx.clone(),
                stop_tx.clone(),
            )),
            tokio::spawn(write_task(
                writer,
                outbound_rx,
                written_tx,
                stop_rx,
                stop_tx.clone(),
                rate_limit,
            )),
        ];

        Ok((
            Self {
                outbound: outbound_tx,
                written: written_rx,
                stop: stop_tx,
                tasks,
            },
            event_rx,
        ))
    }

    pub fn sender(&self) -> LineSender {
        LineSender {
            outbound: self.outbound.clone(),
        }
    }

    /// The highest ticket written to the socket. It only ever rises, so a
    /// reader that misses a change has missed nothing: every ticket at or below
    /// what it reads has been written.
    pub fn written(&self) -> watch::Receiver<u64> {
        self.written.clone()
    }

    /// Closes the socket. Sends nothing first: QUIT is the caller's to send,
    /// and to wait for, before calling this.
    pub async fn shutdown(&mut self) {
        let _ = self.stop.send(Some(DisconnectReason::Shutdown));
        for task in self.tasks.drain(..) {
            let _ = task.await;
        }
    }
}

impl Drop for Transport {
    fn drop(&mut self) {
        let _ = self.stop.send(Some(DisconnectReason::Shutdown));
    }
}

trait Socket: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Socket for T {}

async fn establish(
    config: ConnectionConfig,
) -> Result<(Box<dyn Socket>, Option<TlsInfo>), NetError> {
    let tcp = match config.socks5_proxy.as_deref() {
        Some(proxy) => connect_socks5(proxy, &config.host, config.port).await?,
        None => TcpStream::connect((config.host.as_str(), config.port))
            .await
            .map_err(|source| NetError::Connect {
                host: config.host.clone(),
                port: config.port,
                source,
            })?,
    };
    let _ = tcp.set_nodelay(true);

    if !config.tls {
        return Ok((Box::new(tcp), None));
    }

    let name = rustls_pki_types::ServerName::try_from(config.host.clone()).map_err(|_| {
        NetError::InvalidHostname {
            host: config.host.clone(),
        }
    })?;
    let client_config = match config.client_certificate.as_deref() {
        Some(path) => tls::client_config_with_certificate(config.tls_verify, path)?,
        None => tls::client_config(config.tls_verify),
    };
    let connector = TlsConnector::from(Arc::new(client_config));
    let stream = connector
        .connect(name, tcp)
        .await
        .map_err(|source| NetError::Tls {
            host: config.host.clone(),
            source,
        })?;

    let info = tls::tls_info(stream.get_ref().1);
    Ok((Box::new(stream), Some(info)))
}

async fn connect_socks5(proxy: &str, host: &str, port: u16) -> Result<TcpStream, NetError> {
    let (proxy_host, proxy_port) = proxy_endpoint(proxy).ok_or_else(|| NetError::Socks5 {
        proxy: proxy.to_owned(),
        host: host.to_owned(),
        port,
        reason: "the proxy address must be host:port".to_owned(),
    })?;
    let mut stream = TcpStream::connect((proxy_host.as_str(), proxy_port))
        .await
        .map_err(|source| NetError::Socks5 {
            proxy: proxy.to_owned(),
            host: host.to_owned(),
            port,
            reason: source.to_string(),
        })?;

    stream
        .write_all(&[5, 1, 0])
        .await
        .map_err(|source| socks5_io(proxy, host, port, source))?;
    let mut greeting = [0u8; 2];
    stream
        .read_exact(&mut greeting)
        .await
        .map_err(|source| socks5_io(proxy, host, port, source))?;
    if greeting != [5, 0] {
        return Err(NetError::Socks5 {
            proxy: proxy.to_owned(),
            host: host.to_owned(),
            port,
            reason: "the proxy does not allow connections without authentication".to_owned(),
        });
    }

    let name = host.as_bytes();
    let name_len = u8::try_from(name.len()).map_err(|_| NetError::Socks5 {
        proxy: proxy.to_owned(),
        host: host.to_owned(),
        port,
        reason: "the IRC server name is longer than SOCKS5 can carry".to_owned(),
    })?;
    let mut request = Vec::with_capacity(name.len() + 7);
    request.extend_from_slice(&[5, 1, 0, 3, name_len]);
    request.extend_from_slice(name);
    request.extend_from_slice(&port.to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|source| socks5_io(proxy, host, port, source))?;

    let mut response = [0u8; 4];
    stream
        .read_exact(&mut response)
        .await
        .map_err(|source| socks5_io(proxy, host, port, source))?;
    if response[0] != 5 || response[2] != 0 {
        return Err(NetError::Socks5 {
            proxy: proxy.to_owned(),
            host: host.to_owned(),
            port,
            reason: "the proxy returned an invalid SOCKS5 response".to_owned(),
        });
    }
    if response[1] != 0 {
        return Err(NetError::Socks5 {
            proxy: proxy.to_owned(),
            host: host.to_owned(),
            port,
            reason: socks5_refusal(response[1]).to_owned(),
        });
    }

    let address_len = match response[3] {
        1 => 4,
        3 => {
            let mut length = [0u8; 1];
            stream
                .read_exact(&mut length)
                .await
                .map_err(|source| socks5_io(proxy, host, port, source))?;
            usize::from(length[0])
        }
        4 => 16,
        _ => {
            return Err(NetError::Socks5 {
                proxy: proxy.to_owned(),
                host: host.to_owned(),
                port,
                reason: "the proxy returned an unknown address type".to_owned(),
            });
        }
    };
    let mut bound = vec![0u8; address_len + 2];
    stream
        .read_exact(&mut bound)
        .await
        .map_err(|source| socks5_io(proxy, host, port, source))?;
    Ok(stream)
}

fn proxy_endpoint(endpoint: &str) -> Option<(String, u16)> {
    let (host, port) = if let Some(bracketed) = endpoint.strip_prefix('[') {
        let (host, port) = bracketed.split_once("]:")?;
        (host, port)
    } else {
        endpoint.rsplit_once(':')?
    };
    let port = port.parse().ok().filter(|port: &u16| *port != 0)?;
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        return None;
    }
    Some((host.to_owned(), port))
}

fn socks5_io(proxy: &str, host: &str, port: u16, source: std::io::Error) -> NetError {
    NetError::Socks5 {
        proxy: proxy.to_owned(),
        host: host.to_owned(),
        port,
        reason: source.to_string(),
    }
}

fn socks5_refusal(code: u8) -> &'static str {
    match code {
        1 => "the proxy reported a general failure",
        2 => "the proxy's rules refused the connection",
        3 => "the proxy could not reach the network",
        4 => "the proxy could not reach the IRC server",
        5 => "the IRC server refused the connection",
        6 => "the proxy reported that the connection expired",
        7 => "the proxy does not support TCP connections",
        8 => "the proxy does not support that address type",
        _ => "the proxy refused the connection",
    }
}

async fn read_task(
    mut reader: impl AsyncRead + Unpin,
    events: mpsc::Sender<TransportEvent>,
    mut stop: watch::Receiver<Option<DisconnectReason>>,
    stop_tx: Arc<watch::Sender<Option<DisconnectReason>>>,
) {
    let mut framer = Framer::new();
    let mut chunk = [0u8; READ_CHUNK];

    let reason = loop {
        let read = tokio::select! {
            _ = stop.changed() => {
                let reason = stop.borrow_and_update().as_ref().cloned();
                break reason.unwrap_or(DisconnectReason::Shutdown);
            }
            read = reader.read(&mut chunk) => read,
        };
        let bytes = match read {
            Ok(0) => break DisconnectReason::ServerClosed,
            Ok(bytes) => bytes,
            Err(error) => break DisconnectReason::Io(error.to_string()),
        };

        framer.push(&chunk[..bytes]);
        while let Some(framed) = framer.next_line() {
            match framed {
                Framed::Line(line) => {
                    if events.send(TransportEvent::Line(line)).await.is_err() {
                        let _ = stop_tx.send(Some(DisconnectReason::Shutdown));
                        return;
                    }
                }
                Framed::Overlong { bytes } => {
                    warn!(bytes, "dropped an inbound line over the size cap");
                }
            }
        }
    };

    let _ = stop_tx.send(Some(reason.clone()));
    let _ = events.send(TransportEvent::Disconnected { reason }).await;
}

async fn write_task(
    mut writer: impl AsyncWrite + Unpin,
    mut outbound: mpsc::Receiver<Outbound>,
    written: watch::Sender<u64>,
    mut stop: watch::Receiver<Option<DisconnectReason>>,
    stop_tx: Arc<watch::Sender<Option<DisconnectReason>>>,
    rate_limit: RateLimit,
) {
    let mut bucket = TokenBucket::new(rate_limit);

    loop {
        let queued = tokio::select! {
            _ = stop.changed() => break,
            line = outbound.recv() => match line {
                Some(queued) => queued,
                None => break,
            },
        };
        tokio::select! {
            _ = stop.changed() => break,
            () = bucket.acquire() => {}
        }

        let mut frame = queued.line.into_bytes();
        frame.extend_from_slice(b"\r\n");
        // The flush is load-bearing on the TLS path: `write_all` only hands
        // the line to rustls, and when the socket was not ready the
        // ciphertext waits in its buffer for the next write — which for a
        // lone PONG on an idle queue is never. Plain TCP flushes for free.
        let sent = async {
            writer.write_all(&frame).await?;
            writer.flush().await
        };
        if let Err(error) = sent.await {
            debug!(%error, "outbound write failed");
            let _ = stop_tx.send(Some(DisconnectReason::Io(error.to_string())));
            break;
        }
        // After the write, so a mark that has moved is a line that went out.
        // A `watch` rather than an event because the writer must never block on
        // the reader: the reader is what drains `outbound`, and a writer waiting
        // on a full event queue would be waiting for itself.
        let _ = written.send(queued.ticket);
    }

    let _ = writer.shutdown().await;
}
