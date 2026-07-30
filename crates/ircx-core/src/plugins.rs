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

use std::sync::Arc;
use std::time::Duration;

use ircx_ipc::{ChatMessage, CommandOutcome, MessageKind};
use ircx_net::http::{fetch, FetchPolicy};
use ircx_plugin::{
    CommandReply, CommandRequest, ContextMessage, Failure, Fetched, Fetcher, PluginFailure,
    PluginRuntime, Route,
};

use crate::dispatch;
use crate::session::{Action, SessionState};

/// How many recent messages a plugin granted `read-messages` is handed.
pub const CONTEXT_MESSAGES: u32 = 50;

/// An answer a plugin reads, not a download.
const MAX_FETCH_BYTES: usize = 256 * 1024;

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
                    for message in self.say(&out.target, &out.text, MessageKind::Privmsg) {
                        self.append(message);
                    }
                }
                if let Some(content) = reply.content {
                    self.note_block(&call.request.target, &content);
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
