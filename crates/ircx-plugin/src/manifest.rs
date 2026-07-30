//! What a plugin declares about itself, and what the user granted it.
//!
//! A manifest is written by the plugin author and says what the plugin wants.
//! [`Grants`] in the same shape says what the user allowed, and only the second
//! one is ever enforced. Nothing may be granted that was not asked for, so the
//! install dialogue and the enforcement points read from the same list.

use std::collections::BTreeSet;
use std::fmt;

use serde::{Deserialize, Serialize};

/// Longest a plugin id, command name or channel may be. Ids and commands
/// become a directory name and a `/word`, so both stay short.
const MAX_NAME: usize = 48;

/// The seven permissions `ircclient.md` names, one variant each.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    ReadMessages,
    SendMessages,
    AddCommands,
    StoreLocalData,
    AccessChannels,
    NetworkRequests,
    RenderContent,
}

impl Permission {
    pub const ALL: [Self; 7] = [
        Self::ReadMessages,
        Self::SendMessages,
        Self::AddCommands,
        Self::StoreLocalData,
        Self::AccessChannels,
        Self::NetworkRequests,
        Self::RenderContent,
    ];

    /// The name in a manifest.
    pub fn name(self) -> &'static str {
        match self {
            Self::ReadMessages => "read-messages",
            Self::SendMessages => "send-messages",
            Self::AddCommands => "add-commands",
            Self::StoreLocalData => "store-local-data",
            Self::AccessChannels => "access-channels",
            Self::NetworkRequests => "network-requests",
            Self::RenderContent => "render-content",
        }
    }

    /// What it lets the plugin do, for the install dialogue. Written for
    /// someone who has never heard the word capability.
    pub fn summary(self) -> &'static str {
        match self {
            Self::ReadMessages => "Read the recent messages in the conversation it is used in",
            Self::SendMessages => "Send messages as you",
            Self::AddCommands => "Add slash commands you can type",
            Self::StoreLocalData => "Keep its own settings and data on this computer",
            Self::AccessChannels => "Work in the channels you choose, and no others",
            Self::NetworkRequests => "Fetch data from the websites it names",
            Self::RenderContent => "Show text in your conversations",
        }
    }
}

impl fmt::Display for Permission {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// A permission set with the two scopes that need more than a yes.
///
/// The same type is both the request in a manifest and the grant the user
/// gave, so [`Grants::within`] can check one against the other.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grants {
    #[serde(default)]
    pub permissions: BTreeSet<Permission>,
    /// Which conversations `read-messages` and `send-messages` reach. `*` is
    /// every one of them, and is a choice the user has to make explicitly.
    #[serde(default)]
    pub channels: Vec<String>,
    /// Hosts `network-requests` may reach. Matched exactly; no wildcard.
    #[serde(default)]
    pub hosts: Vec<String>,
}

impl Grants {
    /// The set a plugin that only adds a command and prints an answer needs.
    pub fn command_only() -> Self {
        Self {
            permissions: [Permission::AddCommands, Permission::RenderContent]
                .into_iter()
                .collect(),
            ..Self::default()
        }
    }

    pub fn holds(&self, permission: Permission) -> bool {
        self.permissions.contains(&permission)
    }

    /// Whether the plugin may read or write in `target`. Channel access is a
    /// permission of its own, so a plugin granted `send-messages` and no
    /// channels can send nowhere.
    pub fn reaches(&self, target: &str) -> bool {
        self.holds(Permission::AccessChannels)
            && self
                .channels
                .iter()
                .any(|allowed| allowed == "*" || allowed.eq_ignore_ascii_case(target))
    }

    pub fn reaches_host(&self, host: &str) -> bool {
        self.holds(Permission::NetworkRequests)
            && self
                .hosts
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(host))
    }

    /// Refuses a grant of anything the plugin did not ask for. The user can
    /// always give less: fewer permissions, fewer channels, fewer hosts.
    pub fn within(&self, requested: &Self) -> Result<(), ManifestError> {
        if let Some(extra) = self.permissions.difference(&requested.permissions).next() {
            return Err(ManifestError::NotRequested(extra.to_string()));
        }
        let wildcard = requested.channels.iter().any(|channel| channel == "*");
        for channel in &self.channels {
            let asked = wildcard
                || requested
                    .channels
                    .iter()
                    .any(|allowed| allowed.eq_ignore_ascii_case(channel));
            if !asked {
                return Err(ManifestError::NotRequested(channel.clone()));
            }
        }
        for host in &self.hosts {
            if !requested
                .hosts
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(host))
            {
                return Err(ManifestError::NotRequested(host.clone()));
            }
        }
        Ok(())
    }
}

/// A slash command the plugin adds. Declared here rather than discovered at
/// load, so typing `/thing` can find the plugin that owns it without starting
/// a runtime first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandSpec {
    pub name: String,
    #[serde(default)]
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// The JavaScript file, relative to the plugin's own directory.
    pub entry: String,
    #[serde(default)]
    pub commands: Vec<CommandSpec>,
    /// What the plugin asks for. What it gets is the `Grants` beside it in the
    /// library, which the user wrote.
    #[serde(flatten)]
    pub requests: Grants,
}

impl Manifest {
    /// Parses and checks a `plugin.json`. Everything a plugin says about
    /// itself is hostile input: the id becomes a directory name and the entry
    /// becomes a path, so both are checked before either is used.
    pub fn parse(source: &[u8]) -> Result<Self, ManifestError> {
        let manifest: Self = serde_json::from_slice(source).map_err(ManifestError::Malformed)?;
        manifest.check()?;
        Ok(manifest)
    }

    fn check(&self) -> Result<(), ManifestError> {
        check_name("id", &self.id)?;
        if self.name.trim().is_empty() {
            return Err(ManifestError::Missing("name"));
        }
        if self.version.trim().is_empty() {
            return Err(ManifestError::Missing("version"));
        }
        check_entry(&self.entry)?;

        for command in &self.commands {
            check_name("command", &command.name)?;
        }
        if !self.commands.is_empty() && !self.requests.holds(Permission::AddCommands) {
            return Err(ManifestError::Undeclared(
                "declares commands without asking for add-commands",
            ));
        }
        if self.requests.holds(Permission::AccessChannels) && self.requests.channels.is_empty() {
            return Err(ManifestError::Undeclared(
                "asks for access-channels without naming a channel",
            ));
        }
        // Reading and sending are both scoped by `reaches`, so either one
        // without `access-channels` reaches nothing at all. Refused here rather
        // than granted and inert, because the install dialogue would otherwise
        // offer the user a permission that cannot do anything once allowed.
        let scoped_to_channels = self.requests.holds(Permission::SendMessages)
            || self.requests.holds(Permission::ReadMessages);
        if scoped_to_channels && !self.requests.holds(Permission::AccessChannels) {
            return Err(ManifestError::Undeclared(
                "asks to send or read messages without asking for access-channels, which is what says where",
            ));
        }
        if self.requests.holds(Permission::NetworkRequests) && self.requests.hosts.is_empty() {
            return Err(ManifestError::Undeclared(
                "asks for network-requests without naming a host",
            ));
        }
        for channel in &self.requests.channels {
            if channel != "*" && channel.len() > MAX_NAME {
                return Err(ManifestError::Undeclared(
                    "names a channel that is too long",
                ));
            }
        }
        Ok(())
    }
}

fn check_name(what: &'static str, value: &str) -> Result<(), ManifestError> {
    let shaped = !value.is_empty()
        && value.len() <= MAX_NAME
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !value.starts_with('-');
    match shaped {
        true => Ok(()),
        false => Err(ManifestError::Shape(what)),
    }
}

/// The entry has to name a file inside the plugin's own directory. A path with
/// a separator or a `..` in it is an attempt to read something else.
fn check_entry(entry: &str) -> Result<(), ManifestError> {
    let shaped = entry.ends_with(".js")
        && entry.len() <= MAX_NAME
        && !entry.contains(['/', '\\'])
        && entry != ".."
        && !entry.starts_with('.');
    match shaped {
        true => Ok(()),
        false => Err(ManifestError::Shape("entry")),
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("its plugin.json could not be read: {0}")]
    Malformed(#[source] serde_json::Error),
    #[error("its plugin.json has no {0}")]
    Missing(&'static str),
    #[error("its {0} is not a name a plugin may use")]
    Shape(&'static str),
    #[error("it {0}")]
    Undeclared(&'static str),
    #[error("it never asked for {0}, so it cannot be granted")]
    NotRequested(String),
}
