use thiserror::Error;

/// Prefix, command and parameters plus the terminating CRLF, which the parser
/// strips and `to_line` does not add.
pub const MAX_MESSAGE_BYTES: usize = 512;

/// Includes the leading `@` and the space separating the tags from the rest.
pub const MAX_TAG_BYTES: usize = 8191;

const MAX_PARAMS: usize = 15;
pub(crate) const CRLF_BYTES: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub tags: Vec<(String, Option<String>)>,
    pub prefix: Option<Prefix>,
    pub command: Command,
    pub params: Vec<String>,
    /// The line this message came from, minus the terminator. Not always what
    /// `to_line` produces: escapes and trailing markers are normalised.
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Prefix {
    Server(String),
    User {
        nick: String,
        user: Option<String>,
        host: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Named(String),
    Numeric(u16),
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ParseError {
    #[error("line has no content")]
    Empty,

    #[error("line has tags or a prefix but no command")]
    MissingCommand,

    #[error("line starts with '@' but carries no tag")]
    EmptyTags,

    #[error("line starts with ':' but the prefix is empty")]
    EmptyPrefix,

    #[error("tags are {len} bytes, the limit is {MAX_TAG_BYTES}")]
    TagsTooLong { len: usize },

    #[error("message is {len} bytes including CRLF, the limit is {MAX_MESSAGE_BYTES}")]
    MessageTooLong { len: usize },

    #[error("parameter {index} cannot be sent as written: {reason}")]
    InvalidParam { index: usize, reason: &'static str },
}

impl From<&str> for Command {
    fn from(token: &str) -> Self {
        if token.len() == 3 && token.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(code) = token.parse() {
                return Command::Numeric(code);
            }
        }
        Command::Named(token.to_string())
    }
}

impl Message {
    pub fn parse(line: &str) -> Result<Message, ParseError> {
        let raw = line.trim_end_matches(['\r', '\n']);
        let mut rest = raw.trim_start_matches(' ');
        if rest.is_empty() {
            return Err(ParseError::Empty);
        }

        // An empty tag or prefix section is rejected rather than dropped: the
        // message left over would serialise into a line that reads differently.
        let mut tags = Vec::new();
        if let Some(after_marker) = rest.strip_prefix('@') {
            let (section, tail) = split_token(after_marker);
            tags = parse_tags(section);
            if tags.is_empty() {
                return Err(ParseError::EmptyTags);
            }
            rest = tail;
        }

        let mut prefix = None;
        if let Some(after_marker) = rest.strip_prefix(':') {
            let (section, tail) = split_token(after_marker);
            if section.is_empty() {
                return Err(ParseError::EmptyPrefix);
            }
            prefix = Some(parse_prefix(section));
            rest = tail;
        }

        let (command, rest) = split_token(rest);
        if command.is_empty() {
            return Err(ParseError::MissingCommand);
        }

        Ok(Message {
            tags,
            prefix,
            command: Command::from(command),
            params: parse_params(rest),
            raw: raw.to_string(),
        })
    }

    /// A tag sent without a value yields `Some("")`: IRCv3 treats a missing
    /// value and an empty one as the same thing.
    pub fn tag(&self, key: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, value)| value.as_deref().unwrap_or(""))
    }

    pub fn param(&self, index: usize) -> Option<&str> {
        self.params.get(index).map(String::as_str)
    }

    pub fn to_line(&self) -> String {
        let mut line = String::with_capacity(self.raw.len());
        self.write_tags(&mut line);
        self.write_body(&mut line);
        line
    }

    pub(crate) fn write_tags(&self, out: &mut String) {
        if self.tags.is_empty() {
            return;
        }
        out.push('@');
        for (index, (key, value)) in self.tags.iter().enumerate() {
            if index > 0 {
                out.push(';');
            }
            out.push_str(key);
            if let Some(value) = value {
                out.push('=');
                escape_tag_value(value, out);
            }
        }
        out.push(' ');
    }

    pub(crate) fn write_body(&self, out: &mut String) {
        match &self.prefix {
            Some(Prefix::Server(name)) => {
                out.push(':');
                out.push_str(name);
                out.push(' ');
            }
            Some(Prefix::User { nick, user, host }) => {
                out.push(':');
                out.push_str(nick);
                if let Some(user) = user {
                    out.push('!');
                    out.push_str(user);
                }
                if let Some(host) = host {
                    out.push('@');
                    out.push_str(host);
                }
                out.push(' ');
            }
            None => {}
        }

        match &self.command {
            Command::Named(name) => out.push_str(name),
            Command::Numeric(code) => out.push_str(&format!("{code:03}")),
        }

        let last = self.params.len().saturating_sub(1);
        for (index, param) in self.params.iter().enumerate() {
            out.push(' ');
            if index == last && needs_trailing(param) {
                out.push(':');
            }
            out.push_str(param);
        }
    }
}

pub(crate) fn needs_trailing(param: &str) -> bool {
    param.is_empty() || param.starts_with(':') || param.contains(' ')
}

fn split_token(text: &str) -> (&str, &str) {
    match text.find(' ') {
        Some(end) => (&text[..end], text[end..].trim_start_matches(' ')),
        None => (text, ""),
    }
}

fn parse_tags(section: &str) -> Vec<(String, Option<String>)> {
    section
        .split(';')
        .filter(|item| !item.is_empty())
        .map(|item| match item.split_once('=') {
            Some((key, value)) => (key.to_string(), Some(unescape_tag_value(value))),
            None => (item.to_string(), None),
        })
        .collect()
}

fn parse_prefix(source: &str) -> Prefix {
    let (nick_user, host) = match source.split_once('@') {
        Some((left, right)) => (left, Some(right.to_string())),
        None => (source, None),
    };
    let (nick, user) = match nick_user.split_once('!') {
        Some((nick, user)) => (nick, Some(user.to_string())),
        None => (nick_user, None),
    };

    // A prefix with neither a user nor a host is a server name only when it
    // looks like a hostname; servers send bare nicks for their own users.
    if user.is_none() && host.is_none() && source.contains('.') {
        Prefix::Server(source.to_string())
    } else {
        Prefix::User {
            nick: nick.to_string(),
            user,
            host,
        }
    }
}

fn parse_params(mut rest: &str) -> Vec<String> {
    let mut params = Vec::new();
    while !rest.is_empty() {
        // The fifteenth parameter swallows the remainder whether or not it is
        // marked as trailing.
        if params.len() + 1 == MAX_PARAMS {
            params.push(rest.strip_prefix(':').unwrap_or(rest).to_string());
            break;
        }
        if let Some(trailing) = rest.strip_prefix(':') {
            params.push(trailing.to_string());
            break;
        }
        let (param, tail) = split_token(rest);
        params.push(param.to_string());
        rest = tail;
    }
    params
}

fn unescape_tag_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('\\') => out.push('\\'),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

fn escape_tag_value(value: &str, out: &mut String) {
    for c in value.chars() {
        match c {
            ';' => out.push_str("\\:"),
            ' ' => out.push_str("\\s"),
            '\\' => out.push_str("\\\\"),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            _ => out.push(c),
        }
    }
}
