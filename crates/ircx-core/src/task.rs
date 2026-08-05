use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
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

use crate::archive::Archive;
use crate::plugins::{self, PluginCall, CONTEXT_MESSAGES, HOOK_STRIKES};
use crate::session::{Action, Restored, SessionConfig, SessionState};

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

    /// What the host stopped asking it for, in the sentence the user reads.
    fn asking_for(self) -> &'static str {
        match self {
            Self::Annotate => "to annotate messages",
            Self::Notify => "what is worth interrupting you for",
        }
    }
}

/// What the console says when a hook is dropped. Names the plugin the way the
/// note beside a message does, so "stopped" and "raised by" say the same word
/// about the same plugin.
///
/// Installing is the repair rather than restarting, because installing over a
/// plugin resets its grants: the user has to visit the sheet anyway, and
/// `PluginChanged` clears the strikes when they do.
fn stopped_text(hook: Hook, plugin: &str) -> String {
    format!(
        "The {plugin} plugin failed {HOOK_STRIKES} times in a row, so ircx stopped asking it {}. \
         Install it again from Plugins once it is fixed.",
        hook.asking_for()
    )
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

/// Records a failed batch and logs the first one, which is the one carrying the
/// failure text. Returns whether this strike is the one that dropped the hook.
///
/// A broken hook would otherwise report as often as the channel talks, so only
/// the first failure and the drop are said at all — and the drop is the one the
/// user is told about, because a plugin that failed once is still working.
fn strike(strikes: &Strikes, hook: Hook, plugin: &str, failure: Option<&Failure>) -> bool {
    let Ok(mut held) = strikes.lock() else {
        return false;
    };
    let count = held.entry((hook, plugin.to_owned())).or_insert(0);
    *count += 1;
    if *count == 1 {
        let doing = hook.doing();
        match failure {
            Some(failure) => warn!(%plugin, %failure, "a plugin could not {doing}"),
            None => warn!(%plugin, "the task asking a plugin to {doing} did not finish"),
        }
    }
    *count == HOOK_STRIKES
}

/// Tells the session a hook is finished, so it lands in the server console with
/// the network's other bad news rather than in a log nobody has open.
///
/// The text is built here rather than in the session because the session holds
/// no strikes and does not know a hook from a hook.
async fn report_stopped(
    inbox: &mpsc::WeakSender<SessionCommand>,
    hook: Hook,
    plugin: &str,
    failure: Option<String>,
) {
    let Some(inbox) = inbox.upgrade() else {
        return;
    };
    let stopped = SessionCommand::PluginStopped {
        text: stopped_text(hook, plugin),
        detail: failure,
    };
    let _ = inbox.send(stopped).await;
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
    /// A hook failed often enough that the host stopped calling it. Routed
    /// through the session because the console is where a network's bad news
    /// goes, and the session is what writes there.
    PluginStopped {
        text: String,
        detail: Option<String>,
    },
    /// This plugin's library entry was installed, granted or removed. Whatever
    /// it did before was done by code or permissions the user has since
    /// replaced, so the strikes against it no longer describe anything.
    PluginChanged {
        plugin: String,
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
    // Beside the tuple rather than in it: a fifth field read as `endpoint.4`
    // says nothing about what it is.
    let client_certificate = config.client_certificate.clone().map(PathBuf::from);
    let mut session = SessionState::new(config);
    let mut backoff = Backoff::new(BackoffPolicy::default());
    let context = Context {
        waiting: Arc::new(Waiting::default()),
        network: session.network_id().clone(),
        archive: Archive::open(Arc::clone(&store)),
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
    // Where each one's record left off, which is what makes the difference
    // between coming back to a conversation and meeting one. An archive that
    // cannot be read asks for a first page, which is what a conversation with
    // no archive asks for anyway.
    let remembered: Vec<Restored> = remembered
        .into_iter()
        .map(|target| {
            let newest = context
                .store
                .newest_timestamp(&context.network, target.name())
                .unwrap_or_else(|error| {
                    warn!(%error, "could not read where a conversation left off");
                    None
                });
            Restored { target, newest }
        })
        .collect();
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
            client_certificate: client_certificate.clone(),
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
        let mut written = transport.written();
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
                // The writer ends with the connection, so a closed mark is the
                // socket going and the `Disconnected` event is what explains it.
                moved = written.changed() => match moved {
                    Ok(()) => {
                        let mark = *written.borrow_and_update();
                        session.on_written(mark)
                    }
                    Err(_) => break,
                },
                _ = keepalive.tick() => session.keepalive(),
            };

            if context.deliver(actions, Some(&sender)).await {
                stop = true;
                break;
            }
        }

        drop(transport);
        // The one place this task waits for the archive on purpose: a session
        // that has stopped is a session whose last messages have to be down
        // before it says so.
        context.archive.drained().await;
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
            if let Some(call) = context.plugin_call(session, &target, &input).await {
                let (outcome, actions) = context.run_plugin(session, call).await;
                let _ = reply.send(outcome);
                return actions;
            }
            let (outcome, actions) = session.submit(&target, &input, reply_to.as_deref());
            if let CommandOutcome::Sent(message) = &outcome {
                context
                    .persist(std::slice::from_ref(message.as_ref()))
                    .await;
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
        SessionCommand::PluginStopped { text, detail } => session.plugin_stopped(text, detail),
        SessionCommand::PluginChanged { plugin } => {
            // Both hooks, because the user repairing a plugin is repairing the
            // plugin: which of its two hooks was the broken one is not
            // something they were ever shown.
            strike_cleared(&context.strikes, Hook::Annotate, &plugin);
            strike_cleared(&context.strikes, Hook::Notify, &plugin);
            Vec::new()
        }
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
    /// Where every change to the archive goes. Held rather than done, because
    /// the connection task is the one thing that must never wait on the
    /// archive. #410, and `crate::archive` says the rest.
    archive: Archive,
    /// Messages an annotator has not caught up with, and which conversations
    /// already have a worker on them. See `annotate`. #406.
    waiting: Arc<Waiting>,
}

/// How late a hook may run and still be worth running. A note about a message
/// that scrolled away two minutes ago is not an annotation, it is clutter, and
/// a badge that goes loud for it is worse — waiting to do either is what let
/// the queue grow without limit. #406, #408.
const HOOK_PATIENCE: Duration = Duration::from_secs(10);

/// A backstop on the memory rather than on the lateness: ten seconds of a
/// flood is thousands of messages, and they are held as clones until their
/// turn.
const HOOK_WAITING: usize = 128;

/// What is queued for a hook, per conversation.
///
/// Arrivals are kept apart rather than merged into one pile, because the shim
/// calls the plugin's handler once per message in the batch it is given: two
/// hundred messages in one call is two hundred times the work under one
/// deadline, which kills a plugin that was merely slow. Merging was tried and
/// is why this is a queue.
///
/// Keyed by hook as well as conversation, because the annotator and the
/// notification rule are different plugins doing different work at different
/// rates — one falling behind is no reason to hold the other up.
#[derive(Default)]
struct Waiting {
    inner: Mutex<WaitingInner>,
}

type Queue = (Hook, TargetName);

#[derive(Default)]
struct WaitingInner {
    arrivals: HashMap<Queue, VecDeque<(Instant, Vec<ArrivedMessage>)>>,
    /// Queues with a worker already draining them. Held under the same lock as
    /// `arrivals` so standing down and arriving cannot cross.
    draining: HashSet<Queue>,
    /// Messages a hook was never run for, so the log says how many rather than
    /// saying it per message.
    missed: HashMap<Queue, usize>,
}

impl Waiting {
    fn lock(&self) -> std::sync::MutexGuard<'_, WaitingInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Context {
    /// The plugin command this input names, with the conversation's recent
    /// messages attached if the plugin was granted them. The archive is not
    /// read at all otherwise.
    async fn plugin_call(
        &self,
        session: &SessionState,
        target: &str,
        input: &str,
    ) -> Option<PluginCall> {
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
        // A plugin asking for the conversation is asking for what was said,
        // which includes whatever the writer has not reached yet. This is the
        // only read here that waits for the archive, and it waits on the
        // plugin's own path rather than on the one that reads the socket.
        self.archive.drained().await;
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
                Action::Send { line, ticket } => {
                    if let Some(sender) = sender {
                        if let Err(error) = sender.send(line, ticket).await {
                            warn!(%error, "could not queue an outgoing line");
                        }
                    }
                }
                Action::Emit(event) => {
                    // Only worth building when a runtime exists: a network
                    // given `None` never looks, and this is the per-batch path.
                    let arrived = match event.as_ref() {
                        IrcxEvent::MessagesAppended {
                            target, messages, ..
                        } if self.plugins.is_some() => {
                            Some((target.clone(), plugins::spoken(messages)))
                        }
                        _ => None,
                    };
                    match event.as_ref() {
                        IrcxEvent::MessagesAppended { messages, .. } => {
                            self.persist(messages).await
                        }
                        // The three below reach a row a message already left.
                        // They queue behind its insert rather than flushing it
                        // first, which is the same guarantee by a shorter route
                        // — `update_message` on a message the archive does not
                        // hold silently does nothing, which is how a delivery
                        // state would go missing.
                        IrcxEvent::MessageUpdated { message } => self.update(message).await,
                        IrcxEvent::ReactionChanged {
                            message,
                            nick,
                            emoji,
                            active,
                            ..
                        } => self.record_reaction(message, nick, emoji, *active).await,
                        IrcxEvent::QueryRenamed { from, to, .. } => self.move_draft(from, to).await,
                        _ => {}
                    }
                    if self.events.send(*event).await.is_err() {
                        close = true;
                    }
                    // After the send, which is what makes the message drawn
                    // before any annotator runs.
                    if let Some((target, messages)) = arrived {
                        // A note is written against the row its message left,
                        // and the annotator's write goes through the same queue
                        // behind that row's insert, so it finds it there.
                        self.annotate(target, messages);
                    }
                }
                Action::Remember(target) => {
                    self.archive.remember(self.network.clone(), target).await;
                }
                Action::Forget(target) => {
                    self.archive.forget(self.network.clone(), target).await;
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
    ///
    /// One worker per conversation, and what arrives while it is busy waits for
    /// it rather than queueing a call of its own. Before #406 a live channel
    /// made one call per message — `append` emits one `MessagesAppended` per
    /// line — so an annotator slower than the channel fell behind by the
    /// difference, for every message, without limit: measured at 200ms of lag
    /// per message and twenty seconds behind after ten seconds of talking. The
    /// lag now settles at about one call, whatever the channel is doing, and
    /// the plugin sees the messages it missed in the batch it is handed, which
    /// is what `AnnotateRequest` carrying a `Vec` was always for.
    fn annotate(&self, target: TargetName, messages: Vec<ArrivedMessage>) {
        if messages.is_empty() {
            return;
        }
        if self.plugins.is_none() {
            return;
        }
        if self.queue(Hook::Annotate, &target, messages) {
            self.drain_annotations(target);
        }
    }

    /// Puts an arrival in a hook's queue, and says whether the caller has to
    /// start a worker for it.
    ///
    /// `false` means one is already running and will take this too, which is
    /// the whole of the backpressure: a conversation has one worker per hook
    /// however fast it is talking.
    fn queue(&self, hook: Hook, target: &TargetName, messages: Vec<ArrivedMessage>) -> bool {
        let key = (hook, target.clone());
        let mut waiting = self.waiting.lock();
        let queue = waiting.arrivals.entry(key.clone()).or_default();
        queue.push_back((Instant::now(), messages));
        let mut dropped = 0;
        while queue.len() > HOOK_WAITING {
            dropped += queue.pop_front().map_or(0, |(_, messages)| messages.len());
        }
        if dropped > 0 {
            *waiting.missed.entry(key.clone()).or_default() += dropped;
        }
        waiting.draining.insert(key)
    }

    /// The next arrival for a hook, or `None` once there is nothing left —
    /// which is also when the worker stands down.
    ///
    /// Anything that has waited longer than `HOOK_PATIENCE` is passed over and
    /// counted rather than run late.
    fn next_arrival(
        waiting: &Arc<Waiting>,
        hook: Hook,
        target: &TargetName,
    ) -> Option<Vec<ArrivedMessage>> {
        let key = (hook, target.clone());
        loop {
            let mut held = waiting.lock();
            let Some(queue) = held.arrivals.get_mut(&key) else {
                // Standing down inside the same lock the next arrival takes is
                // what stops one slipping between the check and the release
                // with nobody to run it.
                held.draining.remove(&key);
                return None;
            };
            let Some((arrived, messages)) = queue.pop_front() else {
                held.arrivals.remove(&key);
                held.draining.remove(&key);
                return None;
            };
            if arrived.elapsed() > HOOK_PATIENCE {
                *held.missed.entry(key.clone()).or_default() += messages.len();
                continue;
            }
            return Some(messages);
        }
    }

    /// What a hook never got to, said once at the end of a drain rather than
    /// per message.
    fn report_missed(waiting: &Arc<Waiting>, hook: Hook, target: &TargetName) {
        let missed = {
            let mut held = waiting.lock();
            held.missed.remove(&(hook, target.clone())).unwrap_or(0)
        };
        if missed > 0 {
            warn!(
                %target,
                hook = hook.doing(),
                missed,
                "a plugin fell far enough behind that messages were passed over"
            );
        }
    }

    /// Runs every annotator over whatever has piled up, until nothing has.
    fn drain_annotations(&self, target: TargetName) {
        let Some(runtime) = self.plugins.clone() else {
            return;
        };
        let strikes = Arc::clone(&self.strikes);
        let events = self.events.clone();
        let network = self.network.clone();
        let archive = self.archive.clone();
        let own_inbox = self.own_inbox.clone();
        let waiting_for = Arc::clone(&self.waiting);
        tokio::spawn(async move {
            loop {
                let Some(messages) = Self::next_arrival(&waiting_for, Hook::Annotate, &target)
                else {
                    Self::report_missed(&waiting_for, Hook::Annotate, &target);
                    return;
                };

                // Read each round rather than once: a plugin struck out while
                // this was working stops being asked.
                let annotators: Vec<_> = runtime
                    .annotators(&target)
                    .into_iter()
                    .filter(|annotator| {
                        out(&strikes, Hook::Annotate, &annotator.plugin) < HOOK_STRIKES
                    })
                    .collect();

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
                            if strike(&strikes, Hook::Annotate, &plugin, Some(&failure.failure)) {
                                let why = failure.failure.to_string();
                                report_stopped(&own_inbox, Hook::Annotate, &plugin, Some(why))
                                    .await;
                            }
                            continue;
                        }
                        Err(_) => {
                            if strike(&strikes, Hook::Annotate, &plugin, None) {
                                report_stopped(&own_inbox, Hook::Annotate, &plugin, None).await;
                            }
                            continue;
                        }
                    };
                    strike_cleared(&strikes, Hook::Annotate, &plugin);

                    for note in reply.notes {
                        // Written before it is sent, for the reason a reaction is:
                        // the archive is the only place a note outside the open
                        // window survives, and a conversation reopened tomorrow
                        // reads it back rather than running the annotator again.
                        archive
                            .annotation(
                                network.clone(),
                                note.message.clone(),
                                plugin.clone(),
                                note.text.clone(),
                            )
                            .await;
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
        if messages.is_empty() || self.plugins.is_none() {
            return;
        }
        if self.queue(Hook::Notify, &target, messages) {
            self.drain_notifications(target);
        }
    }

    /// Runs every rule over whatever has piled up, until nothing has. The
    /// annotator's twin, and bounded the same way and for the same reason: a
    /// badge that goes loud for a message from four minutes ago is not a
    /// notification. #408.
    fn drain_notifications(&self, target: TargetName) {
        let Some(runtime) = self.plugins.clone() else {
            return;
        };
        let strikes = Arc::clone(&self.strikes);
        let events = self.events.clone();
        let network = self.network.clone();
        let archive = self.archive.clone();
        let own_inbox = self.own_inbox.clone();
        let waiting_for = Arc::clone(&self.waiting);
        tokio::spawn(async move {
            loop {
                let Some(messages) = Self::next_arrival(&waiting_for, Hook::Notify, &target) else {
                    Self::report_missed(&waiting_for, Hook::Notify, &target);
                    return;
                };

                // Read each round rather than once: a rule struck out while this
                // was working stops being asked.
                let rules: Vec<_> = runtime
                    .notifiers(&target)
                    .into_iter()
                    .filter(|rule| out(&strikes, Hook::Notify, &rule.plugin) < HOOK_STRIKES)
                    .collect();

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
                    let ran =
                        tokio::task::spawn_blocking(move || running.notify(&rule, request)).await;

                    let reply = match ran {
                        Ok(Ok(reply)) => reply,
                        Ok(Err(failure)) => {
                            if strike(&strikes, Hook::Notify, &plugin, Some(&failure.failure)) {
                                let why = failure.failure.to_string();
                                report_stopped(&own_inbox, Hook::Notify, &plugin, Some(why)).await;
                            }
                            continue;
                        }
                        Err(_) => {
                            if strike(&strikes, Hook::Notify, &plugin, None) {
                                report_stopped(&own_inbox, Hook::Notify, &plugin, None).await;
                            }
                            continue;
                        }
                    };
                    strike_cleared(&strikes, Hook::Notify, &plugin);

                    for message in reply.raised {
                        // Written before it is sent, as a note is: the archive is
                        // where a raise outside the open window survives, so a
                        // conversation reopened tomorrow still shows what was worth
                        // reading in it.
                        archive
                            .raised(network.clone(), message.clone(), plugin.clone())
                            .await;
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
            }
        });
    }

    /// Holds what arrived rather than writing it, because each write is a
    /// transaction and a netsplit hands this one message at a time: 2,500
    /// quits were 2,500 commits, 444 ms of the 791 the burst cost (#328).
    ///
    /// What is held goes down when the incoming lines stop, so ordinary
    /// traffic — a line, then a quiet socket — is written as immediately as it
    /// was before. Only a burst coalesces, and a burst is the case where the
    /// window between arriving and being durable is worth having.
    /// Hands what arrived to the writer. Batching is its problem now, and the
    /// connection's part is one channel send.
    async fn persist(&self, messages: &[ChatMessage]) {
        self.archive.append(messages.to_vec()).await;
    }

    /// The words somebody was part way through, moved with the person they were
    /// for. Everything else about a renamed conversation moves in the frontend;
    /// this is the one piece that lives on disk.
    async fn move_draft(&self, from: &str, to: &str) {
        self.archive
            .move_draft(self.network.clone(), from.to_owned(), to.to_owned())
            .await;
    }

    /// The archive is the only place a reaction outside the open window
    /// survives, so it is written whether or not the message it names is here.
    async fn record_reaction(&self, message: &str, nick: &str, emoji: &str, active: bool) {
        self.archive
            .reaction(
                self.network.clone(),
                message.to_owned(),
                nick.to_owned(),
                emoji.to_owned(),
                active,
            )
            .await;
    }

    /// The archived copy was written while the message was still in flight, so
    /// a confirmation has to reach the row it left behind. It reaches it because
    /// the insert went through the same queue first, in order.
    async fn update(&self, message: &ChatMessage) {
        self.archive.update(message.clone()).await;
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
            assert!(
                !strike(&strikes, Hook::Annotate, "units", None),
                "a plugin still being called has not stopped"
            );
        }
        assert!(
            out(&strikes, Hook::Annotate, "units") < HOOK_STRIKES,
            "one bad batch is a message the plugin did not expect"
        );

        assert!(strike(&strikes, Hook::Annotate, "units", None));
        assert_eq!(out(&strikes, Hook::Annotate, "units"), HOOK_STRIKES);
    }

    /// The hook is filtered out once it is dropped, so a later strike is a
    /// batch already in flight rather than a second failure. Telling the user
    /// twice about one plugin would be the noise the strikes exist to stop.
    #[test]
    fn a_hook_stops_once_however_many_batches_were_in_flight() {
        let strikes = Mutex::new(HashMap::new());
        for _ in 0..HOOK_STRIKES {
            strike(&strikes, Hook::Notify, "deploys", None);
        }

        assert!(!strike(&strikes, Hook::Notify, "deploys", None));
        assert!(!strike(&strikes, Hook::Notify, "deploys", None));
    }

    /// The sentence has to name the plugin the user installed and what they
    /// have lost, or it is a status code with a name on it.
    #[test]
    fn what_stopped_says_which_plugin_and_what_it_was_doing() {
        let annotate = stopped_text(Hook::Annotate, "units");
        assert_eq!(
            annotate,
            "The units plugin failed 3 times in a row, so ircx stopped asking it to annotate \
             messages. Install it again from Plugins once it is fixed."
        );

        let notify = stopped_text(Hook::Notify, "deploys");
        assert!(notify.contains("deploys"));
        assert!(
            notify.contains("interrupting you"),
            "a rule that stopped is a different loss from a note that stopped: {notify}"
        );
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

    /// The task holds the strikes and the session holds the console, so a drop
    /// that does not cross between them is a drop nobody hears about.
    #[tokio::test]
    async fn a_dropped_hook_reaches_the_session_that_can_say_so() {
        let (inbox, mut session) = mpsc::channel(1);
        report_stopped(
            &inbox.downgrade(),
            Hook::Notify,
            "deploys",
            Some("TypeError: t.split is not a function".into()),
        )
        .await;

        let Ok(SessionCommand::PluginStopped { text, detail }) = session.try_recv() else {
            panic!("the session was never told the rule stopped");
        };
        assert!(text.contains("deploys"), "{text}");
        assert_eq!(
            detail.as_deref(),
            Some("TypeError: t.split is not a function")
        );
    }

    /// A batch can still be in flight when its network is torn down. Reaching
    /// for a session that has gone is the ordinary case there, not an error.
    #[tokio::test]
    async fn a_drop_with_no_session_left_is_quiet_rather_than_fatal() {
        let (inbox, session) = mpsc::channel::<SessionCommand>(1);
        let weak = inbox.downgrade();
        drop(inbox);
        drop(session);

        report_stopped(&weak, Hook::Annotate, "units", None).await;
    }

    /// A plugin repaired and installed again is not the code that failed, so
    /// the strikes against it must not outlive it. Both hooks, because which
    /// one broke is not something the user was ever shown.
    #[tokio::test]
    async fn a_plugin_that_changed_is_asked_again() {
        let mut strikes = HashMap::new();
        for hook in [Hook::Annotate, Hook::Notify] {
            strikes.insert((hook, "units".to_owned()), HOOK_STRIKES);
        }
        let context = context(Mutex::new(strikes));
        let mut session = SessionState::new(config());

        let actions = apply(
            SessionCommand::PluginChanged {
                plugin: "units".into(),
            },
            &mut session,
            &context,
        )
        .await;

        assert!(actions.is_empty(), "nothing is said about a plugin working");
        assert_eq!(out(&context.strikes, Hook::Annotate, "units"), 0);
        assert_eq!(out(&context.strikes, Hook::Notify, "units"), 0);
    }

    /// Only the plugin that changed. Installing one is not a statement about
    /// any other, and reviving a second broken plugin would put it back to
    /// failing on every message the channel carries.
    #[tokio::test]
    async fn changing_one_plugin_does_not_revive_another() {
        let mut strikes = HashMap::new();
        strikes.insert((Hook::Annotate, "units".to_owned()), HOOK_STRIKES);
        strikes.insert((Hook::Annotate, "links".to_owned()), HOOK_STRIKES);
        let context = context(Mutex::new(strikes));
        let mut session = SessionState::new(config());

        apply(
            SessionCommand::PluginChanged {
                plugin: "units".into(),
            },
            &mut session,
            &context,
        )
        .await;

        assert_eq!(out(&context.strikes, Hook::Annotate, "units"), 0);
        assert_eq!(out(&context.strikes, Hook::Annotate, "links"), HOOK_STRIKES);
    }

    fn context(strikes: Strikes) -> Context {
        let (events, _held) = mpsc::channel(8);
        let (inbox, _also_held) = mpsc::channel(8);
        let store = Arc::new(Store::open_in_memory().expect("an in-memory archive"));
        Context {
            network: "test".into(),
            archive: Archive::open(Arc::clone(&store)),
            store,
            events,
            plugins: None,
            strikes: Arc::new(strikes),
            own_inbox: inbox.downgrade(),
            waiting: Arc::new(Waiting::default()),
        }
    }

    fn config() -> SessionConfig {
        SessionConfig {
            network: "test".into(),
            name: "Test".into(),
            host: "127.0.0.1".into(),
            port: 6667,
            tls: false,
            tls_verify: false,
            client_certificate: None,
            nick: "ircx".into(),
            alt_nicks: Vec::new(),
            username: "ircx".into(),
            realname: "ircx".into(),
            sasl: None,
            connect_commands: Vec::new(),
            autojoin: Vec::new(),
        }
    }

    /// #328. A burst hands `persist` one message at a time and each write is a
    /// transaction, so what arrives is held and written when the lines stop.
    mod holding_a_burst {
        use super::*;
        use ircx_ipc::{Delivery, EncryptionState, MessageKind, MessageSource, Sender};

        fn said(id: &str) -> ChatMessage {
            ChatMessage {
                id: id.into(),
                id_is_local: false,
                via: None,
                network: "test".into(),
                target: "#burst".into(),
                kind: MessageKind::Privmsg,
                sender: Sender {
                    nick: "nyx".into(),
                    user: None,
                    host: None,
                    account: None,
                    is_self: false,
                },
                timestamp: "2026-08-02T13:00:00.000Z".into(),
                timestamp_is_local: false,
                text: "hello".into(),
                tags: Vec::new(),
                reply_to: None,
                batch: None,
                delivery: Delivery::Pending,
                attachments: Vec::new(),
                encryption: EncryptionState::Plaintext,
                raw: String::new(),
                source: MessageSource::Live,
                raised_by: Vec::new(),
                annotations: Vec::new(),
                reactions: Vec::new(),
            }
        }

        fn archived(context: &Context) -> Vec<ChatMessage> {
            context
                .store
                .load_history(&HistoryRequest {
                    network: "test".into(),
                    target: "#burst".into(),
                    before: None,
                    limit: 10_000,
                })
                .expect("read the archive")
        }

        /// What was handed over is down once the writer has been given the
        /// chance, and in the order it was handed over. Before #410 this
        /// asserted the opposite — that a burst was held on this task until
        /// something asked for it — which is the holding the writer replaced.
        #[tokio::test]
        async fn what_arrived_is_written_in_the_order_it_arrived() {
            let context = context(Strikes::default());
            for id in ["a", "b", "c"] {
                context.persist(&[said(id)]).await;
            }

            context.archive.drained().await;

            let held: Vec<String> = archived(&context).into_iter().map(|m| m.id).collect();
            assert_eq!(held, ["a", "b", "c"]);
        }

        /// A burst that never pauses used to be a list on this task, which a
        /// crash during one lost whole. Nothing asks for a pause now.
        #[tokio::test]
        async fn writes_a_long_burst_without_waiting_for_it_to_stop() {
            let context = context(Strikes::default());
            for i in 0..500 {
                context.persist(&[said(&format!("m{i}"))]).await;
            }

            context.archive.drained().await;

            assert_eq!(archived(&context).len(), 500);
        }

        /// `update_message` on a message the archive does not hold silently
        /// does nothing, so an echo arriving while its own message is still
        /// held would lose the delivery state it carries.
        #[tokio::test]
        async fn lets_an_echo_reach_a_message_still_held() {
            let context = context(Strikes::default());
            let mut settled = said("a");
            settled.delivery = Delivery::Delivered;

            context
                .deliver(
                    vec![
                        Action::Emit(Box::new(IrcxEvent::MessagesAppended {
                            network: "test".into(),
                            target: "#burst".into(),
                            messages: vec![said("a")],
                        })),
                        Action::Emit(Box::new(IrcxEvent::MessageUpdated {
                            message: Box::new(settled),
                        })),
                    ],
                    None,
                )
                .await;

            context.archive.drained().await;

            let held = archived(&context);
            assert_eq!(held.len(), 1);
            assert_eq!(held[0].delivery, Delivery::Delivered);
        }
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
