//! The DCC handshake, which is CTCP text in both directions.
//!
//! Nothing here opens a socket — `ircx_net::dcc` moves the bytes and the
//! session decides whether they should move at all. What is here is the wire
//! format, which predates any specification and has several dialects.
//!
//! Two of them shape the parser. A file name comes first and may contain
//! spaces: mIRC wraps such a name in quotes, and clients that do not send it
//! bare. So the numeric fields are counted from the right, where how many there
//! are is known, rather than from the left where the name has already eaten an
//! unknown number of them. And the trailing token is optional — it is what
//! makes an offer passive — so both readings are tried and one is kept only if
//! every field it claims parses.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// A DCC request as it arrived, with the file name still as the sender wrote it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    /// A port of zero is a passive offer: the sender is not listening, and the
    /// receiver is the one that opens a port and answers with this token.
    Send {
        file: String,
        address: IpAddr,
        port: u16,
        size: u64,
        token: Option<String>,
    },
    /// The receiver already holds `position` bytes and is asking for the rest.
    Resume {
        file: String,
        port: u16,
        position: u64,
        token: Option<String>,
    },
    /// The sender agreeing to start `position` bytes in.
    Accept {
        file: String,
        port: u16,
        position: u64,
        token: Option<String>,
    },
    /// An offer turned down, so that neither side is left waiting out the
    /// connect timeout on a transfer that will not happen.
    Reject { file: String },
}

/// Reads the argument of a `DCC` CTCP: everything after the word `DCC` itself.
///
/// `None` for a verb this client does not implement, which includes `CHAT`, and
/// for a request whose fields do not parse. Both are drawn as the plain CTCP
/// line they arrived as rather than acted on.
pub fn parse(args: &str) -> Option<Request> {
    let (verb, body) = args.trim().split_once(' ')?;
    if verb.eq_ignore_ascii_case("SEND") {
        return offer(body);
    }
    if verb.eq_ignore_ascii_case("RESUME") {
        let (file, port, position, token) = position(body)?;
        return Some(Request::Resume {
            file,
            port,
            position,
            token,
        });
    }
    if verb.eq_ignore_ascii_case("REJECT") {
        // `REJECT` names the verb it is rejecting, and `SEND` is the only one
        // this client ever offers.
        let (rejected, file) = body.trim().split_once(' ')?;
        return rejected
            .eq_ignore_ascii_case("SEND")
            .then(|| Request::Reject {
                file: file.trim().trim_matches('"').to_owned(),
            });
    }
    if verb.eq_ignore_ascii_case("ACCEPT") {
        let (file, port, position, token) = position(body)?;
        return Some(Request::Accept {
            file,
            port,
            position,
            token,
        });
    }
    None
}

fn offer(body: &str) -> Option<Request> {
    for count in [4, 3] {
        let Some((file, tail)) = split(body, count) else {
            continue;
        };
        let Some(address) = address(tail[0]) else {
            continue;
        };
        let (Ok(port), Ok(size)) = (tail[1].parse::<u16>(), tail[2].parse::<u64>()) else {
            continue;
        };
        let token = tail.get(3).map(|token| (*token).to_owned());
        // A passive offer nothing can be matched against is an offer that
        // cannot be answered, whatever else parsed.
        if port == 0 && token.is_none() {
            continue;
        }
        return Some(Request::Send {
            file,
            address,
            port,
            size,
            token,
        });
    }
    None
}

fn position(body: &str) -> Option<(String, u16, u64, Option<String>)> {
    for count in [3, 2] {
        let Some((file, tail)) = split(body, count) else {
            continue;
        };
        let (Ok(port), Ok(position)) = (tail[0].parse::<u16>(), tail[1].parse::<u64>()) else {
            continue;
        };
        let token = tail.get(2).map(|token| (*token).to_owned());
        return Some((file, port, position, token));
    }
    None
}

/// Splits a body into its file name and exactly `tail` fields behind it.
fn split(body: &str, tail: usize) -> Option<(String, Vec<&str>)> {
    let body = body.trim();
    if let Some(quoted) = body.strip_prefix('"') {
        let (file, rest) = quoted.split_once('"')?;
        let fields: Vec<&str> = rest.split_whitespace().collect();
        return (fields.len() == tail && !file.is_empty()).then(|| (file.to_owned(), fields));
    }
    let fields: Vec<&str> = body.split_whitespace().collect();
    let at = fields.len().checked_sub(tail).filter(|at| *at > 0)?;
    Some((fields[..at].join(" "), fields[at..].to_vec()))
}

/// The address field, which is a packed integer far more often than it is an
/// address. IPv4 is the 32-bit form every client sends; the 128-bit form and
/// the literal are what the handful of clients that do IPv6 at all send.
fn address(field: &str) -> Option<IpAddr> {
    if let Ok(packed) = field.parse::<u32>() {
        return Some(IpAddr::V4(Ipv4Addr::from(packed)));
    }
    if let Ok(packed) = field.parse::<u128>() {
        return Some(IpAddr::V6(Ipv6Addr::from(packed)));
    }
    field.parse().ok()
}

/// How an address goes back out. IPv4 is packed because a client old enough to
/// need DCC is old enough to reject the dotted form.
fn on_the_wire(address: IpAddr) -> String {
    match address {
        IpAddr::V4(address) => u32::from(address).to_string(),
        IpAddr::V6(address) => address.to_string(),
    }
}

/// The argument of a `DCC SEND`, for [`crate::text::ctcp_wrap`].
pub fn send_body(file: &str, address: IpAddr, port: u16, size: u64, token: Option<&str>) -> String {
    let file = quoted(file);
    let address = on_the_wire(address);
    match token {
        Some(token) => format!("SEND {file} {address} {port} {size} {token}"),
        None => format!("SEND {file} {address} {port} {size}"),
    }
}

/// The argument of a `DCC REJECT`, which is how an offer is turned down.
pub fn reject_body(file: &str) -> String {
    format!("REJECT SEND {}", quoted(file))
}

/// The argument of a `DCC ACCEPT`, agreeing to a resume.
pub fn accept_body(file: &str, port: u16, position: u64, token: Option<&str>) -> String {
    let file = quoted(file);
    match token {
        Some(token) => format!("ACCEPT {file} {port} {position} {token}"),
        None => format!("ACCEPT {file} {port} {position}"),
    }
}

/// The argument of a `DCC RESUME`, which names the offer by its port — or by
/// its token where the offer was passive and there is no port to name it by.
pub fn resume_body(file: &str, port: u16, position: u64, token: Option<&str>) -> String {
    let file = quoted(file);
    match token {
        Some(token) => format!("RESUME {file} {port} {position} {token}"),
        None => format!("RESUME {file} {port} {position}"),
    }
}

/// The name as it goes on the wire: quoted where it has a space, and without
/// the two characters that would end the field early whatever the reader does
/// with quotes.
fn quoted(file: &str) -> String {
    let file: String = file
        .chars()
        .filter(|c| *c != '"' && !c.is_control())
        .collect();
    match file.contains(' ') {
        true => format!("\"{file}\""),
        false => file,
    }
}

/// What this client is willing to create on disk from a name somebody else
/// chose.
///
/// The name arrives from the network and is joined onto a directory the user
/// chose, so a separator or a `..` in it would let the sender pick the
/// directory as well as the file. Only the last component survives, which is
/// also the one the user would recognise: a file called `holiday.png` should
/// arrive under that name whatever path the sender had it under.
pub fn safe_file_name(file: &str) -> String {
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file);
    let safe: String = base
        .chars()
        .map(|c| match c {
            ':' | '\0' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    // A leading dot hides the file; a name that is only dots is `.` or `..`,
    // which name a directory rather than anything inside one.
    let safe = safe.trim_matches(['.', ' ']);
    let safe: String = safe.chars().take(120).collect();
    match safe.is_empty() {
        true => "received-file".to_owned(),
        false => safe,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(address: &str) -> IpAddr {
        address.parse().expect("a v4 address")
    }

    #[test]
    fn reads_an_offer() {
        assert_eq!(
            parse("SEND holiday.png 3232235777 6669 51200"),
            Some(Request::Send {
                file: "holiday.png".into(),
                address: v4("192.168.1.1"),
                port: 6669,
                size: 51200,
                token: None,
            })
        );
    }

    #[test]
    fn reads_a_quoted_name() {
        assert_eq!(
            parse("SEND \"my holiday.png\" 3232235777 6669 51200"),
            Some(Request::Send {
                file: "my holiday.png".into(),
                address: v4("192.168.1.1"),
                port: 6669,
                size: 51200,
                token: None,
            })
        );
    }

    /// The fields behind the name are what say where it ended, because this
    /// name was sent with no quotes to say so.
    #[test]
    fn reads_a_bare_name_with_spaces() {
        assert_eq!(
            parse("SEND my holiday.png 3232235777 6669 51200"),
            Some(Request::Send {
                file: "my holiday.png".into(),
                address: v4("192.168.1.1"),
                port: 6669,
                size: 51200,
                token: None,
            })
        );
    }

    /// A name whose last word is a number is why the long reading has to parse
    /// every field it claims rather than just the first: `2024` is a valid
    /// packed address, and only the port behind it says the reading is wrong.
    #[test]
    fn a_numeric_word_in_a_name_is_not_the_address() {
        assert_eq!(
            parse("SEND report 2024 3232235777 6669 51200"),
            Some(Request::Send {
                file: "report 2024".into(),
                address: v4("192.168.1.1"),
                port: 6669,
                size: 51200,
                token: None,
            })
        );
    }

    #[test]
    fn reads_a_passive_offer() {
        assert_eq!(
            parse("SEND holiday.png 3232235777 0 51200 4821"),
            Some(Request::Send {
                file: "holiday.png".into(),
                address: v4("192.168.1.1"),
                port: 0,
                size: 51200,
                token: Some("4821".into()),
            })
        );
    }

    #[test]
    fn a_passive_offer_with_no_token_cannot_be_answered() {
        assert_eq!(parse("SEND holiday.png 3232235777 0 51200"), None);
    }

    #[test]
    fn reads_an_ipv6_offer() {
        assert_eq!(
            parse("SEND holiday.png 2001:db8::1 6669 51200"),
            Some(Request::Send {
                file: "holiday.png".into(),
                address: "2001:db8::1".parse().expect("a v6 address"),
                port: 6669,
                size: 51200,
                token: None,
            })
        );
    }

    #[test]
    fn reads_a_resume_and_its_answer() {
        assert_eq!(
            parse("RESUME holiday.png 6669 2048"),
            Some(Request::Resume {
                file: "holiday.png".into(),
                port: 6669,
                position: 2048,
                token: None,
            })
        );
        assert_eq!(
            parse("ACCEPT holiday.png 0 2048 4821"),
            Some(Request::Accept {
                file: "holiday.png".into(),
                port: 0,
                position: 2048,
                token: Some("4821".into()),
            })
        );
    }

    #[test]
    fn reads_a_rejection() {
        assert_eq!(
            parse("REJECT SEND holiday.png"),
            Some(Request::Reject {
                file: "holiday.png".into()
            })
        );
        assert_eq!(
            parse("REJECT SEND \"my holiday.png\""),
            Some(Request::Reject {
                file: "my holiday.png".into()
            })
        );
        assert_eq!(parse("REJECT CHAT chat"), None);
    }

    #[test]
    fn a_verb_this_client_does_not_answer_is_not_a_request() {
        assert_eq!(parse("CHAT chat 3232235777 6669"), None);
        assert_eq!(parse("SEND holiday.png"), None);
        assert_eq!(parse("SEND"), None);
    }

    #[test]
    fn writes_what_it_reads() {
        let body = send_body("holiday.png", v4("192.168.1.1"), 6669, 51200, None);
        assert_eq!(body, "SEND holiday.png 3232235777 6669 51200");
        assert!(matches!(parse(&body), Some(Request::Send { .. })));

        let body = send_body("my holiday.png", v4("192.168.1.1"), 0, 51200, Some("4821"));
        assert_eq!(body, "SEND \"my holiday.png\" 3232235777 0 51200 4821");
        assert!(matches!(parse(&body), Some(Request::Send { .. })));

        let body = resume_body("holiday.png", 6669, 2048, None);
        assert_eq!(body, "RESUME holiday.png 6669 2048");
        assert!(matches!(parse(&body), Some(Request::Resume { .. })));

        let body = accept_body("holiday.png", 0, 2048, Some("4821"));
        assert_eq!(body, "ACCEPT holiday.png 0 2048 4821");
        assert!(matches!(parse(&body), Some(Request::Accept { .. })));

        let body = reject_body("my holiday.png");
        assert_eq!(body, "REJECT SEND \"my holiday.png\"");
        assert!(matches!(parse(&body), Some(Request::Reject { .. })));
    }

    /// A quote in the name would end the field early on the far side, and a
    /// control character would end the whole CTCP.
    #[test]
    fn a_name_cannot_break_the_frame_it_travels_in() {
        assert_eq!(
            send_body("ho\u{1}li\"day.png", v4("10.0.0.1"), 1, 2, None),
            "SEND holiday.png 167772161 1 2"
        );
    }

    #[test]
    fn a_sender_does_not_choose_the_directory() {
        assert_eq!(safe_file_name("../../.bashrc"), "bashrc");
        assert_eq!(safe_file_name("/etc/passwd"), "passwd");
        assert_eq!(safe_file_name("C:\\autoexec.bat"), "autoexec.bat");
        assert_eq!(safe_file_name(".."), "received-file");
        assert_eq!(safe_file_name(""), "received-file");
        assert_eq!(safe_file_name("holiday.png"), "holiday.png");
    }
}
