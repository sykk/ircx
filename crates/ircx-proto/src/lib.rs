//! IRC line parsing and serialisation. No I/O, no async, no allocation beyond
//! the parsed message itself.

mod builder;
mod message;
pub mod numeric;

pub use builder::MessageBuilder;
pub use message::{Command, Message, ParseError, Prefix, MAX_MESSAGE_BYTES, MAX_TAG_BYTES};
