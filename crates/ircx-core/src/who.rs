//! The `WHO` a channel is asked on join, and what comes back.
//!
//! `NAMES` names everybody and says nothing else about them, and an
//! `extended-join` speaks only for somebody who arrives after you. A `WHO` is
//! the one question that answers for a roster that was already there: who is
//! away, what account they are signed in to, and what they call themselves.
//!
//! `session.rs` sends it and folds the answers into the members it already
//! holds. Nothing here adds one: `NAMES` is the roster, and a reply about
//! somebody outside it is about a channel this client is not reading.

use crate::session::build;

/// The `WHOX` fields to ask for, written in the order a `354` returns them —
/// the channel, the nick, the flags the away state is in, the account and the
/// real name. A server returns them in that order whatever order they were
/// asked in, so this is the reply's shape as much as the request's.
///
/// No token among them. A token is what tells one client's `WHO` from
/// another's, and here the channel already does: `session.rs` holds the
/// channels it has a `WHO` outstanding for, and a reply naming any other one is
/// somebody else's and is drawn rather than swallowed.
const FIELDS: &str = "%cnfar";

/// What a `WHO` said about one person, as much of it as the reply carried.
#[derive(Debug, PartialEq)]
pub(crate) struct Reply {
    pub(crate) channel: String,
    pub(crate) nick: String,
    /// `None` where the flags field said neither `H` nor `G`.
    pub(crate) away: Option<bool>,
    /// `None` where the reply had no account field at all, which is every plain
    /// `WHO`; `Some(None)` where it had one and it named nothing. The
    /// difference is what stops a server with no `WHOX` erasing the account an
    /// `extended-join` gave.
    pub(crate) account: Option<Option<String>>,
    pub(crate) realname: Option<String>,
}

/// The question, which is one line per join.
///
/// A `WHOX` server is asked for the fields it can name. One without it gets a
/// plain `WHO` and answers `352`, which carries the away flag and the real name
/// and has nowhere to put an account.
pub(crate) fn request(channel: &str, whox: bool) -> Option<String> {
    match whox {
        true => build("WHO", &[channel, FIELDS]),
        false => build("WHO", &[channel]),
    }
}

/// `352 <client> <channel> <user> <host> <server> <nick> <flags> :<hops> <real name>`,
/// with the client's own nick already taken off the front.
pub(crate) fn reply(params: &[String]) -> Option<Reply> {
    Some(Reply {
        channel: params.first()?.clone(),
        nick: params.get(4)?.clone(),
        away: away(params.get(5)?),
        account: None,
        realname: params
            .get(6)
            .map(|trailing| without_hops(trailing))
            .and_then(realname),
    })
}

/// `354 <client> <channel> <nick> <flags> <account> :<real name>`, which is
/// `FIELDS` and nothing else.
pub(crate) fn whox_reply(params: &[String]) -> Option<Reply> {
    let account = params.get(3)?;
    Some(Reply {
        channel: params.first()?.clone(),
        nick: params.get(1)?.clone(),
        away: away(params.get(2)?),
        // `0` is what WHOX puts where somebody is signed in to nothing.
        account: Some((account != "0" && account != "*").then(|| account.clone())),
        realname: params.get(4).map(String::as_str).and_then(realname),
    })
}

/// `H` for here and `G` for gone, and after it whatever else the server marks
/// somebody with: an oper's `*`, the channel prefixes, a bot's `B`. Only the
/// first letter is the away state, and it says nothing about the reason — that
/// arrives in an `AWAY` or in a `WHOIS`, and nowhere in a `WHO`.
fn away(flags: &str) -> Option<bool> {
    match flags.chars().next() {
        Some('H') => Some(false),
        Some('G') => Some(true),
        _ => None,
    }
}

/// A `352` puts the hop count in front of the real name, inside the one
/// trailing parameter. A server that sends no hop count leaves a real name
/// whose first word is not a number.
fn without_hops(trailing: &str) -> &str {
    match trailing.split_once(' ') {
        Some((hops, rest)) if !hops.is_empty() && hops.bytes().all(|b| b.is_ascii_digit()) => rest,
        _ => trailing,
    }
}

fn realname(text: &str) -> Option<String> {
    (!text.trim().is_empty()).then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(list: &[&str]) -> Vec<String> {
        list.iter().map(|param| param.to_string()).collect()
    }

    #[test]
    fn a_whox_request_names_its_fields() {
        assert_eq!(request("#ircx", true).unwrap(), "WHO #ircx %cnfar");
        assert_eq!(request("#ircx", false).unwrap(), "WHO #ircx");
    }

    #[test]
    fn a_352_carries_the_away_flag_and_the_real_name() {
        let reply = reply(&params(&[
            "#ircx",
            "rae",
            "example.org",
            "irc.example.org",
            "rae",
            "G@",
            "0 Rae Ellis",
        ]))
        .unwrap();
        assert_eq!(reply.channel, "#ircx");
        assert_eq!(reply.nick, "rae");
        assert_eq!(reply.away, Some(true));
        assert_eq!(reply.realname.as_deref(), Some("Rae Ellis"));
    }

    /// The whole reason a plain `WHO` cannot answer for an account: there is no
    /// field for one, which is not the same as a field saying there is none.
    #[test]
    fn a_352_states_nothing_about_an_account() {
        let reply = reply(&params(&[
            "#ircx",
            "rae",
            "example.org",
            "irc.example.org",
            "rae",
            "H",
            "0 Rae",
        ]))
        .unwrap();
        assert_eq!(reply.account, None);
    }

    #[test]
    fn a_354_carries_the_account() {
        let reply = whox_reply(&params(&["#ircx", "rae", "H", "raeb", "Rae Ellis"])).unwrap();
        assert_eq!(reply.nick, "rae");
        assert_eq!(reply.away, Some(false));
        assert_eq!(reply.account, Some(Some("raeb".into())));
        assert_eq!(reply.realname.as_deref(), Some("Rae Ellis"));
    }

    #[test]
    fn a_354_says_signed_in_to_nothing_with_a_zero() {
        let reply = whox_reply(&params(&["#ircx", "rae", "G", "0", "Rae"])).unwrap();
        assert_eq!(reply.away, Some(true));
        assert_eq!(reply.account, Some(None));
    }

    /// Everything a server may hang off the away letter, and none of it is the
    /// away letter.
    #[test]
    fn only_the_first_flag_is_the_away_state() {
        assert_eq!(away("H"), Some(false));
        assert_eq!(away("G"), Some(true));
        assert_eq!(away("H*@"), Some(false));
        assert_eq!(away("G+B"), Some(true));
        assert_eq!(away(""), None);
        assert_eq!(away("*"), None);
    }

    #[test]
    fn a_real_name_that_begins_with_a_number_keeps_it() {
        assert_eq!(without_hops("0 Rae Ellis"), "Rae Ellis");
        assert_eq!(without_hops("12 3 blind mice"), "3 blind mice");
        // No hop count in front of it at all.
        assert_eq!(without_hops("Rae Ellis"), "Rae Ellis");
    }

    #[test]
    fn a_real_name_nobody_set_is_not_one() {
        let reply = whox_reply(&params(&["#ircx", "rae", "H", "0", "   "])).unwrap();
        assert_eq!(reply.realname, None);
    }

    #[test]
    fn a_reply_short_of_its_fields_is_no_reply() {
        assert_eq!(reply(&params(&["#ircx", "rae"])), None);
        assert_eq!(whox_reply(&params(&["#ircx", "rae"])), None);
    }
}
