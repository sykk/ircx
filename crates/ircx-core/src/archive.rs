//! The archive, written from somewhere other than the connection.
//!
//! `Store` is one SQLite connection behind a mutex, shared by every network and
//! by every command the window runs. Before #410 the connection task took that
//! mutex itself on the path that reads the socket, so exporting an archive
//! stopped the client hearing anything for as long as the export took — the
//! delay measured as the operation, not a fraction of it, in
//! `tests/archive_lock.rs`.
//!
//! So the writes go to one task per network instead, and the connection hands
//! them over rather than doing them. What the connection waits for now is a
//! channel send, and the only thing that waits for the archive is a read that
//! has to see what was just said.
//!
//! **Order is the whole contract.** An update reaches a row its insert put
//! there, a note is written against a message the archive already holds, and a
//! reaction names one too. Every one of those went through `flush_archive()`
//! before, and goes through this queue now — a mutation that skipped it would
//! be a `update_message` on a row that is not there yet, which SQLite answers by
//! doing nothing at all.

use std::sync::Arc;

use ircx_ipc::{ChatMessage, NetworkId, TargetName};
use ircx_store::{OpenTarget, Store};
use tokio::sync::{mpsc, oneshot};
use tracing::warn;

/// How many changes may be waiting before the connection has to wait too.
///
/// It is a bound rather than a drop: an archive that quietly loses what was
/// said is worse than a client that pauses. Reaching it means the archive has
/// been busy for a very long time — an export of something enormous — and at
/// that point the old behaviour, waiting, is the honest one.
const QUEUE: usize = 4096;

/// One change to the archive, applied in the order it was asked for.
enum Change {
    Messages(Vec<ChatMessage>),
    Update(Box<ChatMessage>),
    Reaction {
        network: NetworkId,
        message: String,
        nick: String,
        emoji: String,
        active: bool,
    },
    Annotation {
        network: NetworkId,
        message: String,
        plugin: String,
        text: String,
    },
    Raised {
        network: NetworkId,
        message: String,
        plugin: String,
    },
    Remember {
        network: NetworkId,
        target: OpenTarget,
    },
    Forget {
        network: NetworkId,
        target: TargetName,
    },
    MoveDraft {
        network: NetworkId,
        from: String,
        to: String,
    },
    /// Answered once everything queued before it is down.
    Drained(oneshot::Sender<()>),
}

/// A handle on the writer. Cloning is cheap and every clone writes in the same
/// order, which is what the annotator's note depends on.
#[derive(Clone)]
pub(crate) struct Archive {
    changes: mpsc::Sender<Change>,
}

impl Archive {
    /// Starts the writer on a thread of its own, because every call it makes
    /// blocks and a blocked runtime thread is the thing this exists to avoid.
    pub(crate) fn open(store: Arc<Store>) -> Self {
        let (changes, queue) = mpsc::channel(QUEUE);
        std::thread::spawn(move || write_until_closed(&store, queue));
        Self { changes }
    }

    async fn ask(&self, change: Change) {
        // A closed queue means the writer is gone, which happens on shutdown
        // and nowhere else. Nothing left to write it to and nothing to say.
        let _ = self.changes.send(change).await;
    }

    pub(crate) async fn append(&self, messages: Vec<ChatMessage>) {
        if messages.is_empty() {
            return;
        }
        self.ask(Change::Messages(messages)).await;
    }

    pub(crate) async fn update(&self, message: ChatMessage) {
        self.ask(Change::Update(Box::new(message))).await;
    }

    pub(crate) async fn reaction(
        &self,
        network: NetworkId,
        message: String,
        nick: String,
        emoji: String,
        active: bool,
    ) {
        self.ask(Change::Reaction {
            network,
            message,
            nick,
            emoji,
            active,
        })
        .await;
    }

    pub(crate) async fn annotation(
        &self,
        network: NetworkId,
        message: String,
        plugin: String,
        text: String,
    ) {
        self.ask(Change::Annotation {
            network,
            message,
            plugin,
            text,
        })
        .await;
    }

    pub(crate) async fn raised(&self, network: NetworkId, message: String, plugin: String) {
        self.ask(Change::Raised {
            network,
            message,
            plugin,
        })
        .await;
    }

    pub(crate) async fn remember(&self, network: NetworkId, target: OpenTarget) {
        self.ask(Change::Remember { network, target }).await;
    }

    pub(crate) async fn forget(&self, network: NetworkId, target: TargetName) {
        self.ask(Change::Forget { network, target }).await;
    }

    pub(crate) async fn move_draft(&self, network: NetworkId, from: String, to: String) {
        self.ask(Change::MoveDraft { network, from, to }).await;
    }

    /// Waits for everything asked for so far to be written.
    ///
    /// What a read calls when it has to see what just arrived — a plugin being
    /// handed the conversation, and the last write before a session ends.
    /// Nothing on the path that reads the socket calls this.
    pub(crate) async fn drained(&self) {
        let (done, wait) = oneshot::channel();
        self.ask(Change::Drained(done)).await;
        let _ = wait.await;
    }
}

/// Consecutive arrivals are written together, so a burst costs one transaction
/// rather than one per line — which is what `ARCHIVE_BATCH` bought before, at
/// the price of holding messages on the connection task.
fn write_until_closed(store: &Store, mut queue: mpsc::Receiver<Change>) {
    while let Some(change) = queue.blocking_recv() {
        let mut batch = match change {
            Change::Messages(messages) => messages,
            other => {
                apply(store, other);
                continue;
            }
        };
        // Whatever else is already waiting, up to the next change of kind.
        loop {
            match queue.try_recv() {
                Ok(Change::Messages(more)) => batch.extend(more),
                Ok(other) => {
                    write_messages(store, &batch);
                    batch.clear();
                    apply(store, other);
                    break;
                }
                Err(_) => {
                    write_messages(store, &batch);
                    break;
                }
            }
        }
    }
}

fn write_messages(store: &Store, messages: &[ChatMessage]) {
    if messages.is_empty() {
        return;
    }
    if let Err(error) = store.append_messages(messages) {
        warn!(%error, "could not write messages to the archive");
    }
}

fn apply(store: &Store, change: Change) {
    match change {
        Change::Messages(messages) => write_messages(store, &messages),
        Change::Update(message) => {
            if let Err(error) = store.update_message(&message) {
                warn!(%error, "could not update a message in the archive");
            }
        }
        Change::Reaction {
            network,
            message,
            nick,
            emoji,
            active,
        } => {
            if let Err(error) = store.set_reaction(&network, &message, &nick, &emoji, active) {
                warn!(%error, "could not write a reaction to the archive");
            }
        }
        Change::Annotation {
            network,
            message,
            plugin,
            text,
        } => {
            if let Err(error) = store.set_annotation(&network, &message, &plugin, &text) {
                warn!(%error, "could not write an annotation to the archive");
            }
        }
        Change::Raised {
            network,
            message,
            plugin,
        } => {
            if let Err(error) = store.set_raised(&network, &message, &plugin) {
                warn!(%error, "could not write a raised message to the archive");
            }
        }
        Change::Remember { network, target } => {
            if let Err(error) = store.remember_target(&network, &target) {
                warn!(%error, "could not record an open conversation");
            }
        }
        Change::Forget { network, target } => {
            if let Err(error) = store.forget_target(&network, &target) {
                warn!(%error, "could not forget a conversation");
            }
        }
        Change::MoveDraft { network, from, to } => {
            if let Err(error) = store.move_draft(&network, &from, &to) {
                warn!(%error, "could not move a draft to the name its conversation now has");
            }
        }
        Change::Drained(done) => {
            let _ = done.send(());
        }
    }
}
