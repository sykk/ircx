use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

pub(crate) fn parse(parameter: &str) -> Option<OffsetDateTime> {
    timestamp(parameter.strip_prefix("timestamp=")?)
}

pub(crate) fn timestamp(value: &str) -> Option<OffsetDateTime> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
        || bytes.iter().enumerate().any(|(at, byte)| {
            !matches!(at, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit()
        })
    {
        return None;
    }
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

pub(crate) fn parameter(value: &str) -> Option<String> {
    timestamp(value)?;
    Some(format!("timestamp={value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_server_time_selector() {
        assert!(parse("timestamp=2026-08-15T12:34:56.789Z").is_some());
    }

    #[test]
    fn rejects_unknown_and_invalid_selectors() {
        assert!(parse("*").is_none());
        assert!(parse("msgid=abc").is_none());
        assert!(parse("timestamp=not-a-time").is_none());
        assert!(parse("timestamp=2026-08-15T12:34:56Z").is_none());
        assert!(parse("timestamp=2026-08-15T12:34:56.789+00:00").is_none());
    }

    #[test]
    fn builds_only_from_a_server_timestamp() {
        assert_eq!(
            parameter("2026-08-15T12:34:56.789Z").as_deref(),
            Some("timestamp=2026-08-15T12:34:56.789Z")
        );
        assert_eq!(parameter("local"), None);
    }
}
