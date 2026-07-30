use std::sync::Arc;
use std::time::Duration;

use ircx_ipc::{
    Channel, ChatMessage, CommandOutcome, ConnectionStatus, IrcxEvent, Member, Network, NetworkId,
    Query, Severity, TargetName,
};
use ircx_net::{Backoff, BackoffPolicy, ConnectionConfig, LineSender, Transport, TransportEvent};
use ircx_store::Store;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio::time::{interval_at, Instant};
use tracing::warn;

use crate::session::{Action, SessionConfig, SessionState};

const COMMAND_QUEUE: usize = 64;
const KEEPALIVE: Duration = Duration::from_secs(120);

/// What the Tauri layer asks of a running network. Anything expecting an
/// answer carries the channel to send it back on.
pub enum SessionCommand {
    Submit {
        target: TargetName,
        input: String,
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
    let (commands, inbox) = mpsc::channel(COMMAND_QUEUE);
    let network = config.network.clone();
    let task = tokio::spawn(supervise(config, store, events, inbox));
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
) {
    let network = config.network.clone();
    let name = config.name.clone();
    let outcome = tokio::spawn(run(config, store, events.clone(), inbox)).await;

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
) {
    let endpoint = (
        config.host.clone(),
        config.port,
        config.tls,
        config.tls_verify,
    );
    let mut session = SessionState::new(config);
    let mut backoff = Backoff::new(BackoffPolicy::default());
    let context = Context { store, events };

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
                    Some(TransportEvent::Connected { .. }) => session.on_connected(),
                    Some(TransportEvent::Line(line)) => session.on_line(&line),
                    Some(TransportEvent::Disconnected { reason: why }) => {
                        reason = why.to_string();
                        break;
                    }
                    None => break,
                },
                command = inbox.recv() => match command {
                    Some(command) => apply(command, &mut session, &context),
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
                    let actions = apply(command, session, context);
                    if context.deliver(actions, None).await {
                        return false;
                    }
                }
                None => return false,
            },
        }
    }
}

fn apply(command: SessionCommand, session: &mut SessionState, context: &Context) -> Vec<Action> {
    match command {
        SessionCommand::Submit {
            target,
            input,
            reply,
        } => {
            let (outcome, actions) = session.submit(&target, &input);
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
        SessionCommand::Raw { line } => session.raw(&line),
        SessionCommand::Members { channel, reply } => {
            let _ = reply.send(session.members(&channel));
            Vec::new()
        }
        SessionCommand::Snapshot { reply } => {
            let _ = reply.send((session.snapshot(), session.channels(), session.queries()));
            Vec::new()
        }
        SessionCommand::Disconnect { reason } => session.quit(reason.as_deref()),
    }
}

struct Context {
    store: Arc<Store>,
    events: mpsc::Sender<IrcxEvent>,
}

impl Context {
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
                    if let IrcxEvent::MessagesAppended { messages, .. } = event.as_ref() {
                        self.persist(messages);
                    }
                    if self.events.send(*event).await.is_err() {
                        close = true;
                    }
                }
                Action::Close => close = true,
            }
        }
        close
    }

    fn persist(&self, messages: &[ChatMessage]) {
        if let Err(error) = self.store.append_messages(messages) {
            warn!(%error, "could not write messages to the archive");
        }
    }
}
