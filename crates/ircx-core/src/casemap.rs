/// How the server compares nicks and channel names.
///
/// `Rfc1459` is the default because a server that sends no `CASEMAPPING` is an
/// RFC 1459 server. It treats `[]\~` as the uppercase forms of `{}|^` — a nick
/// folded as ASCII would miss `sable[m]` matching `sable{m}` and every lookup
/// for that member would fail.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CaseMapping {
    Ascii,
    #[default]
    Rfc1459,
    /// RFC 1459 without `~`/`^`, which the errata removed.
    Rfc1459Strict,
}

impl CaseMapping {
    pub fn from_token(token: &str) -> Option<CaseMapping> {
        match token.to_ascii_lowercase().as_str() {
            "ascii" => Some(CaseMapping::Ascii),
            "rfc1459" => Some(CaseMapping::Rfc1459),
            "rfc1459-strict" => Some(CaseMapping::Rfc1459Strict),
            _ => None,
        }
    }

    pub fn fold(self, text: &str) -> String {
        text.chars().map(|c| self.fold_char(c)).collect()
    }

    pub fn equal(self, left: &str, right: &str) -> bool {
        left.chars()
            .map(|c| self.fold_char(c))
            .eq(right.chars().map(|c| self.fold_char(c)))
    }

    fn fold_char(self, c: char) -> char {
        match (self, c) {
            (CaseMapping::Rfc1459, '~') => '^',
            (CaseMapping::Rfc1459 | CaseMapping::Rfc1459Strict, '[') => '{',
            (CaseMapping::Rfc1459 | CaseMapping::Rfc1459Strict, ']') => '}',
            (CaseMapping::Rfc1459 | CaseMapping::Rfc1459Strict, '\\') => '|',
            _ => c.to_ascii_lowercase(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc1459_folds_the_bracket_family() {
        assert_eq!(CaseMapping::Rfc1459.fold("Sable[m]\\~"), "sable{m}|^");
        assert!(CaseMapping::Rfc1459.equal("nick[]\\~", "NICK{}|^"));
    }

    #[test]
    fn strict_leaves_the_tilde_alone() {
        assert_eq!(CaseMapping::Rfc1459Strict.fold("A[]\\~"), "a{}|~");
        assert!(!CaseMapping::Rfc1459Strict.equal("a~", "a^"));
    }

    #[test]
    fn ascii_leaves_every_punctuation_mark_alone() {
        assert_eq!(CaseMapping::Ascii.fold("Sable[m]"), "sable[m]");
        assert!(!CaseMapping::Ascii.equal("sable[m]", "sable{m}"));
    }

    #[test]
    fn folding_does_not_touch_non_ascii() {
        assert_eq!(CaseMapping::Rfc1459.fold("Ünicode"), "Ünicode");
    }

    #[test]
    fn an_unknown_token_is_not_guessed_at() {
        assert_eq!(CaseMapping::from_token("ASCII"), Some(CaseMapping::Ascii));
        assert_eq!(CaseMapping::from_token("utf8-only"), None);
    }
}
