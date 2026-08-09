//! Command parameters and return types.
//!
//! The `#[tauri::command]` handlers themselves live in `src-tauri`. Their
//! signatures, which the frontend binds against:
//!
//! ```text
//! get_snapshot()                              -> AppSnapshot
//! list_network_configs()                      -> Vec<NetworkConfig>
//! save_network(config: NetworkConfig)         -> NetworkId
//! remove_network(network: NetworkId)          -> ()
//! connect_network(network: NetworkId)         -> ()
//! disconnect_network(network, quit_message)   -> ()
//! join_channel(network, channel, key)         -> ()
//! open_query(network, nick)                   -> Query
//! close_target(network, target)               -> ()
//! submit_input(network, target, input, reply_to) -> CommandOutcome
//! list_members(network, channel)              -> Vec<Member>
//! load_history(req: HistoryRequest)           -> Vec<ChatMessage>
//! search_history(req: SearchRequest)          -> Vec<SearchHit>
//! mark_read(network, target)                  -> ()
//! set_typing(network, target, active)         -> ()
//! load_preview(url)                           -> Attachment
//! get_draft(network, target)                  -> Option<String>
//! set_draft(network, target, text)            -> ()
//! list_themes()                               -> Vec<ThemeSource>
//! list_plugins()                              -> Vec<InstalledPlugin>
//! plugin_permissions()                        -> Vec<PluginPermissionInfo>
//! install_plugin(source: String)              -> InstalledPlugin
//! set_plugin_grants(plugin, grants)           -> InstalledPlugin
//! remove_plugin(plugin: String)               -> ()
//! archive_summary(network, target)            -> ArchiveSummary
//! set_retention(network, target, days)        -> ()
//! highlight_words()                           -> Vec<String>
//! set_highlight_words(words: Vec<String>)     -> ()
//! muted_conversations()                       -> Vec<MutedConversation>
//! set_muted(network, target, muted)           -> ()
//! export_archive(scope, path)                 -> u64
//! delete_archive(scope)                       -> ()
//! ```
//!
//! Every handler returns `Result<T, String>`; the error string is user-facing.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{Channel, ChatMessage, Network, Query};
use crate::{NetworkId, TargetName};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    /// Absent when creating; set when updating an existing network.
    pub id: Option<NetworkId>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub tls: bool,
    /// Skipping verification is a per-network opt-in for self-signed servers.
    pub tls_verify: bool,
    /// A PEM file holding the certificate to present and the key that signs for
    /// it, which is what SASL EXTERNAL authenticates with. A path rather than
    /// the material: the file is the one thing the user already has, and a copy
    /// in the keyring would be a second secret to keep in step with the first.
    pub client_certificate: Option<String>,
    pub nick: String,
    pub alt_nicks: Vec<String>,
    pub username: String,
    pub realname: String,
    pub sasl: Option<SaslConfig>,
    /// Sent verbatim after registration, one command per entry, no leading slash.
    pub connect_commands: Vec<String>,
    pub autojoin: Vec<String>,
    pub auto_connect: bool,
}

/// The password lives in the OS keyring, keyed by network id; it never crosses
/// this boundary on read.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SaslConfig {
    pub mechanism: SaslMechanism,
    pub account: String,
    /// Write-only: `Some` when the user sets it, always `None` when read back.
    pub password: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "SCREAMING-KEBAB-CASE")]
pub enum SaslMechanism {
    Plain,
    External,
    /// The password is never sent: each side proves it knows it, over four
    /// messages rather than one. `crates/ircx-core/src/scram.rs`.
    ///
    /// Named rather than derived: the case convention would spell it
    /// `SCRAM-SHA512`, and the mechanism's name — the one on the wire and in
    /// the server's advertised list — has the second hyphen.
    #[serde(rename = "SCRAM-SHA-256")]
    ScramSha256,
    #[serde(rename = "SCRAM-SHA-512")]
    ScramSha512,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRequest {
    pub network: NetworkId,
    pub target: TargetName,
    /// RFC 3339. Pages backwards from the oldest message already shown.
    pub before: Option<String>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    /// What the user typed, taken literally. Words are ANDed; punctuation and
    /// FTS5 operators are searched for rather than obeyed.
    pub query: String,
    pub network: Option<NetworkId>,
    pub target: Option<TargetName>,
    pub limit: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub message: ChatMessage,
    /// FTS5 snippet with `<mark>` around matches.
    pub snippet: String,
}

/// Result of dispatching composer input.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", tag = "kind", content = "value")]
pub enum CommandOutcome {
    /// Plain text, sent as PRIVMSG. Carries the optimistic local copy. Boxed so
    /// the enum is not the size of its largest variant; serialises unchanged.
    Sent(Box<ChatMessage>),
    /// A slash command ran. Anything it had to show the user was appended to
    /// the target it was run in, so there is nothing to return.
    Handled,
    /// Unknown command or bad arguments, phrased for the user.
    Rejected(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub networks: Vec<Network>,
    pub channels: Vec<Channel>,
    pub queries: Vec<Query>,
}

/// A file the user has offered to upload, as the confirmation needs it.
///
/// `too_large` is decided here rather than by comparing sizes in the window: the
/// cap is enforced in one place, and a second copy of the number would be a
/// second thing to keep in step with it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FileToUpload {
    pub path: String,
    pub name: String,
    /// For display only, and saturating: a `u64` crosses the boundary as a
    /// `bigint` the window never receives, because Tauri sends a JSON number.
    /// The decision below is made from the true size, so a file large enough
    /// to saturate this is refused on the real one and its number is never
    /// shown.
    pub bytes: u32,
    pub too_large: bool,
    /// Why it cannot be read, when it cannot. A file that vanished between the
    /// drop and the confirmation is the ordinary case.
    pub unreadable: Option<String>,
}

/// Where an attachment is uploaded before its link is sent.
///
/// `None` from `get_upload_provider` is "no provider", which the spec names as
/// a configuration rather than a failure: the user sends links they made
/// elsewhere.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UploadProvider {
    /// Where the file goes. `{name}` is replaced with a generated object name,
    /// which is what storage addressed by path needs; an endpoint without it is
    /// used as it stands, which is what a host that names the object itself
    /// wants.
    pub endpoint: String,
    pub method: UploadMethod,
    /// The header the token is sent in, `Authorization` for most. `None` when
    /// the provider needs no credential — a self-hosted box behind a VPN.
    pub auth_header: Option<String>,
    /// Write-only, as the SASL password is: `Some` when the user sets it,
    /// always `None` when read back. Carries the secret access key when `s3`
    /// is set — it is the provider's one secret either way.
    pub token: Option<String>,
    /// Whether one is saved, which is the only thing about `token` that can be
    /// read back. Answered on the way out and ignored on the way in, so the
    /// sheet can say "saved" when something is rather than guessing it from
    /// the provider existing.
    #[serde(default)]
    #[ts(as = "Option<bool>", optional)]
    pub token_saved: bool,
    /// Set for S3-compatible storage, which signs the request rather than
    /// carrying a token in a header. `None` is a provider that takes a plain
    /// `PUT` or `POST`, which is self-hosted storage and most temporary hosts.
    pub s3: Option<S3Credentials>,
    /// Set for a host that takes the file as a form upload rather than as the
    /// request body. It settles the shape of the request the way `s3` does, so
    /// a provider carrying one is a `POST` whatever `method` says.
    pub form: Option<FormUpload>,
}

/// A file sent as `multipart/form-data`, which is what the hosts that ask for
/// no account take.
///
/// The alternative — the file as the whole request body — is what storage and
/// self-hosted boxes take, and between them they cover what is worth
/// configuring. A host wanting the bytes inside a JSON document would be a
/// third shape and is not one of them.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct FormUpload {
    /// The field the file goes in: `fileToUpload` for catbox and litterbox,
    /// `file` for the 0x0.st family.
    pub file_field: String,
    /// Everything else the host wants told, in the order it was given. catbox
    /// needs `reqtype=fileupload`, and litterbox takes a `time` beside it.
    pub fields: Vec<(String, String)>,
}

/// What an upload produced: the address, and whether anybody else can open it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct UploadedFile {
    pub link: String,
    /// Why the address will not open for the people it is about to be sent to,
    /// or `None` when it will.
    ///
    /// A stored object is not a readable one. An S3 bucket is private until
    /// somebody makes it otherwise, so an upload can succeed and hand back an
    /// address that opens for nobody — found by walking it against MinIO. This
    /// is the difference between the sender learning that now and learning it
    /// from whoever they sent it to.
    pub unreadable: Option<String>,
}

/// What signing an S3 request needs beyond the endpoint and the secret.
///
/// The secret access key is not here. It goes to the keyring with the other
/// credential, for the reason the token does: a value that only travels one way
/// cannot be leaked by a screen that shows what is stored.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct S3Credentials {
    /// Part of the signature, so a provider that ignores regions still needs
    /// one that matches what it expects. `us-east-1` is the usual answer.
    pub region: String,
    pub access_key_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "UPPERCASE")]
pub enum UploadMethod {
    Put,
    Post,
}

/// The permissions a plugin can ask for. Spelled as the manifest spells
/// them, so a name here and a name in a `plugin.json` are the same string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "kebab-case")]
pub enum PluginPermission {
    ReadMessages,
    SendMessages,
    AddCommands,
    StoreLocalData,
    AccessChannels,
    NetworkRequests,
    RenderContent,
    AnnotateMessages,
    RaiseNotifications,
}

/// A permission and the plain terms the install dialogue shows for it. Sent
/// from the backend rather than written into the frontend, so the wording has
/// one home: `Permission::summary` in `ircx-plugin`.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PluginPermissionInfo {
    pub permission: PluginPermission,
    pub summary: String,
}

/// A permission set. The same shape is both what a plugin asks for and what the
/// user allowed, so the dialogue can show one against the other.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PluginGrants {
    pub permissions: Vec<PluginPermission>,
    /// Conversations `read-messages` and `send-messages` reach. `*` is all of
    /// them and is a choice the user makes explicitly.
    pub channels: Vec<String>,
    /// Hosts `network-requests` may reach. Matched exactly; no wildcard.
    pub hosts: Vec<String>,
}

/// A slash command a plugin adds, as declared in its manifest.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommand {
    pub name: String,
    pub summary: String,
}

/// An installed plugin: what it declared about itself, and what the user
/// allowed it. Nothing here says whether it is running — a plugin's thread
/// starts on its first call and that is not the user's concern.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub commands: Vec<PluginCommand>,
    /// What the manifest asks for. Nothing outside this can be granted.
    pub requests: PluginGrants,
    /// What the user allowed, which may be less. Empty until they say
    /// otherwise: installing a plugin grants it nothing.
    pub grants: PluginGrants,
}

/// One theme directory, read but not understood: the backend does not parse
/// any of its files. Validation is the frontend's, because it is the frontend
/// that knows which custom properties the UI reads and what ui.css may contain.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSource {
    /// The directory name.
    pub id: String,
    /// Contents of `theme.json`.
    pub manifest: String,
    /// Contents of `theme.css`.
    pub stylesheet: String,
    /// Contents of `ui.css`, when present. Optional rules, animations and
    /// layout tweaks scoped with `[data-theme]` and `[data-ui]`.
    #[serde(default)]
    pub ui_stylesheet: String,
}

/// What one conversation is worth, and what the whole archive weighs.
///
/// The counts are what makes a retention setting believable: a window nobody
/// can see the effect of is a window nobody will trust.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSummary {
    /// Every message this client has kept, across every network.
    pub messages: u64,
    /// What the database costs on disk, indexes and search included.
    pub bytes: u64,
    /// How long this network keeps messages, in days. `None` is forever.
    pub network_days: Option<u32>,
    /// The same for the conversation asked about, when one was. `None` is
    /// "whatever the network says" rather than "forever" — the override is
    /// absent, not set to keep.
    pub target_days: Option<u32>,
    /// Whether that override exists at all, which `target_days` cannot say.
    pub target_override: bool,
    /// How many messages the window took when the app last started. Said here
    /// because pruning happens before any network exists and so has no console
    /// to say it in, and this is the screen somebody who set a window comes
    /// back to.
    pub removed_on_launch: u64,
}

/// What an export or a delete applies to.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ArchiveScope {
    /// One conversation, named the way everything else names one.
    Conversation {
        network: NetworkId,
        target: TargetName,
    },
    /// Every message this client has kept. Networks and credentials stay:
    /// clearing what was said is not asking to be logged out.
    Everything,
}
