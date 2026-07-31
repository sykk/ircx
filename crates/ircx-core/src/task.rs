use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ircx_ipc::HistoryRequest;
use ircx_ipc::{
    Channel, ChatMessage, CommandOutcome, ConnectionStatus, IrcxEvent, Member, Network, NetworkId,
    Query, Severity, TargetName,
};
use ircx_net::{Backoff, BackoffPolicy, ConnectionConfig, LineSender, Transport, TransportEvent};
use ircx_plugin::{AnnotateRequest, ArrivedMessage, Failure, NotifyRequest, PluginRuntime};
use ircx_store::Store;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{interval_at, Instant};
use tracing::warn;

use crate::plugins::{self, PluginCall, CONTEXT_MESSAGES, HOOK_STRIKES};
use crate::session::{Action, SessionConfig, SessionState};

const COMMAND_QUEUE: usize = 64;

/// Which on-arrival hook a strike is against. A plugin can hold both, and one
/// of them failing says nothing about the other: a rule that throws should not
/// cost the same plugin its annotator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Hook {
    Annotate,
    Notify,
}

impl Hook {
    /// What the plugin was doing, for the one line a broken one gets.
    fn doing(self) -> &'static str {
        match self {
            Self::Annotate => "annotate a message",
            Self::Notify => "decide whether a message was worth interrupting you for",
        }
    }
}

type Strikes = Mutex<HashMap<(Hook, String), u32>>;

/// How many batches in a row this plugin has failed at this hook.
fn out(strikes: &Strikes, hook: Hook, plugin: &str) -> u32 {
    strikes
        .lock()
        .map(|held| {
            held.get(&(hook, plugin.to_owned()))
                .copied()
                .unwrap_or_default()
        })
        .unwrap_or(0)
}

/// Records a failed batch, and says so once. A broken hook would otherwise
/// report as often as the channel talks, so the first failure is the report and
/// the rest are silence — including the one that drops it.
fn strike(strikes: &Strikes, hook: Hook, plugin: &str, failure: Option<&Failure>) {
    let Ok(mut held) = strikes.lock() else { return };
    let count = held.entry((hook, plugin.to_owned())).or_insert(0);
    *count += 1;
    if *count == 1 {
        let doing = hook.doing();
        match failure {
            Some(failure) => warn!(%plugin, %failure, "a plugin could not {doing}"),
            None => warn!(%plugin, "the task asking a plugin to {doing} did not finish"),
        }
    }
}

fn strike_cleared(strikes: &Strikes, hook: Hook, plugin: &str) {
    if let Ok(mut held) = strikes.lock() {
        held.remove(&(hook, plugin.to_owned()));
    }
}
const KEEPALIVE: Duration = Duration::from_secs(120);

/// What the Tauri layer asks of a running network. Anything expecting an
/// answer carries the channel to send it back on.
pub enum SessionCommand {
    Submit {
        target: TargetName,
        input: String,
        reply_to: Option<String>,
        reply: oneshot::Sender<CommandOutcome>,
    },
    Join {
        channel: String,
        key: Option<String>,
    },
    Part {
        channel: String,
        reason: Option<String>,
    },
    OpenQuery {
        nick: String,
        reply: oneshot::Sender<Query>,
    },
    CloseTarget {
        target: TargetName,
    },
    MarkRead {
        target: TargetName,
    },
    SetTyping {
        target: TargetName,
        active: bool,
    },
    /// `message` is the server `msgid` being reacted to; `active` is false to
    /// take the reaction back.
    React {
        target: TargetName,
        message: String,
        emoji: String,
        active: bool,
    },
    Raw {
        line: String,
    },
    Members {
        channel: TargetName,
        reply: oneshot::Sender<Vec<Member>>,
    },
    Snapshot {
        reply: oneshot::Sender<(Network, Vec<Channel>, Vec<Query>)>,
    },
    /// A rule raised a message in this conversation. The count is the
    /// session's, so the rule asks for it rather than keeping its own.
    Raised {
        target: TargetName,
    },
    Disconnect {
        reason: Option<String>,
    },
}

pub struct NetworkHandle {
    network: NetworkId,
    commands: mpsc::Sender<SessionCommand>,
    task: JoinHandle<()>,
}

impl NetworkHandle {
    pub fn network(&self) -> &NetworkId {
        &self.network
    }

    pub fn commands(&self) -> mpsc::Sender<SessionCommand> {
        self.commands.clone()
    }

    pub async fn shutdown(self, reason: Option<String>) {
        let _ = self
            .commands
            .send(SessionCommand::Disconnect { reason })
            .await;
        drop(self.commands);
        let _ = self.task.await;
    }
}

/// Runs one network. The task owns its `Transport`, its `SessionState` and
/// its reconnect timing; nothing is shared with the other networks but the
/// event channel and the archive.
pub fn spawn_network(
    config: SessionConfig,
    store: Arc<Store>,
    events: mpsc::Sender<IrcxEvent>,
) -> NetworkHandle {
    spawn_network_with_plugins(config, store, events, None)
}

/// The same, with plugins. A network given a runtime routes a slash command no
/// built-in claims to the plugin that owns it; a network given `None` never
/// looks, which is the whole of what a user with no plugins pays here.
pub fn spawn_network_with_plugins(
    config: SessionConfig,
    store: Arc<Store>,
    events: mpsc::Sender<IrcxEvent>,
    plugins: Option<Arc<PluginRuntime>>,
) -> NetworkHandle {
    let (commands, inbox) = mpsc::channel(COMMAND_QUEUE);
    let network = config.network.clone();
    let session = commands.downgrade();
    let task = tokio::spawn(supervise(config, store, events, inbox, plugins, session));
    NetworkHandle {
        network,
        commands,
        task,
    }
}

/// A bug that panics one network's connection leaves the others running and
/// tells the user which one stopped, rather than taking the process with it.
async fn supervise(
    config: SessionConfig,
    store: Arc<Store>,
    events: mpsc::Sender<IrcxEvent>,
    inbox: mpsc::Receiver<SessionCommand>,
    plugins: Option<Arc<PluginRuntime>>,
    session: mpsc::WeakSender<SessionCommand>,
) {
    let network = config.network.clone();
    let name = config.name.clone();
    let outcome = tokio::spawn(run(config, store, events.clone(), inbox, plugins, session)).await;

    if outcome.as_ref().is_err_and(|error| error.is_panic()) {
        let message = format!("The connection to {name} stopped unexpectedly");
        let _ = events
            .send(IrcxEvent::ConnectionChanged {
                network: network.clone(),
                status: ConnectionStatus::Failed {
                    message: message.clone(),
                },
            })
            .await;
        let _ = events
            .send(IrcxEvent::Notice {
                network: Some(network),
                severity: Severity::Error,
                text: message,
                detail: Some("Reconnect from the network list to try again".into()),
            })
            .await;
    }
}

async fn run(
    config: SessionConfig,
    store: Arc<Store>,
    events: mpsc::Sender<IrcxEvent>,
    mut inbox: mpsc::Receiver<SessionCommand>,
    plugins: Option<Arc<PluginRuntime>>,
    own_inbox: mpsc::WeakSender<SessionCommand>,
) {
    let endpoint = (
        config.host.clone(),
        config.port,
        config.tls,
        config.tls_verify,
    );
    let mut session = SessionState::new(config);
    let mut backoff = Backoff::new(BackoffPolicy::default());
    let context = Context {
        network: session.network_id().clone(),
        store,
        events,
        plugins,
        strikes: Arc::default(),
        own_inbox,
    };

    let remembered = match context.store.open_targets(&context.network) {
        Ok(targets) => targets,
        Err(error) => {
            warn!(%error, "could not read the conversations that were open");
            Vec::new()
        }
    };
    let actions = session.restore(remembered);
    if context.deliver(actions, None).await {
        return;
    }

    loop {
        let actions = session.on_connecting();
        if context.deliver(actions, None).await {
            return;
        }

        let attempt = Transport::connect(ConnectionConfig {
            host: endpoint.0.clone(),
            port: endpoint.1,
            tls: endpoint.2,
            tls_verify: endpoint.3,
            ..ConnectionConfig::default()
        })
        .await;
        let (transport, mut incoming) = match attempt {
            Ok(connected) => connected,
            Err(error) => {
                let actions = session.on_disconnected(&error.to_string());
                if context.deliver(actions, None).await {
                    return;
                }
                if !wait_to_retry(&mut backoff, &mut session, &context, &mut inbox).await {
                    return;
                }
                continue;
            }
        };

        backoff.record_connected();
        let sender = transport.sender();
        let mut keepalive = interval_at(Instant::now() + KEEPALIVE, KEEPALIVE);
        let mut stop = false;
        let mut reason = String::from("the connection ended");

        loop {
            let actions = tokio::select! {
                event = incoming.recv() => match event {
                    Some(TransportEvent::Connected { tls_info }) => session.on_connected(tls_info),
                    Some(TransportEvent::Line(line)) => session.on_line(&line),
                    Some(TransportEvent::Disconnected { reason: why }) => {
                        reason = why.to_string();
                        break;
                    }
                    None => break,
                },
                command = inbox.recv() => match command {
                    Some(command) => apply(command, &mut session, &context).await,
                    None => { stop = true; break }
                },
                _ = keepalive.tick() => session.keepalive(),
            };

            if context.deliver(actions, Some(&sender)).await {
                stop = true;
                break;
            }
        }

        drop(transport);
        if stop {
            return;
        }
        let actions = session.on_disconnected(&reason);
        if context.deliver(actions, None).await {
            return;
        }
        if !wait_to_retry(&mut backoff, &mut session, &context, &mut inbox).await {
            return;
        }
    }
}

/// Counts down to the next attempt while still answering the UI, so a user can
/// give up on a network that is refusing connections.
async fn wait_to_retry(
    backoff: &mut Backoff,
    session: &mut SessionState,
    context: &Context,
    inbox: &mut mpsc::Receiver<SessionCommand>,
) -> bool {
    let delay = backoff.next_delay();
    let actions = session.on_reconnect_wait(delay.as_secs().min(u64::from(u32::MAX)) as u32);
    if context.deliver(actions, None).await {
        return false;
    }

    let deadline = Instant::now() + delay;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return true,
            command = inbox.recv() => match command {
                Some(command) => {
                    let actions = apply(command, session, context).await;
                    if context.deliver(actions, None).await {
                        return false;
                    }
                }
                None => return false,
            },
        }
    }
}

async fn apply(
    command: SessionCommand,
    session: &mut SessionState,
    context: &Context,
) -> Vec<Action> {
    match command {
        SessionCommand::Submit {
            target,
            input,
            reply_to,
            reply,
        } => {
            if let Some(call) = context.plugin_call(session, &target, &input) {
                let (outcome, actions) = context.run_plugin(session, call).await;
                let _ = reply.send(outcome);
                return actions;
            }
            let (outcome, actions) = session.submit(&target, &input, reply_to.as_deref());
            if let CommandOutcome::Sent(message) = &outcome {
                context.persist(std::slice::from_ref(message.as_ref()));
            }
            let _ = reply.send(outcome);
            actions
        }
        SessionCommand::Join { channel, key } => session.join(&channel, key.as_deref()),
        SessionCommand::Part { channel, reason } => session.part(&channel, reason.as_deref()),
        SessionCommand::OpenQuery { nick, reply } => {
            let (query, actions) = session.open_query(&nick);
            let _ = reply.send(query);
            actions
        }
        SessionCommand::CloseTarget { target } => session.close_target(&target),
        SessionCommand::MarkRead { target } => session.mark_read(&target),
        SessionCommand::SetTyping { target, active } => session.set_typing(&target, active),
        SessionCommand::React {
            target,
            message,
            emoji,
            active,
        } => session.react(&target, &message, &emoji, active),
        SessionCommand::Raw { line } => session.raw(&line),
        SessionCommand::Members { channel, reply } => {
            let _ = reply.send(session.members(&channel));
            Vec::new()
        }
        SessionCommand::Snapshot { reply } => {
            let _ = reply.send((session.snapshot(), session.channels(), session.queries()));
            Vec::new()
        }
        SessionCommand::Raised { target } => session.raise(&target),
        SessionCommand::Disconnect { reason } => session.quit(reason.as_deref()),
    }
}

struct Context {
    network: NetworkId,
    store: Arc<Store>,
    events: mpsc::Sender<IrcxEvent>,
    /// `None` when no runtime was given, which is the whole of what a launch
    /// with no plugins costs on this path.
    plugins: Option<Arc<PluginRuntime>>,
    /// Consecutive failed batches per plugin per hook. One that fails on every
    /// message would otherwise report as often as the channel talks.
    strikes: Arc<Strikes>,
    /// The session's own inbox, for the one thing that has to reach back into
    /// it: a rule raising a message after the badge was already counted. Weak,
    /// because the inbox closing is what stops the session, and a clone held
    /// here would keep a disconnected network alive for good.
    own_inbox: mpsc::WeakSender<SessionCommand>,
}

impl Context {
    /// The plugin command this input names, with the conversation's recent
    /// messages attached if the plugin was granted them. The archive is not
    /// read at all otherwise.
    fn plugin_call(&self, session: &SessionState, target: &str, input: &str) -> Option<PluginCall> {
        let runtime = self.plugins.as_ref()?;
        let call = session.plugin_command(runtime, target, input)?;
        if !call.wants_messages() {
            return Some(call);
        }
        let request = HistoryRequest {
            network: self.network.clone(),
            target: target.to_string(),
            before: None,
            limit: CONTEXT_MESSAGES,
        };
        match self.store.load_history(&request) {
            Ok(messages) => Some(call.with_messages(messages)),
            Err(error) => {
                warn!(%error, "could not read the conversation for a plugin");
                Some(call)
            }
        }
    }

    /// Waits for the plugin and applies what it produced. The wait is bounded
    /// by the plugin's limits, so the worst a plugin does to the connection is
    /// hold this command for its deadline.
    async fn run_plugin(
        &self,
        session: &mut SessionState,
        call: PluginCall,
    ) -> (CommandOutcome, Vec<Action>) {
        let Some(runtime) = self.plugins.clone() else {
            return (CommandOutcome::Handled, Vec::new());
        };
        let answer = plugins::run_plugin(runtime, &call).await;
        if let Err(failure) = &answer {
            warn!(plugin = %failure.plugin, %failure, "a plugin command failed");
        }
        session.apply_plugin(&call, answer)
    }

    /// Returns `true` when the session asked to stop for good.
    async fn deliver(&self, actions: Vec<Action>, sender: Option<&LineSender>) -> bool {
        let mut close = false;
        for action in actions {
            match action {
                Action::Send(line) => {
                    if let Some(sender) = sender {
                        if let Err(error) = sender.send(line).await {
                            warn!(%error, "could not queue an outgoing line");
                        }
                    }
                }
                Action::Emit(event) => {
                    let arrived = match event.as_ref() {
                        IrcxEvent::MessagesAppended {
                            target, messages, ..
                        } => Some((target.clone(), plugins::spoken(messages))),
                        _ => None,
                    };
                    match event.as_ref() {
                        IrcxEvent::MessagesAppended { messages, .. } => self.persist(messages),
                        IrcxEvent::MessageUpdated { message } => self.update(message),
                        IrcxEvent::ReactionChanged {
                            message,
                            nick,
                            emoji,
                            active,
                            ..
                        } => self.record_reaction(message, nick, emoji, *active),
                        _ => {}
                    }
                    if self.events.send(*event).await.is_err() {
                        close = true;
                    }
                    // After the send, which is what makes the message drawn
                    // before any annotator runs.
                    if let Some((target, messages)) = arrived {
                        self.annotate(target, messages);
                    }
                }
                Action::Remember(target) => {
                    if let Err(error) = self.store.remember_target(&self.network, &target) {
                        warn!(%error, "could not record an open conversation");
                    }
                }
                Action::Forget(target) => {
                    if let Err(error) = self.store.forget_target(&self.network, &target) {
                        warn!(%error, "could not forget a closed conversation");
                    }
                }
                Action::Notify { target, messages } => self.notify(target, messages),
                Action::Close => close = true,
            }
        }
        close
    }

    /// Hands a batch to every annotator that reaches this conversation.
    ///
    /// Spawned rather than awaited: the message is already drawn, and a slow
    /// annotator must delay its own note and nothing else. A conversation no
    /// installed plugin annotates costs one map lookup, because `annotators`
    /// answers from the library without starting a runtime.
    fn annotate(&self, target: TargetName, messages: Vec<ArrivedMessage>) {
        if messages.is_empty() {
            return;
        }
        let Some(runtime) = self.plugins.clone() else {
            return;
        };
        let strikes = Arc::clone(&self.strikes);
        let annotators: Vec<_> = runtime
            .annotators(&target)
            .into_iter()
            .filter(|annotator| out(&strikes, Hook::Annotate, &annotator.plugin) < HOOK_STRIKES)
            .collect();
        if annotators.is_empty() {
            return;
        }

        let events = self.events.clone();
        let network = self.network.clone();
        let store = Arc::clone(&self.store);
        tokio::spawn(async move {
            for annotator in annotators {
                let request = AnnotateRequest {
                    target: target.clone(),
                    messages: messages.clone(),
                };
                let running = Arc::clone(&runtime);
                let plugin = annotator.plugin.clone();
                let ran =
                    tokio::task::spawn_blocking(move || running.annotate(&annotator, request))
                        .await;

                let reply = match ran {
                    Ok(Ok(reply)) => reply,
                    Ok(Err(failure)) => {
                        strike(&strikes, Hook::Annotate, &plugin, Some(&failure.failure));
                        continue;
                    }
                    Err(_) => {
                        strike(&strikes, Hook::Annotate, &plugin, None);
                        continue;
                    }
                };
                strike_cleared(&strikes, Hook::Annotate, &plugin);

                for note in reply.notes {
                    // Written before it is sent, for the reason a reaction is:
                    // the archive is the only place a note outside the open
                    // window survives, and a conversation reopened tomorrow
                    // reads it back rather than running the annotator again.
                    if let Err(error) =
                        store.set_annotation(&network, &note.message, &plugin, &note.text)
                    {
                        warn!(%error, "could not write an annotation to the archive");
                    }
                    let event = IrcxEvent::MessageAnnotated {
                        network: network.clone(),
                        target: target.clone(),
                        message: note.message,
                        plugin: plugin.clone(),
                        text: note.text,
                    };
                    if events.send(event).await.is_err() {
                        return;
                    }
                }
            }
        });
    }

    /// Hands a batch to every notification rule that reaches this
    /// conversation, and raises what they name.
    ///
    /// Spawned for the reason `annotate` is: the message is drawn, and the
    /// badge going loud a moment later is the cost of not making a
    /// conversation wait on a plugin.
    fn notify(&self, target: TargetName, messages: Vec<ArrivedMessage>) {
        let Some(runtime) = self.plugins.clone() else {
            return;
        };
        let strikes = Arc::clone(&self.strikes);
        let rules: Vec<_> = runtime
            .notifiers(&target)
            .into_iter()
            .filter(|rule| out(&strikes, Hook::Notify, &rule.plugin) < HOOK_STRIKES)
            .collect();
        if rules.is_empty() {
            return;
        }

        let events = self.events.clone();
        let network = self.network.clone();
        let store = Arc::clone(&self.store);
        let own_inbox = self.own_inbox.clone();
        tokio::spawn(async move {
            // Two rules raising the same message is one raise. Kept here rather
            // than in the session, because a message arrives in one batch and
            // no later batch can hold it again.
            let mut already: HashSet<String> = HashSet::new();
            for rule in rules {
                let request = NotifyRequest {
                    target: target.clone(),
                    messages: messages.clone(),
                };
                let running = Arc::clone(&runtime);
                let plugin = rule.plugin.clone();
                let ran = tokio::task::spawn_blocking(move || running.notify(&rule, request)).await;

                let reply = match ran {
                    Ok(Ok(reply)) => reply,
                    Ok(Err(failure)) => {
                        strike(&strikes, Hook::Notify, &plugin, Some(&failure.failure));
                        continue;
                    }
                    Err(_) => {
                        strike(&strikes, Hook::Notify, &plugin, None);
                        continue;
                    }
                };
                strike_cleared(&strikes, Hook::Notify, &plugin);

                for message in reply.raised {
                    // Written before it is sent, as a note is: the archive is
                    // where a raise outside the open window survives, so a
                    // conversation reopened tomorrow still shows what was worth
                    // reading in it.
                    if let Err(error) = store.set_raised(&network, &message, &plugin) {
                        warn!(%error, "could not write a raised message to the archive");
                    }
                    let first = already.insert(message.clone());
                    let event = IrcxEvent::MessageRaised {
                        network: network.clone(),
                        target: target.clone(),
                        message,
                        plugin: plugin.clone(),
                    };
                    if events.send(event).await.is_err() {
                        return;
                    }
                    // The count lives in the session, so the badge is raised by
                    // asking for it rather than by a second party keeping its
                    // own tally.
                    if first {
                        let Some(inbox) = own_inbox.upgrade() else {
                            return;
                        };
                        let raised = SessionCommand::Raised {
                            target: target.clone(),
                        };
                        if inbox.send(raised).await.is_err() {
                            return;
                        }
                    }
                }
            }
        });
    }

    fn persist(&self, messages: &[ChatMessage]) {
        if let Err(error) = self.store.append_messages(messages) {
            warn!(%error, "could not write messages to the archive");
        }
    }

    /// The archive is the only place a reaction outside the open window
    /// survives, so it is written whether or not the message it names is here.
    fn record_reaction(&self, message: &str, nick: &str, emoji: &str, active: bool) {
        let stored = self
            .store
            .set_reaction(&self.network, message, nick, emoji, active);
        if let Err(error) = stored {
            warn!(%error, "could not write a reaction to the archive");
        }
    }

    /// The archived copy was written while the message was still in flight, so
    /// a confirmation has to reach the row it left behind.
    fn update(&self, message: &ChatMessage) {
        if let Err(error) = self.store.update_message(message) {
            warn!(%error, "could not update a message in the archive");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A broken annotator would report as often as the channel talks, so the
    /// first failure is the report and the rest are silence — and after
    /// `HOOK_STRIKES` in a row the host stops calling it at all.
    #[test]
    fn an_annotator_is_dropped_only_after_failing_repeatedly() {
        let strikes = Mutex::new(HashMap::new());

        for _ in 0..HOOK_STRIKES - 1 {
            strike(&strikes, Hook::Annotate, "units", None);
        }
        assert!(
            out(&strikes, Hook::Annotate, "units") < HOOK_STRIKES,
            "one bad batch is a message the plugin did not expect"
        );

        strike(&strikes, Hook::Annotate, "units", None);
        assert_eq!(out(&strikes, Hook::Annotate, "units"), HOOK_STRIKES);
    }

    /// Consecutive, not cumulative. A plugin that trips over one message every
    /// so often and works the rest of the time is not broken.
    #[test]
    fn a_batch_that_worked_clears_what_came_before_it() {
        let strikes = Mutex::new(HashMap::new());

        strike(&strikes, Hook::Annotate, "units", None);
        strike(&strikes, Hook::Annotate, "units", None);
        strike_cleared(&strikes, Hook::Annotate, "units");
        strike(&strikes, Hook::Annotate, "units", None);

        assert_eq!(out(&strikes, Hook::Annotate, "units"), 1);
    }

    #[test]
    fn one_annotators_failures_are_not_anothers() {
        let strikes = Mutex::new(HashMap::new());
        strike(&strikes, Hook::Annotate, "units", None);
        assert_eq!(out(&strikes, Hook::Annotate, "links"), 0);
    }

    /// One plugin can hold both hooks, and one of them failing says nothing
    /// about the other: a rule that throws must not cost the plugin its
    /// annotator, or a user would lose a working note to a broken decision.
    #[test]
    fn one_hooks_failures_are_not_the_others() {
        let strikes = Mutex::new(HashMap::new());
        for _ in 0..HOOK_STRIKES {
            strike(&strikes, Hook::Notify, "deploys", None);
        }

        assert_eq!(out(&strikes, Hook::Notify, "deploys"), HOOK_STRIKES);
        assert_eq!(out(&strikes, Hook::Annotate, "deploys"), 0);
    }
}
