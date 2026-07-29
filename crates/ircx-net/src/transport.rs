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

#[derive(Clone)]
pub struct LineSender {
    outbound: mpsc::Sender<String>,
}

impl LineSender {
    /// Queues a line for sending. The terminator is added here; the rate
    /// limiter may hold the line back, so returning does not mean it is on the
    /// wire.
    pub async fn send(&self, line: impl Into<String>) -> Result<(), NetError> {
        let line = line.into();
        if line.contains(['\r', '\n']) {
            return Err(NetError::EmbeddedNewline);
        }
        self.outbound.send(line).await.map_err(|_| NetError::Closed)
    }
}

pub struct Transport {
    outbound: mpsc::Sender<String>,
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
                stop_rx,
                stop_tx.clone(),
                rate_limit,
            )),
        ];

        Ok((
            Self {
                outbound: outbound_tx,
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
    let tcp = TcpStream::connect((config.host.as_str(), config.port))
        .await
        .map_err(|source| NetError::Connect {
            host: config.host.clone(),
            port: config.port,
            source,
        })?;
    let _ = tcp.set_nodelay(true);

    if !config.tls {
        return Ok((Box::new(tcp), None));
    }

    let name = rustls_pki_types::ServerName::try_from(config.host.clone()).map_err(|_| {
        NetError::InvalidHostname {
            host: config.host.clone(),
        }
    })?;
    let connector = TlsConnector::from(Arc::new(tls::client_config(config.tls_verify)));
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
    mut outbound: mpsc::Receiver<String>,
    mut stop: watch::Receiver<Option<DisconnectReason>>,
    stop_tx: Arc<watch::Sender<Option<DisconnectReason>>>,
    rate_limit: RateLimit,
) {
    let mut bucket = TokenBucket::new(rate_limit);

    loop {
        let line = tokio::select! {
            _ = stop.changed() => break,
            line = outbound.recv() => match line {
                Some(line) => line,
                None => break,
            },
        };
        tokio::select! {
            _ = stop.changed() => break,
            () = bucket.acquire() => {}
        }

        let mut frame = line.into_bytes();
        frame.extend_from_slice(b"\r\n");
        if let Err(error) = writer.write_all(&frame).await {
            debug!(%error, "outbound write failed");
            let _ = stop_tx.send(Some(DisconnectReason::Io(error.to_string())));
            break;
        }
    }

    let _ = writer.shutdown().await;
}
