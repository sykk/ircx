use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ircx_ipc::SaslMechanism;

const CHUNK: usize = 400;

pub fn mechanism_token(mechanism: SaslMechanism) -> &'static str {
    match mechanism {
        SaslMechanism::Plain => "PLAIN",
        SaslMechanism::External => "EXTERNAL",
    }
}

/// `authzid \0 authcid \0 password`, empty authzid so the server uses the
/// account we authenticate as.
pub fn plain_payload(account: &str, password: &str) -> String {
    STANDARD.encode(format!("\0{account}\0{password}"))
}

/// Splits an encoded payload into `AUTHENTICATE` arguments.
///
/// A chunk shorter than 400 bytes is what tells the server the payload ended,
/// so a payload that is an exact multiple of 400 — or empty, as EXTERNAL is —
/// needs a trailing `+` or the exchange hangs waiting for a chunk that is
/// never coming.
pub fn chunks(payload: &str) -> Vec<String> {
    let mut lines: Vec<String> = payload
        .as_bytes()
        .chunks(CHUNK)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect();
    if payload.len().is_multiple_of(CHUNK) {
        lines.push("+".into());
    }
    lines
}

/// A server that advertised `sasl=` names the mechanisms it will take. An
/// empty value means it did not say, so anything is worth trying.
pub fn offers(advertised: Option<&str>, mechanism: SaslMechanism) -> bool {
    match advertised.filter(|list| !list.is_empty()) {
        Some(list) => list
            .split(',')
            .any(|entry| entry.eq_ignore_ascii_case(mechanism_token(mechanism))),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_carries_an_empty_authzid() {
        assert_eq!(
            STANDARD.decode(plain_payload("sykk", "hunter2")).unwrap(),
            b"\0sykk\0hunter2"
        );
    }

    #[test]
    fn a_short_payload_is_one_chunk() {
        assert_eq!(chunks("abcd"), vec!["abcd"]);
    }

    #[test]
    fn an_exact_multiple_of_the_chunk_gets_an_empty_terminator() {
        let payload = "a".repeat(CHUNK);
        assert_eq!(chunks(&payload), vec![payload, "+".into()]);
    }

    #[test]
    fn a_long_payload_splits_and_the_last_chunk_stays_short() {
        let chunks = chunks(&"a".repeat(CHUNK + 1));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), CHUNK);
        assert_eq!(chunks[1].len(), 1);
    }

    #[test]
    fn an_empty_payload_is_the_plus() {
        assert_eq!(chunks(""), vec!["+"]);
    }

    #[test]
    fn an_advertised_list_is_honoured() {
        assert!(offers(Some("PLAIN,EXTERNAL"), SaslMechanism::External));
        assert!(!offers(Some("EXTERNAL"), SaslMechanism::Plain));
        assert!(offers(None, SaslMechanism::Plain));
        assert!(offers(Some(""), SaslMechanism::Plain));
    }
}
