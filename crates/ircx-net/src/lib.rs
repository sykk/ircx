//! TLS transport, line framing, and reconnect policy. Knows nothing about IRC
//! semantics beyond where a line ends.

mod backoff;
mod error;
mod framing;
mod rate_limit;
mod tls;
mod transport;

pub use backoff::{Backoff, BackoffPolicy};
pub use error::{DisconnectReason, NetError};
pub use framing::MAX_LINE_BYTES;
pub use rate_limit::RateLimit;
pub use tls::TlsInfo;
pub use transport::{ConnectionConfig, LineSender, Transport, TransportEvent};
