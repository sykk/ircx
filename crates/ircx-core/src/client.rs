/// What CTCP VERSION answers with. The semver is the crate version; the suffix
/// is whatever commit the binary was built from.
pub fn version_reply() -> String {
    format!(
        "ircx {}+{} - https://github.com/sykk/ircx",
        env!("CARGO_PKG_VERSION"),
        env!("IRCX_GIT_SHA"),
    )
}

/// A CTCP VERSION body, already wrapped in SOH bytes.
pub fn ctcp_version_body() -> String {
    crate::text::ctcp_wrap("VERSION", &version_reply())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_reply_names_the_client_and_build() {
        let reply = version_reply();
        assert!(reply.starts_with("ircx "));
        assert!(reply.contains(env!("CARGO_PKG_VERSION")));
        assert!(reply.contains('+'));
    }

    #[test]
    fn the_ctcp_body_is_wrapped() {
        let body = ctcp_version_body();
        assert!(body.starts_with('\u{1}'));
        assert!(body.ends_with('\u{1}'));
        assert!(body.contains("VERSION"));
    }
}
