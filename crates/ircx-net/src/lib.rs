//! TLS transport, line framing, and reconnect policy. Knows nothing about IRC
//! semantics beyond where a line ends.
//!
//! `http` is here rather than in the command layer so every outbound socket
//! ircx opens is in one crate, sharing one rustls configuration.

mod backoff;
pub mod dcc;
mod error;
mod framing;
pub mod http;
mod rate_limit;
mod tls;
mod transport;

pub use backoff::{Backoff, BackoffPolicy};
pub use error::{DisconnectReason, NetError};
pub use framing::MAX_LINE_BYTES;
pub use rate_limit::RateLimit;
pub use tls::{certificate_fingerprint, TlsInfo};
pub use transport::{ConnectionConfig, LineSender, Transport, TransportEvent};
