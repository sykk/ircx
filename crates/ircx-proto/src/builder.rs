use crate::message::{
    needs_trailing, Command, Message, ParseError, Prefix, CRLF_BYTES, MAX_MESSAGE_BYTES,
    MAX_TAG_BYTES,
};

#[derive(Debug, Clone)]
pub struct MessageBuilder {
    tags: Vec<(String, Option<String>)>,
    prefix: Option<Prefix>,
    command: Command,
    params: Vec<String>,
}

impl MessageBuilder {
    pub fn new(command: impl Into<Command>) -> Self {
        MessageBuilder {
            tags: Vec::new(),
            prefix: None,
            command: command.into(),
            params: Vec::new(),
        }
    }

    pub fn tag(mut self, key: impl Into<String>, value: Option<String>) -> Self {
        self.tags.push((key.into(), value));
        self
    }

    pub fn prefix(mut self, prefix: Prefix) -> Self {
        self.prefix = Some(prefix);
        self
    }

    pub fn param(mut self, param: impl Into<String>) -> Self {
        self.params.push(param.into());
        self
    }

    /// Fails when the message exceeds the wire limits or holds a parameter that
    /// cannot be serialised unambiguously.
    pub fn build(self) -> Result<Message, ParseError> {
        let last = self.params.len().saturating_sub(1);
        for (index, param) in self.params.iter().enumerate() {
            if param.contains(['\r', '\n', '\0']) {
                return Err(ParseError::InvalidParam {
                    index,
                    reason: "contains CR, LF or NUL",
                });
            }
            if index != last && needs_trailing(param) {
                return Err(ParseError::InvalidParam {
                    index,
                    reason: "only the last parameter may be empty, hold a space, or start with ':'",
                });
            }
        }

        let mut message = Message {
            tags: self.tags,
            prefix: self.prefix,
            command: self.command,
            params: self.params,
            raw: String::new(),
        };

        let mut line = String::new();
        message.write_tags(&mut line);
        let tags_len = line.len();
        if tags_len > MAX_TAG_BYTES {
            return Err(ParseError::TagsTooLong { len: tags_len });
        }

        message.write_body(&mut line);
        let body_len = line.len() - tags_len + CRLF_BYTES;
        if body_len > MAX_MESSAGE_BYTES {
            return Err(ParseError::MessageTooLong { len: body_len });
        }

        message.raw = line;
        Ok(message)
    }
}
