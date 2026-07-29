//! Capability negotiation, SASL, session state, and command dispatch. Owns the
//! connection task per network and emits `ircx_ipc::IrcxEvent`.
