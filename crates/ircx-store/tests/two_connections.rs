//! What a second connection can get wrong, which one connection could not.
//!
//! #435 split `Store` into a writer and a reader so that a search stops queuing
//! behind an export. Everything in `store.rs` runs on `open_in_memory`, which
//! still has the one connection, so none of it exercises the split at all — an
//! archive on disk is the only shape with two.
//!
//! The risk the split introduces is staleness: a write commits on one
//! connection and a read on the other has to see it. Under WAL each statement
//! outside a transaction starts its own read transaction against the newest
//! commit, so it does; these are the cases that would say otherwise.

use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, Sender as Signal};
use std::sync::Arc;
use std::time::Duration;

use ircx_ipc::{
    ChatMessage, Delivery, EncryptionState, HistoryRequest, MessageKind, MessageSource,
    NetworkConfig, SearchRequest, Sender,
};
use ircx_store::{OpenTarget, Store};

fn message(id: &str, text: &str) -> ChatMessage {
    ChatMessage {
        id: id.into(),
        id_is_local: true,
        network: "libera".into(),
        target: "#two".into(),
        kind: MessageKind::Privmsg,
        sender: Sender {
            nick: "sykk".into(),
            user: None,
            host: None,
            account: None,
            is_self: false,
        },
        timestamp: "2026-01-01T00:00:00Z".into(),
        timestamp_is_local: false,
        text: text.into(),
        tags: vec![],
        reactions: vec![],
        annotations: vec![],
        raised_by: vec![],
        reply_to: None,
        batch: None,
        delivery: Delivery::Delivered,
        attachments: vec![],
        encryption: EncryptionState::Plaintext,
        via: None,
        raw: String::new(),
        source: MessageSource::Live,
    }
}

/// A real file, because that is what these tests are about — and no keyring,
/// because it is not. Saving a network reaches the credential store even with
/// no password to save, since it clears whatever was there before, and a runner
/// with no Secret Service answers that with a D-Bus error.
fn on_disk(room: &tempfile::TempDir) -> Store {
    Store::open_without_keyring(&room.path().join("ircx.sqlite3")).expect("an archive on disk")
}

fn search_for(query: &str) -> SearchRequest {
    SearchRequest {
        query: query.into(),
        network: None,
        target: None,
        sender: None,
        after: None,
        limit: 50,
    }
}

#[test]
fn a_message_written_on_one_connection_is_found_on_the_other() {
    let room = tempfile::tempdir().expect("a temp directory");
    let store = on_disk(&room);

    store
        .append_messages(&[message("m1", "a sentence worth finding")])
        .expect("the write commits");

    // Every one of these reads on the reader, and the write it has to see went
    // to the writer a moment ago.
    let found = store
        .search(&search_for("finding"))
        .expect("the search runs");
    assert_eq!(found.len(), 1, "the search missed a committed message");

    let history = store
        .load_history(&HistoryRequest {
            network: "libera".into(),
            target: "#two".into(),
            before: None,
            limit: 50,
        })
        .expect("the history loads");
    assert_eq!(history.len(), 1, "the history missed a committed message");

    assert_eq!(
        store.archive_size().expect("a size").messages,
        1,
        "the count missed a committed message"
    );

    let newest = store
        .newest_timestamp("libera", "#two")
        .expect("a timestamp query");
    assert!(newest.is_some(), "the watermark missed a committed message");
}

#[test]
fn a_message_deleted_on_one_connection_is_gone_on_the_other() {
    let room = tempfile::tempdir().expect("a temp directory");
    let store = on_disk(&room);

    store
        .append_messages(&[message("m1", "a sentence worth finding")])
        .expect("the write commits");
    store
        .delete_everything()
        .expect("the delete commits and vacuums");

    let found = store
        .search(&search_for("finding"))
        .expect("the search runs");
    assert!(
        found.is_empty(),
        "the search still answers from before the delete"
    );
    assert_eq!(store.archive_size().expect("a size").messages, 0);
}

#[test]
fn an_export_walks_what_was_written_a_moment_ago() {
    let room = tempfile::tempdir().expect("a temp directory");
    let store = on_disk(&room);

    store
        .append_messages(&[message("m1", "first"), message("m2", "second")])
        .expect("the write commits");

    // The exports are the reads that open a connection of their own, so they
    // are a third thing to get this wrong rather than a second.
    let mut everything = Vec::new();
    store
        .export_everything(&mut everything)
        .expect("the export runs");
    assert_eq!(
        everything.iter().filter(|byte| **byte == b'\n').count(),
        2,
        "the export missed a committed message"
    );

    let mut conversation = Vec::new();
    store
        .export_target("libera", "#two", &mut conversation)
        .expect("the export runs");
    assert_eq!(
        conversation.iter().filter(|byte| **byte == b'\n').count(),
        2
    );
}

#[test]
fn the_rest_of_what_the_reader_answers_is_current_too() {
    let room = tempfile::tempdir().expect("a temp directory");
    let store = on_disk(&room);

    let id = store
        .save_network(&NetworkConfig {
            id: None,
            name: "libera".into(),
            host: "irc.libera.chat".into(),
            port: 6697,
            tls: true,
            tls_verify: true,
            nick: "sykk".into(),
            alt_nicks: vec![],
            username: "sykk".into(),
            realname: "sykk".into(),
            sasl: None,
            connect_commands: vec![],
            autojoin: vec![],
            auto_connect: false,
            client_certificate: None,
        })
        .expect("the network saves");
    assert_eq!(
        store.list_networks().expect("the list reads").len(),
        1,
        "the network list missed a committed write"
    );

    store
        .remember_target(&id, &OpenTarget::Channel("#two".into()))
        .expect("the target saves");
    assert_eq!(store.open_targets(&id).expect("the targets read").len(), 1);

    store
        .set_draft(&id, "#two", "half a thought")
        .expect("saved");
    assert_eq!(
        store
            .get_draft(&id, "#two")
            .expect("the draft reads")
            .as_deref(),
        Some("half a thought"),
        "the draft read missed a committed write"
    );

    store
        .set_retention(&id, Some("#two"), Some(30))
        .expect("the rule saves");
    assert_eq!(
        store.retention(&id, Some("#two")).expect("the rule reads"),
        Some(Some(30))
    );
}

/// A destination that stops the export in the middle of writing and says so, so
/// that a test can hold an export open rather than race one.
struct Held {
    entered: Option<Signal<()>>,
    release: Option<Receiver<()>>,
}

impl Write for Held {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // Only the first line waits. The export is inside `write_all` for as
        // long as this takes, which is what the test needs it to be.
        if let (Some(entered), Some(release)) = (self.entered.take(), self.release.take()) {
            let _ = entered.send(());
            // Only so that a regression cannot hang a build forever; a passing
            // run never reaches the timeout at all.
            let _ = release.recv_timeout(Duration::from_secs(5));
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Half of #435, as a property rather than as a stopwatch: a search answers
/// while an export is still going.
///
/// `docs/measurements.md` has what the fix is worth in milliseconds. This
/// asserts the thing those milliseconds are evidence of, and no machine is fast
/// enough to pass it by accident — the export is held open until the search has
/// answered, so an export that finished first can only have finished because
/// the search was queued behind it.
///
/// **It guards the export's own connection and not the reader**, which is worth
/// knowing before trusting it too far. Point `walking` at the shared reader and
/// this fails; point `reading` at the writer and it still passes, because the
/// export is not on the writer either way. Holding a write open from a test
/// would need a hook in `Store` that nothing else wants, so what covers the
/// other half is the measurement and the staleness cases above.
#[test]
fn a_search_answers_while_an_export_is_still_going() {
    let room = tempfile::tempdir().expect("a temp directory");
    let store = Arc::new(on_disk(&room));
    store
        .append_messages(&[
            message("m1", "a sentence worth finding"),
            message("m2", "and another"),
        ])
        .expect("the write commits");

    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();

    let exporting = {
        let store = Arc::clone(&store);
        std::thread::spawn(move || {
            let mut out = Held {
                entered: Some(entered_tx),
                release: Some(release_rx),
            };
            store.export_everything(&mut out).expect("the export runs");
        })
    };

    // Not "the export has probably started" — it is inside `write`, and it
    // stays there until this test lets it out.
    entered_rx
        .recv_timeout(Duration::from_secs(30))
        .expect("the export reaches its first write");

    let found = store
        .search(&search_for("finding"))
        .expect("the search runs");
    assert_eq!(
        found.len(),
        1,
        "the search ran but answered the wrong thing"
    );
    assert!(
        !exporting.is_finished(),
        "the export finished before the search could answer, so the two serialised — \
         which is the fault #435 describes"
    );

    let _ = release_tx.send(());
    exporting.join().expect("the export thread");
}
