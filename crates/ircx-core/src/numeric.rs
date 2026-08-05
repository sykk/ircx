use ircx_ipc::Severity;

pub use ircx_proto::numeric::{
    ERR_NICKLOCKED, ERR_NICKNAMEINUSE, ERR_SASLABORTED, ERR_SASLALREADY, ERR_SASLFAIL,
    ERR_SASLTOOLONG, RPL_ENDOFNAMES, RPL_ISUPPORT, RPL_LOGGEDIN, RPL_NAMREPLY, RPL_SASLMECHS,
    RPL_SASLSUCCESS, RPL_TOPIC, RPL_WELCOME,
};

/// The three other ways a server refuses a NICK. During registration each is
/// as final as 433, so `session.rs` hands them the same fallback; once
/// registered they describe a failed rename, which the text below says.
pub const ERR_ERRONEUSNICKNAME: u16 = 432;
pub const ERR_NICKCOLLISION: u16 = 436;
pub const ERR_UNAVAILRESOURCE: u16 = 437;

pub const RPL_AWAY: u16 = 301;
pub const RPL_LISTSTART: u16 = 321;
pub const RPL_LIST: u16 = 322;
pub const RPL_LISTEND: u16 = 323;
pub const RPL_CHANNELMODEIS: u16 = 324;
pub const RPL_NOTOPIC: u16 = 331;
pub const RPL_TOPICWHOTIME: u16 = 333;
/// The WHOIS replies worth rewriting. Each puts its data *before* the server's
/// trailing text, so joining the parameters — which is what an unhandled
/// numeric falls back to — reads backwards or unlabelled. `session.rs` writes
/// them, because two of them need the same clock the topic's does.
pub const RPL_WHOISUSER: u16 = 311;
pub const RPL_WHOISSERVER: u16 = 312;
pub const RPL_WHOISIDLE: u16 = 317;
pub const RPL_WHOISCHANNELS: u16 = 319;
pub const RPL_WHOISACCOUNT: u16 = 330;
/// A channel and a unix timestamp, with no words at all.
pub const RPL_CREATIONTIME: u16 = 329;
/// Both send their figures as parameters *and* in the trailing sentence, so
/// joining them prints every number twice.
pub const RPL_LOCALUSERS: u16 = 265;
pub const RPL_GLOBALUSERS: u16 = 266;
pub const ERR_NOSUCHNICK: u16 = 401;
pub const ERR_UNKNOWNCOMMAND: u16 = 421;

/// A sentence a user can act on, or `None` when the numeric is better rendered
/// as the server's own words.
pub fn describe(code: u16, params: &[String], network: &str) -> Option<(Severity, String)> {
    let first = params.first().map(String::as_str).unwrap_or("");
    let second = params.get(1).map(String::as_str).unwrap_or("");
    let reason = params.last().map(String::as_str).unwrap_or("");

    let sentence = match code {
        ERR_NOSUCHNICK => (
            Severity::Warning,
            format!("There is no user called `{first}` on {network}"),
        ),
        402 => (
            Severity::Warning,
            format!("{network} has no server called `{first}`"),
        ),
        403 => (
            Severity::Warning,
            format!("There is no channel called `{first}` on {network}"),
        ),
        404 => (
            Severity::Error,
            format!("`{first}` would not take your message — {reason}"),
        ),
        405 => (
            Severity::Error,
            format!("You are in too many channels on {network} to join `{first}`"),
        ),
        ERR_UNKNOWNCOMMAND => (
            Severity::Error,
            format!("{network} does not know the command `{first}`"),
        ),
        431 => (Severity::Error, "A nickname is required".into()),
        432 => (
            Severity::Error,
            format!("{network} will not accept the nickname `{first}` — {reason}"),
        ),
        436 => (
            Severity::Error,
            format!("The nickname `{first}` collided with another network on {network}"),
        ),
        437 => (
            Severity::Warning,
            format!("`{first}` is held for a moment on {network} — {reason}"),
        ),
        441 => (Severity::Warning, format!("`{first}` is not in {second}")),
        442 => (Severity::Warning, format!("You are not in {first}")),
        443 => (
            Severity::Warning,
            format!("`{first}` is already in {second}"),
        ),
        451 => (
            Severity::Error,
            format!("{network} wants registration to finish before that"),
        ),
        461 => (
            Severity::Error,
            format!("`{first}` needs more arguments than that"),
        ),
        462 => (
            Severity::Warning,
            "You are already registered on this connection".into(),
        ),
        464 => (
            Severity::Error,
            format!("{network} rejected the connection password"),
        ),
        465 => (
            Severity::Error,
            format!("You are banned from {network} — {reason}"),
        ),
        471 => (Severity::Warning, format!("{first} is full")),
        473 => (Severity::Warning, format!("{first} is invite only")),
        474 => (Severity::Warning, format!("You are banned from {first}")),
        475 => (
            Severity::Warning,
            format!("{first} needs a key — try `/join {first} <key>`"),
        ),
        476 => (Severity::Warning, format!("`{first}` is not a valid mask")),
        477 => (
            Severity::Warning,
            format!("{first} is open only to accounts registered with {network}"),
        ),
        478 => (
            Severity::Warning,
            format!("The ban list for {first} is full"),
        ),
        481 => (
            Severity::Warning,
            format!("That needs operator privileges on {network}"),
        ),
        482 => (
            Severity::Warning,
            format!("That needs channel operator status in {first}"),
        ),
        484 => (
            Severity::Warning,
            format!("Your connection to {network} is restricted"),
        ),
        491 => (
            Severity::Error,
            format!("{network} has no operator block for you"),
        ),
        501 => (Severity::Warning, "That is not a known user mode".into()),
        502 => (
            Severity::Warning,
            "You can only change modes on yourself".into(),
        ),
        _ => return None,
    };
    Some(sentence)
}
