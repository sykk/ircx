//! Moving one file over a direct connection.
//!
//! A DCC data stream is the file and nothing else: no framing, no length, no
//! name. Everything about what is arriving was agreed in the CTCP handshake
//! that `ircx_core::dcc` parses, and this crate is told the answer. The only
//! thing travelling the other way is the acknowledgement — four bytes of
//! running total after every write, which the oldest senders wait for and the
//! newest ignore.
//!
//! Cancelling is dropping the future. Nothing here needs a stop signal: the
//! socket closes when the task is aborted, and the part of the file already
//! written stays on disk, which is what a resume is later built on.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::fs::OpenOptions;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpListener, TcpStream, UdpSocket};
use tokio::sync::mpsc;
use tokio::time::{timeout, Instant};

/// Read and written a chunk at a time. Large enough that a fast transfer is not
/// one syscall per packet, small enough that cancelling lands promptly.
const CHUNK: usize = 64 * 1024;

/// How often the caller hears how far the transfer has got. A progress bar
/// cannot show more than this and an event per chunk would be thousands a
/// second on a local network.
const PROGRESS_EVERY: Duration = Duration::from_millis(200);

/// How long a client that offered a file waits for the other side to connect.
/// Long enough for somebody to read the offer and decide.
const ACCEPT_WITHIN: Duration = Duration::from_secs(120);

const CONNECT_WITHIN: Duration = Duration::from_secs(30);

/// How long a sender waits after its last byte for the acknowledgement of it.
///
/// The bytes are already gone by then, so this is only about which side hangs
/// up first: a receiver that wants the last ack read gets a moment to have it,
/// and one that has already closed costs nothing.
const FINAL_ACK_WITHIN: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum TransferError {
    #[error("no port between {first} and {last} was free to receive the file on")]
    NoFreePort { first: u16, last: u16 },

    #[error("could not open a port for the transfer: {source}")]
    Listen {
        #[source]
        source: io::Error,
    },

    #[error("nobody connected in the {} seconds after the offer was sent", ACCEPT_WITHIN.as_secs())]
    NobodyConnected,

    #[error("could not connect to {address}:{port}: {source}")]
    Connect {
        address: IpAddr,
        port: u16,
        #[source]
        source: io::Error,
    },

    #[error("timed out connecting to {address}:{port}")]
    ConnectTimeout { address: IpAddr, port: u16 },

    #[error("{path} could not be opened: {source}")]
    File {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("the connection failed after {at} of {size} bytes: {source}")]
    Interrupted {
        at: u64,
        size: u64,
        #[source]
        source: io::Error,
    },

    #[error("the connection closed after {at} of {size} bytes")]
    Short { at: u64, size: u64 },

    #[error("{} is no longer the part of the file the resume was agreed against", path.display())]
    Vanished { path: PathBuf },
}

/// A port opened for one transfer, before anybody has been told about it.
///
/// Binding and accepting are separate because the port number is part of what
/// is offered: a passive offer cannot be answered until the port exists, and
/// nothing can connect to it until the answer has been sent.
pub struct Waiting {
    listener: TcpListener,
}

impl Waiting {
    /// `ports` is the range the user forwarded, or `None` to let the operating
    /// system choose — which works for a client that is directly reachable and
    /// not for one behind a router nobody has configured.
    ///
    /// `advertised` is the address the other side is about to be told to
    /// connect to, and it decides the family this listens on. Binding one
    /// family and naming an address in the other is a port nobody can reach:
    /// it was IPv4 whatever the offer said, so an IPv6 client was sent to a
    /// socket that did not exist.
    ///
    /// Within that family the socket binds every address rather than the one
    /// named, because the address the peer was told to use is not always an
    /// address this machine holds: behind NAT it is the router's.
    pub async fn open(
        ports: Option<(u16, u16)>,
        advertised: IpAddr,
    ) -> Result<Self, TransferError> {
        let any = anywhere(advertised);
        let Some((first, last)) = ports else {
            let listener = TcpListener::bind(SocketAddr::new(any, 0))
                .await
                .map_err(|source| TransferError::Listen { source })?;
            return Ok(Self { listener });
        };

        for port in first..=last {
            if let Ok(listener) = TcpListener::bind(SocketAddr::new(any, port)).await {
                return Ok(Self { listener });
            }
        }
        Err(TransferError::NoFreePort { first, last })
    }

    /// The port to tell the other side about.
    pub fn port(&self) -> u16 {
        self.listener
            .local_addr()
            .map(|address| address.port())
            .unwrap_or_default()
    }

    /// The first connection, and only the first: the listener is dropped with
    /// this call, so a second client racing for the same offer finds the port
    /// closed rather than a transfer to interfere with.
    pub async fn accept(self) -> Result<TcpStream, TransferError> {
        match timeout(ACCEPT_WITHIN, self.listener.accept()).await {
            Ok(Ok((stream, _))) => Ok(stream),
            Ok(Err(source)) => Err(TransferError::Listen { source }),
            Err(_) => Err(TransferError::NobodyConnected),
        }
    }
}

/// Where a file is written while it is still arriving.
///
/// A transfer that stops leaves this behind, and it is what a later resume is
/// measured against. Without it there is no resuming at all: a partial file
/// under the final name cannot be told from an unrelated file somebody already
/// had, and appending to the wrong one corrupts it silently.
pub fn partial(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Every address of the same family, which is what a listener binds.
fn anywhere(like: IpAddr) -> IpAddr {
    match like {
        IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    }
}

/// The address this machine would reach `host` from, which is the best guess
/// available for what to put in an offer.
///
/// A connected UDP socket sends nothing. The kernel picks the route on connect
/// and the local address is what it picked. Behind NAT that is a private
/// address and reaches nobody, which is what the address setting and passive
/// offers are for.
///
/// The name is resolved first so the socket can be opened in the family the
/// answer is in. A socket bound to `0.0.0.0` cannot be connected to an IPv6
/// address at all — it fails with `Address family not supported by protocol` —
/// so a client on an IPv6 network used to get no address here, and every offer
/// it tried to make was refused before it reached the wire.
///
/// Each resolved address is tried in turn: a host with both an A and a AAAA
/// record resolves to both, and which of them this machine can actually route
/// to is the question being asked.
pub async fn local_address(host: &str, port: u16) -> Option<IpAddr> {
    for target in lookup_host((host, port)).await.ok()? {
        let Ok(socket) = UdpSocket::bind(SocketAddr::new(anywhere(target.ip()), 0)).await else {
            continue;
        };
        if socket.connect(target).await.is_err() {
            continue;
        }
        if let Ok(local) = socket.local_addr() {
            return Some(local.ip());
        }
    }
    None
}

pub async fn dial(address: IpAddr, port: u16) -> Result<TcpStream, TransferError> {
    match timeout(
        CONNECT_WITHIN,
        TcpStream::connect(SocketAddr::new(address, port)),
    )
    .await
    {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(source)) => Err(TransferError::Connect {
            address,
            port,
            source,
        }),
        Err(_) => Err(TransferError::ConnectTimeout { address, port }),
    }
}

/// Writes the incoming file to `path`, starting `from` bytes in.
///
/// The bytes go to [`partial`] and the file takes its real name only once all
/// of them have arrived, so that what is on disk under the name the user chose
/// is never half a file.
///
/// `size` is what the offer claimed and is enforced rather than trusted: the
/// connection belongs to the sender and the disk does not, so nothing past the
/// offered size is written. A `size` of zero is a sender that did not say, and
/// the file is then whatever arrives before the connection closes.
pub async fn receive(
    mut stream: TcpStream,
    final_path: &Path,
    from: u64,
    size: u64,
    progress: mpsc::Sender<u64>,
) -> Result<u64, TransferError> {
    let path = &partial(final_path);
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(from == 0)
        .open(path)
        .await
        .map_err(|source| TransferError::File {
            path: path.to_owned(),
            source,
        })?;
    // The sender is already skipping `from` bytes, so a part file shorter than
    // that would be finished with a hole in the middle of it and no sign that
    // anything was wrong. It was measured before the handshake; something else
    // has touched it since.
    let held = file
        .metadata()
        .await
        .map_err(|source| TransferError::File {
            path: path.to_owned(),
            source,
        })?
        .len();
    if held < from {
        return Err(TransferError::Vanished { path: path.clone() });
    }
    file.seek(io::SeekFrom::Start(from))
        .await
        .map_err(|source| TransferError::File {
            path: path.to_owned(),
            source,
        })?;

    let mut at = from;
    let mut buffer = vec![0u8; CHUNK];
    let mut told = Instant::now();

    while size == 0 || at < size {
        let room = match size {
            0 => buffer.len(),
            size => buffer.len().min((size - at) as usize),
        };
        let read = stream
            .read(&mut buffer[..room])
            .await
            .map_err(|source| TransferError::Interrupted { at, size, source })?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .await
            .map_err(|source| TransferError::File {
                path: path.to_owned(),
                source,
            })?;
        at += read as u64;
        // The running total, truncated to the four bytes the acknowledgement
        // has always been. A file past four gigabytes therefore acknowledges
        // the same number twice, which is what every client does with one.
        let ack = ((at & 0xFFFF_FFFF) as u32).to_be_bytes();
        stream
            .write_all(&ack)
            .await
            .map_err(|source| TransferError::Interrupted { at, size, source })?;

        if told.elapsed() >= PROGRESS_EVERY {
            told = Instant::now();
            let _ = progress.try_send(at);
        }
    }

    file.flush().await.map_err(|source| TransferError::File {
        path: path.to_owned(),
        source,
    })?;
    let _ = progress.send(at).await;

    if size > 0 && at < size {
        return Err(TransferError::Short { at, size });
    }
    tokio::fs::rename(path, final_path)
        .await
        .map_err(|source| TransferError::File {
            path: final_path.to_owned(),
            source,
        })?;
    Ok(at)
}

/// Sends `path` down the connection, starting `from` bytes in.
///
/// Acknowledgements are read while the file is being written, not after it. A
/// receiver acknowledging every chunk fills this side's receive buffer on a
/// large file, and a sender that never reads would then block the receiver's
/// writes and deadlock a transfer that was working.
pub async fn send(
    stream: TcpStream,
    path: &Path,
    from: u64,
    progress: mpsc::Sender<u64>,
) -> Result<u64, TransferError> {
    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .await
        .map_err(|source| TransferError::File {
            path: path.to_owned(),
            source,
        })?;
    let size = file
        .metadata()
        .await
        .map_err(|source| TransferError::File {
            path: path.to_owned(),
            source,
        })?
        .len();
    file.seek(io::SeekFrom::Start(from))
        .await
        .map_err(|source| TransferError::File {
            path: path.to_owned(),
            source,
        })?;

    let (mut acks, mut socket) = stream.into_split();
    let drain = tokio::spawn(async move {
        let mut discarded = [0u8; 64];
        while matches!(acks.read(&mut discarded).await, Ok(read) if read > 0) {}
    });

    let mut at = from;
    let mut buffer = vec![0u8; CHUNK];
    let mut told = Instant::now();

    while at < size {
        let read = file
            .read(&mut buffer)
            .await
            .map_err(|source| TransferError::File {
                path: path.to_owned(),
                source,
            })?;
        if read == 0 {
            break;
        }
        socket
            .write_all(&buffer[..read])
            .await
            .map_err(|source| TransferError::Interrupted { at, size, source })?;
        at += read as u64;

        if told.elapsed() >= PROGRESS_EVERY {
            told = Instant::now();
            let _ = progress.try_send(at);
        }
    }

    socket
        .flush()
        .await
        .map_err(|source| TransferError::Interrupted { at, size, source })?;
    let _ = progress.send(at).await;
    // The receiver is given its moment to acknowledge the last chunk before the
    // socket is dropped; whether it takes it does not change what was sent.
    let _ = timeout(FINAL_ACK_WITHIN, drain).await;

    match at < size {
        true => Err(TransferError::Short { at, size }),
        false => Ok(at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn moved(content: &[u8], from: u64) -> (Vec<u8>, u64) {
        let directory = std::env::temp_dir().join(format!(
            "ircx-dcc-{}-{from}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("a clock after 1970")
                .as_nanos()
        ));
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("a temporary directory");
        let source = directory.join("source");
        let landed = directory.join("landed");
        tokio::fs::write(&source, content)
            .await
            .expect("the file to send");
        if from > 0 {
            tokio::fs::write(partial(&landed), &content[..from as usize])
                .await
                .expect("the part already received");
        }

        let waiting = Waiting::open(None, Ipv4Addr::LOCALHOST.into())
            .await
            .expect("a port");
        let port = waiting.port();
        let sending = tokio::spawn(async move {
            let stream = waiting.accept().await.expect("a connection");
            let (progress, _sink) = mpsc::channel(8);
            send(stream, &source, from, progress).await
        });

        let stream = dial(Ipv4Addr::LOCALHOST.into(), port)
            .await
            .expect("a connection");
        let (progress, mut seen) = mpsc::channel(64);
        let received = receive(stream, &landed, from, content.len() as u64, progress)
            .await
            .expect("the file");
        sending.await.expect("the sender").expect("the file sent");
        assert!(
            seen.recv().await.is_some(),
            "the caller is told where it got to"
        );

        let written = tokio::fs::read(&landed).await.expect("the received file");
        let _ = tokio::fs::remove_dir_all(&directory).await;
        (written, received)
    }

    #[tokio::test]
    async fn moves_a_file() {
        let content: Vec<u8> = (0..200_000u32).map(|byte| byte as u8).collect();
        let (written, received) = moved(&content, 0).await;
        assert_eq!(received, content.len() as u64);
        assert_eq!(written, content);
    }

    /// A resumed transfer sends the tail and the receiver appends it, so what
    /// lands is the whole file and not the tail twice.
    #[tokio::test]
    async fn resumes_where_the_partial_file_left_off() {
        let content: Vec<u8> = (0..200_000u32).map(|byte| byte as u8).collect();
        let (written, received) = moved(&content, 150_000).await;
        assert_eq!(received, content.len() as u64);
        assert_eq!(written, content);
    }

    /// Cancelling is dropping the future, and what it leaves behind is what the
    /// next resume is measured against. If an abandoned receive took its part
    /// file with it there would be nothing to resume from, and the whole
    /// arrangement would be a slower way of starting again.
    ///
    /// How much is there is deliberately not asserted. Writes are handed to the
    /// blocking pool and the last of them may not have landed when the future
    /// is dropped — which costs nothing, because a resume measures the file
    /// rather than trusting the count: it starts again from whatever is really
    /// on disk.
    #[tokio::test]
    async fn an_abandoned_receive_leaves_what_arrived() {
        let directory = std::env::temp_dir().join("ircx-dcc-abandoned");
        let _ = tokio::fs::remove_dir_all(&directory).await;
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("a temporary directory");
        let landed = directory.join("landed");

        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("a port");
        let port = listener.local_addr().expect("the port").port();
        // A chunk and then nothing, without closing: what being in the middle
        // of a transfer looks like from the other end.
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("a connection");
            let _ = stream.write_all(&[7u8; 4096]).await;
            std::future::pending::<()>().await;
        });

        let stream = dial(Ipv4Addr::LOCALHOST.into(), port)
            .await
            .expect("a connection");
        let (progress, _sink) = mpsc::channel(8);
        // Dropping the future is the cancel: `Elapsed` is the receive still
        // running at the moment it was dropped.
        let stopped = timeout(
            Duration::from_millis(500),
            receive(stream, &landed, 0, 100_000, progress),
        )
        .await;
        assert!(stopped.is_err(), "the transfer had not finished on its own");

        let held = tokio::fs::metadata(partial(&landed))
            .await
            .expect("the part file the abandoned transfer left")
            .len();
        assert!(held > 0, "and it holds what arrived");
        assert!(
            !landed.exists(),
            "which has not taken the name the reader chose"
        );
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }

    /// A socket bound to `0.0.0.0` cannot be connected to an IPv6 address at
    /// all, so this used to answer nothing on an IPv6 network and every offer
    /// was refused before it reached the wire.
    #[tokio::test]
    async fn finds_an_address_to_offer_from_over_either_family() {
        // Nothing has to be listening: a connected UDP socket sends no packet,
        // it only asks the routing table which way it would go.
        let v6 = local_address("::1", 6667).await;
        assert!(matches!(v6, Some(IpAddr::V6(_))), "{v6:?}");

        let v4 = local_address("127.0.0.1", 6667).await;
        assert!(matches!(v4, Some(IpAddr::V4(_))), "{v4:?}");
    }

    /// A client on an IPv6 network offering a file used to name an IPv6
    /// address and open an IPv4 port, so the other side was sent to a socket
    /// that did not exist. The family the offer names is the family the port
    /// is opened in.
    #[tokio::test]
    async fn listens_in_the_family_the_offer_names() {
        let waiting = Waiting::open(None, Ipv6Addr::LOCALHOST.into())
            .await
            .expect("a port");
        let port = waiting.port();
        let accepted = tokio::spawn(waiting.accept());

        let reached = TcpStream::connect(SocketAddr::from((Ipv6Addr::LOCALHOST, port))).await;
        assert!(reached.is_ok(), "an IPv6 client reaches it: {reached:?}");
        assert!(accepted.await.expect("the listener").is_ok());

        let waiting = Waiting::open(None, Ipv4Addr::LOCALHOST.into())
            .await
            .expect("a port");
        let port = waiting.port();
        let accepted = tokio::spawn(waiting.accept());
        assert!(
            TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
                .await
                .is_ok()
        );
        assert!(accepted.await.expect("the listener").is_ok());
    }

    /// The whole file, over IPv6, with the handshake this crate is told the
    /// answer to. The rest of the suite runs on IPv4 and would not notice a
    /// v6-shaped hole anywhere in the path.
    #[tokio::test]
    async fn moves_a_file_over_ipv6() {
        let directory = std::env::temp_dir().join("ircx-dcc-v6");
        let _ = tokio::fs::remove_dir_all(&directory).await;
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("a temporary directory");
        let source = directory.join("source");
        let landed = directory.join("landed");
        let content: Vec<u8> = (0..120_000u32).map(|byte| byte as u8).collect();
        tokio::fs::write(&source, &content)
            .await
            .expect("the file to send");

        let waiting = Waiting::open(None, Ipv6Addr::LOCALHOST.into())
            .await
            .expect("a port");
        let port = waiting.port();
        let sending = tokio::spawn(async move {
            let stream = waiting.accept().await.expect("a connection");
            let (progress, _sink) = mpsc::channel(8);
            send(stream, &source, 0, progress).await
        });

        let stream = dial(Ipv6Addr::LOCALHOST.into(), port)
            .await
            .expect("a connection");
        let (progress, _sink) = mpsc::channel(8);
        let received = receive(stream, &landed, 0, content.len() as u64, progress)
            .await
            .expect("the file");
        sending.await.expect("the sender").expect("the file sent");

        assert_eq!(received, content.len() as u64);
        assert_eq!(
            tokio::fs::read(&landed).await.expect("the received file"),
            content
        );
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }

    /// A resume is agreed against a part file measured before the handshake. If
    /// that file has since shrunk, carrying on would leave a hole in the middle
    /// of the finished file and nothing would say so.
    #[tokio::test]
    async fn refuses_to_resume_into_a_part_file_that_is_no_longer_there() {
        let directory = std::env::temp_dir().join("ircx-dcc-vanished");
        let _ = tokio::fs::remove_dir_all(&directory).await;
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("a temporary directory");
        let landed = directory.join("landed");

        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("a port");
        let port = listener.local_addr().expect("the port").port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("a connection");
            let _ = stream.write_all(&[7u8; 10]).await;
        });

        let stream = dial(Ipv4Addr::LOCALHOST.into(), port)
            .await
            .expect("a connection");
        let (progress, _sink) = mpsc::channel(8);
        let refused = receive(stream, &landed, 500, 510, progress).await;

        assert!(matches!(refused, Err(TransferError::Vanished { .. })));
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }

    /// The offered size is a limit and not a hint: a sender that keeps writing
    /// past it is writing to somebody else's disk.
    #[tokio::test]
    async fn writes_no_more_than_the_offer_claimed() {
        let directory = std::env::temp_dir().join("ircx-dcc-overrun");
        tokio::fs::create_dir_all(&directory)
            .await
            .expect("a temporary directory");
        let landed = directory.join("landed");

        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("a port");
        let port = listener.local_addr().expect("the port").port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("a connection");
            let _ = stream.write_all(&[7u8; 4096]).await;
        });

        let stream = dial(Ipv4Addr::LOCALHOST.into(), port)
            .await
            .expect("a connection");
        let (progress, _sink) = mpsc::channel(8);
        let received = receive(stream, &landed, 0, 100, progress)
            .await
            .expect("the file");

        assert_eq!(received, 100);
        assert_eq!(
            tokio::fs::metadata(&landed)
                .await
                .expect("the received file")
                .len(),
            100
        );
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }

    #[tokio::test]
    async fn a_connection_that_stops_early_is_a_failure() {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .await
            .expect("a port");
        let port = listener.local_addr().expect("the port").port();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("a connection");
            let _ = stream.write_all(&[7u8; 10]).await;
        });

        let landed = std::env::temp_dir().join("ircx-dcc-short");
        let stream = dial(Ipv4Addr::LOCALHOST.into(), port)
            .await
            .expect("a connection");
        let (progress, _sink) = mpsc::channel(8);
        let failed = receive(stream, &landed, 0, 5_000, progress).await;

        assert!(matches!(
            failed,
            Err(TransferError::Short {
                at: 10,
                size: 5_000
            })
        ));
        assert!(
            !landed.exists(),
            "an unfinished file does not take the name the user chose"
        );
        assert_eq!(
            tokio::fs::metadata(partial(&landed))
                .await
                .expect("the part that did arrive")
                .len(),
            10,
            "and what arrived is kept, because a resume is measured against it"
        );
        let _ = tokio::fs::remove_file(partial(&landed)).await;
    }
}
