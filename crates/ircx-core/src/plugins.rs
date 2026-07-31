//! Slash commands that belong to a plugin.
//!
//! The session never holds a plugin runtime and never calls into JavaScript.
//! It hands a request over, gets a reply back, and applies it — everything the
//! plugin is allowed to do to the session is in [`SessionState::apply_plugin`],
//! which is a short function on purpose.
//!
//! Custom slash commands are the one extension point built. Message renderers,
//! link and attachment providers, notification rules and protocol adapters are
//! the same shape and are follow-up work.
//!
//! What the install dialogue shows is also converted here. `ircx-plugin` knows
//! nothing about the window and `ircx-ipc` is below both of them, so this crate
//! is the only place the manifest's types and the window's types may meet.

use std::sync::Arc;
use std::time::Duration;

use ircx_ipc::{
    ChatMessage, CommandOutcome, InstalledPlugin, MessageKind, PluginCommand, PluginGrants,
    PluginPermission, PluginPermissionInfo,
};
use ircx_net::http::{fetch, FetchPolicy};
use ircx_plugin::{
    ArrivedMessage, CommandReply, CommandRequest, ContextMessage, Failure, Fetched, Fetcher,
    Grants, Installed, Permission, PluginFailure, PluginRuntime, Route,
};

use crate::dispatch;
use crate::session::{Action, SessionState};

/// How many recent messages a plugin granted `read-messages` is handed.
pub const CONTEXT_MESSAGES: u32 = 50;

/// Consecutive failed batches before an annotator is dropped for the session.
/// `docs/plugins.md` says a broken one is dropped and does not say when; one
/// bad batch is a message the plugin did not expect, three in a row is the
/// plugin.
pub const ANNOTATOR_STRIKES: u32 = 3;

/// An answer a plugin reads, not a download.
const MAX_FETCH_BYTES: usize = 256 * 1024;

/// What an annotator is handed: the messages in one batch that a person said.
///
/// Joins, quits, mode changes and server chatter are left out. A note sits
/// beside something somebody wrote, and handing over the rest would multiply
/// the call count by traffic that has nothing to annotate.
pub fn spoken(messages: &[ChatMessage]) -> Vec<ArrivedMessage> {
    messages
        .iter()
        .filter(|message| {
            matches!(
                message.kind,
                MessageKind::Privmsg | MessageKind::Notice | MessageKind::Action
            )
        })
        .map(|message| ArrivedMessage {
            id: message.id.clone(),
            nick: message.sender.nick.clone(),
            text: message.text.clone(),
            time: message.timestamp.clone(),
        })
        .collect()
}

/// A command on its way to the plugin that owns it.
#[derive(Debug, Clone)]
pub struct PluginCall {
    pub route: Route,
    pub request: CommandRequest,
}

impl PluginCall {
    /// Whether the caller should read the conversation's recent messages and
    /// put them in `request.messages`. False unless the plugin holds
    /// `read-messages` for this conversation, so an ungranted plugin costs no
    /// query.
    pub fn wants_messages(&self) -> bool {
        self.route.reads_messages(&self.request.target)
    }

    pub fn with_messages(mut self, messages: Vec<ChatMessage>) -> Self {
        self.request.messages = messages
            .into_iter()
            .map(|message| ContextMessage {
                nick: message.sender.nick,
                text: message.text,
                time: message.timestamp,
            })
            .collect();
        self
    }
}

impl SessionState {
    /// The plugin call `input` names, if it is a slash command that no built-in
    /// claims and some installed plugin owns. Cheap: no runtime is started and
    /// no plugin code runs to answer this.
    pub fn plugin_command(
        &self,
        runtime: &PluginRuntime,
        target: &str,
        input: &str,
    ) -> Option<PluginCall> {
        // A command needs a server the same way a built-in does; without one,
        // this falls through to `dispatch`, which says so in the usual words.
        if !self.registered {
            return None;
        }
        let (name, args) = dispatch::slash_command(input)?;
        if dispatch::is_builtin(&name) {
            return None;
        }
        let route = runtime.route(&name)?;
        Some(PluginCall {
            request: CommandRequest {
                command: route.command.clone(),
                args: args.to_owned(),
                target: target.to_owned(),
                nick: self.nick.clone(),
                messages: Vec::new(),
            },
            route,
        })
    }

    /// Applies what a plugin's command produced. A failure is reported to the
    /// user against the plugin's name and changes nothing else: the connection
    /// carries on, which is the requirement in #13.
    pub fn apply_plugin(
        &mut self,
        call: &PluginCall,
        answer: Result<CommandReply, PluginFailure>,
    ) -> (CommandOutcome, Vec<Action>) {
        let outcome = match answer {
            Ok(reply) => {
                for out in reply.sends {
                    for message in self.say(&out.target, &out.text, MessageKind::Privmsg, None) {
                        self.append(message);
                    }
                }
                if let Some(content) = reply.content {
                    self.note_block_via(&call.request.target, &content, Some(&call.route.plugin));
                }
                CommandOutcome::Handled
            }
            Err(failure) => CommandOutcome::Rejected(failure.to_string()),
        };
        (outcome, self.drain())
    }
}

/// How a plugin granted `network-requests` reaches the network: `ircx-net`,
/// which is the only crate that opens an outbound socket, under the same policy
/// an attachment preview gets. `handle` is captured because the call arrives on
/// a plugin's own thread, which knows nothing about the runtime.
///
/// The request is given the budget the sandbox worked out, which is what is
/// left of the plugin's call deadline — so the one host function that waits
/// cannot carry a call past the deadline it was granted.
pub fn network_for_plugins(handle: tokio::runtime::Handle) -> Fetcher {
    Arc::new(move |request| {
        let policy = FetchPolicy {
            max_bytes: MAX_FETCH_BYTES,
            timeout: request.budget.max(Duration::from_millis(1)),
            accept: "application/json, text/*;q=0.9, */*;q=0.5".into(),
            ..FetchPolicy::default()
        };
        let fetched = handle
            .block_on(fetch(&request.url, &policy))
            .map_err(|error| error.to_string())?;
        let body = String::from_utf8(fetched.body)
            .map_err(|_| format!("{} answered with something that is not text", request.url))?;
        Ok(Fetched { status: 200, body })
    })
}

/// Every permission a plugin may ask for, with the words the install dialogue
/// shows for it. The wording is read from `ircx-plugin` rather than written
/// again here, so what is enforced and what the user was told are one text.
pub fn describe_permissions() -> Vec<PluginPermissionInfo> {
    Permission::ALL
        .into_iter()
        .map(|permission| PluginPermissionInfo {
            permission: sent(permission),
            summary: permission.summary().to_owned(),
        })
        .collect()
}

/// An installed plugin as the window shows it, with what the manifest asks for
/// beside what the user allowed.
pub fn describe_plugin(installed: &Installed) -> InstalledPlugin {
    let manifest = &installed.manifest;
    InstalledPlugin {
        id: manifest.id.clone(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        commands: manifest
            .commands
            .iter()
            .map(|command| PluginCommand {
                name: command.name.clone(),
                summary: command.summary.clone(),
            })
            .collect(),
        requests: listed(&manifest.requests),
        grants: listed(&installed.grants),
    }
}

/// What the user chose in the install dialogue, in the shape the library
/// enforces. Nothing is checked here: a grant the manifest never asked for is
/// refused by `Grants::within`, which is the one place that decides.
pub fn chosen_grants(grants: PluginGrants) -> Grants {
    Grants {
        permissions: grants.permissions.into_iter().map(enforced).collect(),
        channels: grants.channels,
        hosts: grants.hosts,
    }
}

fn listed(grants: &Grants) -> PluginGrants {
    PluginGrants {
        permissions: grants.permissions.iter().copied().map(sent).collect(),
        channels: grants.channels.clone(),
        hosts: grants.hosts.clone(),
    }
}

/// The permissions are spelled once in `ircx-plugin`, which enforces them, and
/// once in `ircx-ipc`, which carries them to the window; neither may depend on
/// the other. Both matches are exhaustive, so a new permission stops the build
/// here until it has been named on both sides — which is how `annotate-messages`
/// arrived.
fn sent(permission: Permission) -> PluginPermission {
    match permission {
        Permission::ReadMessages => PluginPermission::ReadMessages,
        Permission::SendMessages => PluginPermission::SendMessages,
        Permission::AddCommands => PluginPermission::AddCommands,
        Permission::StoreLocalData => PluginPermission::StoreLocalData,
        Permission::AccessChannels => PluginPermission::AccessChannels,
        Permission::NetworkRequests => PluginPermission::NetworkRequests,
        Permission::RenderContent => PluginPermission::RenderContent,
        Permission::AnnotateMessages => PluginPermission::AnnotateMessages,
    }
}

fn enforced(permission: PluginPermission) -> Permission {
    match permission {
        PluginPermission::ReadMessages => Permission::ReadMessages,
        PluginPermission::SendMessages => Permission::SendMessages,
        PluginPermission::AddCommands => Permission::AddCommands,
        PluginPermission::StoreLocalData => Permission::StoreLocalData,
        PluginPermission::AccessChannels => Permission::AccessChannels,
        PluginPermission::NetworkRequests => Permission::NetworkRequests,
        PluginPermission::RenderContent => Permission::RenderContent,
        PluginPermission::AnnotateMessages => Permission::AnnotateMessages,
    }
}

/// Runs the call on a thread of the blocking pool, so a plugin spending its
/// whole deadline costs the connection task nothing but the wait.
pub async fn run_plugin(
    runtime: Arc<PluginRuntime>,
    call: &PluginCall,
) -> Result<CommandReply, PluginFailure> {
    let plugin = call.route.plugin.clone();
    let (route, request) = (call.route.clone(), call.request.clone());
    let ran = tokio::task::spawn_blocking(move || runtime.run(&route, request)).await;
    match ran {
        Ok(answer) => answer,
        Err(_) => Err(PluginFailure {
            plugin,
            failure: Failure::Host("the task running it did not finish".into()),
        }),
    }
}
