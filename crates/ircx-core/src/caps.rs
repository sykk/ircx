/// Everything ircx knows how to act on. Anything the server offers outside
/// this list is left alone, and anything here the server does not offer simply
/// stays off.
pub const SUPPORTED: &[&str] = &[
    "account-notify",
    "account-tag",
    "away-notify",
    "batch",
    "chghost",
    "draft/account-registration",
    "draft/chathistory",
    "draft/message-redaction",
    "draft/multiline",
    "draft/read-marker",
    "echo-message",
    "extended-monitor",
    "extended-join",
    "invite-notify",
    "labeled-response",
    "message-tags",
    "multi-prefix",
    "sasl",
    "server-time",
    "setname",
    "standard-replies",
    "userhost-in-names",
];

const REQ: &str = "CAP REQ :";

/// `CAP REQ` is a normal message and shares the 512-byte line limit, so a
/// server advertising a long list needs the request split across lines.
const REQ_BUDGET: usize = 512 - REQ.len() - 2;

#[derive(Debug, Default)]
pub struct Caps {
    available: Vec<(String, Option<String>)>,
    enabled: Vec<String>,
    /// `CAP REQ` lines still waiting for an ACK or NAK.
    outstanding: usize,
}

impl Caps {
    pub fn is_enabled(&self, name: &str) -> bool {
        self.enabled.iter().any(|cap| cap == name)
    }

    pub fn enabled(&self) -> Vec<String> {
        self.enabled.clone()
    }

    pub fn value(&self, name: &str) -> Option<&str> {
        self.available
            .iter()
            .find(|(cap, _)| cap == name)
            .and_then(|(_, value)| value.as_deref())
    }

    pub fn negotiating(&self) -> bool {
        self.outstanding > 0
    }

    pub fn forget_all(&mut self) {
        self.available.clear();
        self.enabled.clear();
        self.outstanding = 0;
    }

    pub fn record_available(&mut self, list: &str) {
        for entry in list.split_whitespace() {
            let (name, value) = match entry.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (entry, None),
            };
            match self.available.iter_mut().find(|(cap, _)| cap == name) {
                Some(slot) => slot.1 = value,
                None => self.available.push((name.to_string(), value)),
            }
        }
    }

    /// The `CAP REQ` lines to send for everything offered, supported and not
    /// already on. Empty when there is nothing to ask for.
    pub fn request_lines(&mut self) -> Vec<String> {
        let wanted: Vec<&str> = self
            .available
            .iter()
            .map(|(name, _)| name.as_str())
            .filter(|name| SUPPORTED.contains(name) && !self.is_enabled(name))
            .collect();

        let mut lines = Vec::new();
        let mut batch = String::new();
        for name in wanted {
            let extra = if batch.is_empty() { 0 } else { 1 };
            if batch.len() + extra + name.len() > REQ_BUDGET {
                lines.push(format!("{REQ}{batch}"));
                batch.clear();
            } else if extra == 1 {
                batch.push(' ');
            }
            batch.push_str(name);
        }
        if !batch.is_empty() {
            lines.push(format!("{REQ}{batch}"));
        }

        self.outstanding += lines.len();
        lines
    }

    /// A leading `-` in an ACK means the server turned the capability off.
    pub fn ack(&mut self, list: &str) {
        self.outstanding = self.outstanding.saturating_sub(1);
        for entry in list.split_whitespace() {
            let (entry, _) = entry.split_once('=').unwrap_or((entry, ""));
            match entry.strip_prefix('-') {
                Some(name) => self.enabled.retain(|cap| cap != name),
                None => {
                    if !self.is_enabled(entry) {
                        self.enabled.push(entry.to_string());
                    }
                }
            }
        }
    }

    pub fn nak(&mut self) {
        self.outstanding = self.outstanding.saturating_sub(1);
    }

    pub fn remove(&mut self, list: &str) -> Vec<String> {
        let mut removed = Vec::new();
        for name in list.split_whitespace() {
            self.available.retain(|(cap, _)| cap != name);
            if self.is_enabled(name) {
                self.enabled.retain(|cap| cap != name);
                removed.push(name.to_string());
            }
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_intersection_is_requested() {
        let mut caps = Caps::default();
        caps.record_available(
            "sasl=PLAIN multi-prefix vendor/private away-notify standard-replies",
        );

        assert_eq!(
            caps.request_lines(),
            vec!["CAP REQ :sasl multi-prefix away-notify standard-replies"]
        );
        assert_eq!(caps.value("sasl"), Some("PLAIN"));
        assert!(caps.negotiating());
    }

    #[test]
    fn extended_monitor_is_requested_when_offered() {
        let mut caps = Caps::default();
        caps.record_available("account-notify extended-monitor vendor/private");

        assert_eq!(
            caps.request_lines(),
            vec!["CAP REQ :account-notify extended-monitor"]
        );
    }

    #[test]
    fn an_ack_with_a_value_enables_the_capability_name() {
        let mut caps = Caps::default();
        caps.record_available("draft/multiline=max-bytes=4096,max-lines=100");
        caps.request_lines();

        caps.ack("draft/multiline=max-bytes=4096,max-lines=100");

        assert!(caps.is_enabled("draft/multiline"));
        assert_eq!(
            caps.value("draft/multiline"),
            Some("max-bytes=4096,max-lines=100")
        );
    }

    #[test]
    fn a_server_offering_nothing_asks_for_nothing() {
        let mut caps = Caps::default();
        caps.record_available("");
        assert!(caps.request_lines().is_empty());
        assert!(!caps.negotiating());
    }

    #[test]
    fn a_long_offer_splits_across_lines_that_fit() {
        let mut caps = Caps::default();
        for name in SUPPORTED {
            caps.record_available(&format!("{name}={}", "x".repeat(60)));
        }
        let lines = caps.request_lines();
        assert!(lines.iter().all(|line| line.len() + 2 <= 512));
        let requested: usize = lines
            .iter()
            .map(|line| line[REQ.len()..].split(' ').count())
            .sum();
        assert_eq!(requested, SUPPORTED.len());
    }

    #[test]
    fn a_nak_leaves_every_capability_off() {
        let mut caps = Caps::default();
        caps.record_available("multi-prefix");
        caps.request_lines();
        caps.nak();

        assert!(!caps.is_enabled("multi-prefix"));
        assert!(!caps.negotiating());
    }

    #[test]
    fn an_ack_can_turn_a_capability_back_off() {
        let mut caps = Caps::default();
        caps.record_available("echo-message multi-prefix");
        caps.request_lines();
        caps.ack("echo-message multi-prefix");
        caps.ack("-echo-message");

        assert_eq!(caps.enabled(), vec!["multi-prefix"]);
    }

    #[test]
    fn cap_del_reports_only_what_was_actually_on() {
        let mut caps = Caps::default();
        caps.record_available("away-notify chghost");
        caps.request_lines();
        caps.ack("away-notify");

        assert_eq!(caps.remove("away-notify chghost"), vec!["away-notify"]);
        // Both are gone from the offer, so there is nothing left to ask for.
        assert!(caps.request_lines().is_empty());
    }
}
