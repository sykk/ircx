use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum NetError {
    #[error("timed out connecting to {host}:{port} after {} seconds", .timeout.as_secs())]
    ConnectTimeout {
        host: String,
        port: u16,
        timeout: Duration,
    },

    #[error("could not connect to {host}:{port}: {source}")]
    Connect {
        host: String,
        port: u16,
        #[source]
        source: std::io::Error,
    },

    #[error("TLS handshake with {host} failed: {source}")]
    Tls {
        host: String,
        #[source]
        source: std::io::Error,
    },

    #[error("{host} is not a name a TLS certificate can be checked against")]
    InvalidHostname { host: String },

    #[error("the connection is closed")]
    Closed,

    #[error("a line may not contain a carriage return or line feed")]
    EmbeddedNewline,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DisconnectReason {
    #[error("the server closed the connection")]
    ServerClosed,

    #[error("{0}")]
    Io(String),

    #[error("disconnected on request")]
    Shutdown,
}
