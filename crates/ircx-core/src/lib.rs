//! Capability negotiation, SASL, session state, and command dispatch. Owns the
//! connection task per network and emits `ircx_ipc::IrcxEvent`.
//!
//! `SessionState` is where the protocol lives and it does no I/O: lines go in,
//! [`Action`]s come out. `spawn_network` is the only part that touches a
//! socket, which is what lets the state machine be driven by a script in a
//! test.

mod caps;
mod casemap;
mod dispatch;
mod isupport;
mod message;
mod numeric;
mod sasl;
mod session;
mod task;
mod text;

pub use caps::SUPPORTED as SUPPORTED_CAPS;
pub use casemap::CaseMapping;
pub use isupport::ISupport;
pub use session::{Action, SaslCredentials, SessionConfig, SessionState, SERVER_TARGET};
pub use task::{spawn_network, NetworkHandle, SessionCommand};
