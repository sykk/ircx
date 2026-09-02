use ircx_ipc::{
    Annotation, Attachment, AttachmentPreview, ChatMessage, Delivery, EncryptionState,
    HistoryRequest, MessageKind, MessageSource, NetworkConfig, SaslConfig, SaslMechanism,
    SearchRequest, Sender,
};
use ircx_store::{OpenTarget, Store};

/// Old enough to fall outside any retention window used here.
const ANCIENT: &str = "2000-01-01T00:00:00Z";

/// Stands in for "just now" without pulling in a clock: no retention window
/// reaches into the future, so these messages always survive a prune.
const FUTURE: &str = "2999-01-01T00:00:00Z";

fn message(id: &str, target: &str, timestamp: &str, text: &str) -> ChatMessage {
    ChatMessage {
        id: id.into(),
        id_is_local: true,
        network: "libera".into(),
        target: target.into(),
        kind: MessageKind::Privmsg,
        sender: Sender {
            nick: "sykk".into(),
            user: None,
            host: None,
            account: None,
            is_self: false,
        },
        timestamp: timestamp.into(),
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

fn with_msgid(mut message: ChatMessage, msgid: &str) -> ChatMessage {
    message.tags.push(("msgid".into(), Some(msgid.into())));
    message.id = msgid.into();
    message.id_is_local = false;
    message
}

fn history(target: &str, before: Option<&str>, limit: u32) -> HistoryRequest {
    HistoryRequest {
        network: "libera".into(),
        target: target.into(),
        before: before.map(str::to_owned),
        before_id: None,
        limit,
    }
}

fn network(name: &str) -> NetworkConfig {
    NetworkConfig {
        id: None,
        name: name.into(),
        host: "irc.libera.chat".into(),
        port: 6697,
        tls: true,
        tls_verify: true,
        socks5_proxy: None,
        nick: "sykk".into(),
        alt_nicks: vec!["sykk_".into(), "sykk__".into()],
        username: "sykk".into(),
        realname: "sykk on ircx".into(),
        sasl: None,
        connect_commands: vec!["MODE sykk +i".into()],
        autojoin: vec!["#ircx".into()],
        auto_connect: true,
        client_certificate: None,
        quit_message: None,
        part_message: None,
        away_message: None,
    }
}

#[test]
fn store_is_send_and_sync() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Store>();
}

#[test]
fn a_round_trip_preserves_every_field() {
    let store = Store::open_in_memory().unwrap();
    let original = ChatMessage {
        id: "vDBRR1KcZTFf9pfJn5tsZQ".into(),
        id_is_local: false,
        network: "libera".into(),
        target: "#ircx".into(),
        kind: MessageKind::Action,
        sender: Sender {
            nick: "sykk".into(),
            user: Some("~sykk".into()),
            host: Some("user/sykk".into()),
            account: Some("sykk".into()),
            is_self: true,
        },
        timestamp: "2026-07-29T12:00:00.500Z".into(),
        timestamp_is_local: true,
        text: "waves at the channel".into(),
        tags: vec![
            ("msgid".into(), Some("vDBRR1KcZTFf9pfJn5tsZQ".into())),
            ("typing".into(), None),
            ("+draft/reply".into(), Some("other".into())),
        ],
        // Reactions are not part of the row: they are written by
        // `set_reaction` and read back from their own table.
        reactions: vec![],
        annotations: vec![],
        raised_by: vec![],
        reply_to: Some("earlier".into()),
        batch: Some("batch-1".into()),
        delivery: Delivery::Failed("no such channel".into()),
        attachments: vec![Attachment {
            url: "https://example.invalid/cat.png".into(),
            filename: Some("cat.png".into()),
            mime: Some("image/png".into()),
            size_bytes: Some(4096),
            preview: Some(AttachmentPreview {
                data_uri: "data:image/png;base64,AAAA".into(),
                width: 32,
                height: 16,
            }),
        }],
        encryption: EncryptionState::Plaintext,
        via: None,
        raw: "@msgid=vDBRR1KcZTFf9pfJn5tsZQ :sykk!~sykk@user/sykk PRIVMSG #ircx :\u{1}ACTION waves\u{1}"
            .into(),
        source: MessageSource::Live,
    };

    store
        .append_messages(std::slice::from_ref(&original))
        .unwrap();
    let loaded = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(loaded.len(), 1);
    let read = &loaded[0];

    assert_eq!(read.id, original.id);
    assert_eq!(read.id_is_local, original.id_is_local);
    assert_eq!(read.network, original.network);
    assert_eq!(read.target, original.target);
    assert_eq!(read.kind, original.kind);
    assert_eq!(read.sender.nick, original.sender.nick);
    assert_eq!(read.sender.user, original.sender.user);
    assert_eq!(read.sender.host, original.sender.host);
    assert_eq!(read.sender.account, original.sender.account);
    assert_eq!(read.sender.is_self, original.sender.is_self);
    assert_eq!(read.timestamp, original.timestamp);
    assert_eq!(read.timestamp_is_local, original.timestamp_is_local);
    assert_eq!(read.text, original.text);
    assert_eq!(read.tags, original.tags);
    assert_eq!(read.reply_to, original.reply_to);
    assert_eq!(read.batch, original.batch);
    assert_eq!(read.delivery, original.delivery);
    assert_eq!(read.encryption, original.encryption);
    assert_eq!(read.raw, original.raw);
    assert_eq!(read.source, MessageSource::LocalArchive);
    assert!(read.reactions.is_empty());

    assert_eq!(read.attachments.len(), 1);
    let (read_attachment, original_attachment) = (&read.attachments[0], &original.attachments[0]);
    assert_eq!(read_attachment.url, original_attachment.url);
    assert_eq!(read_attachment.filename, original_attachment.filename);
    assert_eq!(read_attachment.mime, original_attachment.mime);
    assert_eq!(read_attachment.size_bytes, original_attachment.size_bytes);
    let read_preview = read_attachment.preview.as_ref().unwrap();
    let original_preview = original_attachment.preview.as_ref().unwrap();
    assert_eq!(read_preview.data_uri, original_preview.data_uri);
    assert_eq!(read_preview.width, original_preview.width);
    assert_eq!(read_preview.height, original_preview.height);
}

#[test]
fn a_replayed_msgid_does_not_double_up() {
    let store = Store::open_in_memory().unwrap();
    let live = with_msgid(
        message("x", "#ircx", "2026-01-01T00:00:00Z", "hello"),
        "abc123",
    );

    // A chathistory replay of the same message: same msgid, later receipt
    // time, and text the server re-wrapped.
    let mut replayed = with_msgid(
        message("x", "#ircx", "2026-01-01T00:00:09Z", "hello"),
        "abc123",
    );
    replayed.raw = "replayed".into();

    store.append_messages(&[live, replayed]).unwrap();
    assert_eq!(
        store
            .load_history(&history("#ircx", None, 10))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn distinct_msgids_are_kept_apart() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            with_msgid(
                message("a", "#ircx", "2026-01-01T00:00:00Z", "hello"),
                "one",
            ),
            with_msgid(
                message("b", "#ircx", "2026-01-01T00:00:00Z", "hello"),
                "two",
            ),
        ])
        .unwrap();

    assert_eq!(
        store
            .load_history(&history("#ircx", None, 10))
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn messages_without_a_msgid_dedupe_on_content() {
    let store = Store::open_in_memory().unwrap();
    let first = message(
        "67e55044-10b1-426f-9247-bb680e5fe0c8",
        "#ircx",
        "2026-01-01T00:00:00Z",
        "hello",
    );
    let mut second = first.clone();
    second.id = "1a2b3c4d-10b1-426f-9247-bb680e5fe0c8".into();
    let mut different = first.clone();
    different.id = "2b3c4d5e-10b1-426f-9247-bb680e5fe0c8".into();
    different.text = "hello again".into();

    store.append_messages(&[first, second, different]).unwrap();

    let loaded = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(loaded.len(), 2);
    assert_eq!(loaded[0].id, "67e55044-10b1-426f-9247-bb680e5fe0c8");
}

/// One message from the Libera run: the id ircx minted, the time it wrote the
/// optimistic copy, and the name and time the server came back with.
const LOCAL_ID: &str = "06cd00f8-56d6-4f10-8bf5-1466a8ee9690";
const WROTE_AT: &str = "2026-07-30T11:05:10.289Z";
const SERVER_MSGID: &str = "11785409510340009285048AAHH6NIyN0ZXN0";
const SERVER_TIME: &str = "2026-07-30T11:05:10.340Z";

/// A message of our own between pressing enter and the echo coming back.
fn pending() -> ChatMessage {
    let mut message = message(LOCAL_ID, "##test", WROTE_AT, "please ignore");
    message.sender.is_self = true;
    message.timestamp_is_local = true;
    message.delivery = Delivery::Pending;
    message
}

/// The same message once the echo has named it.
fn confirmed() -> ChatMessage {
    let mut message = pending();
    message.delivery = Delivery::Delivered;
    message.timestamp = SERVER_TIME.into();
    message.timestamp_is_local = false;
    message.tags = vec![
        ("msgid".into(), Some(SERVER_MSGID.into())),
        ("time".into(), Some(SERVER_TIME.into())),
    ];
    message
}

#[test]
fn a_confirmed_delivery_reaches_the_row_the_pending_copy_left_behind() {
    let store = Store::open_in_memory().unwrap();
    store.append_messages(&[pending()]).unwrap();
    store.update_message(&confirmed()).unwrap();

    let rows = store.load_history(&history("##test", None, 10)).unwrap();
    assert_eq!(rows.len(), 1, "a confirmation updates, it does not append");
    assert_eq!(rows[0].delivery, Delivery::Delivered);
    assert_eq!(rows[0].id, LOCAL_ID, "the id the UI drew it with is kept");
    assert!(rows[0].id_is_local);
    assert_eq!(rows[0].timestamp, SERVER_TIME);
    assert!(!rows[0].timestamp_is_local);
}

#[test]
fn a_replay_of_a_message_we_sent_is_recognised_by_its_msgid() {
    let store = Store::open_in_memory().unwrap();
    store.append_messages(&[pending()]).unwrap();
    store.update_message(&confirmed()).unwrap();

    // What a `chathistory` backfill of the same conversation carries: the
    // server's id and time, and none of our local ones.
    let replayed = with_msgid(
        message("ignored", "##test", SERVER_TIME, "please ignore"),
        SERVER_MSGID,
    );
    store.append_messages(&[replayed]).unwrap();

    let rows = store.load_history(&history("##test", None, 10)).unwrap();
    assert_eq!(rows.len(), 1, "the user's own history is not doubled");
    assert_eq!(rows[0].id, LOCAL_ID);
}

#[test]
fn confirming_a_message_the_archive_never_took_changes_nothing() {
    let store = Store::open_in_memory().unwrap();
    store.update_message(&confirmed()).unwrap();

    assert!(store
        .load_history(&history("##test", None, 10))
        .unwrap()
        .is_empty());
}

#[test]
fn history_pages_backwards_across_a_boundary() {
    let store = Store::open_in_memory().unwrap();
    let messages: Vec<ChatMessage> = (0..5)
        .map(|index| {
            message(
                &format!("id-{index}"),
                "#ircx",
                &format!("2026-01-01T00:00:0{index}Z"),
                &format!("line {index}"),
            )
        })
        .collect();
    store.append_messages(&messages).unwrap();

    let newest = store.load_history(&history("#ircx", None, 2)).unwrap();
    assert_eq!(
        newest.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["line 3", "line 4"]
    );

    let older = store
        .load_history(&history("#ircx", Some(&newest[0].timestamp), 2))
        .unwrap();
    assert_eq!(
        older.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["line 1", "line 2"]
    );

    let oldest = store
        .load_history(&history("#ircx", Some(&older[0].timestamp), 2))
        .unwrap();
    assert_eq!(
        oldest.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["line 0"]
    );

    assert!(store
        .load_history(&history("#ircx", Some(&oldest[0].timestamp), 2))
        .unwrap()
        .is_empty());
}

/// #619. A channel can say a dozen things inside one millisecond, and the
/// archive orders them by rowid afterwards — so a page boundary landing in the
/// middle of such a run is a boundary a timestamp cannot name. Asked with the
/// timestamp alone, the store answered from before the whole run and the
/// messages between were behind a bound that had moved past them: still in the
/// archive, unreachable by anything the pane could ask.
#[test]
fn history_pages_from_inside_one_millisecond() {
    let store = Store::open_in_memory().unwrap();
    const CROWDED: &str = "2026-01-01T00:00:03.500Z";
    let messages: Vec<ChatMessage> = (0..10)
        .map(|index| {
            let timestamp = match index {
                3..=7 => CROWDED.to_string(),
                _ => format!("2026-01-01T00:00:0{index}.000Z"),
            };
            message(
                &format!("id-{index}"),
                "#ircx",
                &timestamp,
                &format!("line {index}"),
            )
        })
        .collect();
    store.append_messages(&messages).unwrap();

    let newest = store.load_history(&history("#ircx", None, 3)).unwrap();
    assert_eq!(
        newest.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["line 7", "line 8", "line 9"]
    );

    // The oldest message held is `line 7`, four of whose neighbours share its
    // millisecond. The page behind it is those four, not what came before them.
    let older = store
        .load_history(&HistoryRequest {
            before_id: Some(newest[0].id.clone()),
            ..history("#ircx", Some(&newest[0].timestamp), 3)
        })
        .unwrap();
    assert_eq!(
        older.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["line 4", "line 5", "line 6"]
    );

    // And paging on reaches every message once, which is the assertion the
    // ends of a page cannot make on their own.
    let mut walked: Vec<String> = vec![older[0].text.clone()];
    let mut boundary = Some(older[0].clone());
    while let Some(oldest) = boundary {
        let page = store
            .load_history(&HistoryRequest {
                before_id: Some(oldest.id.clone()),
                ..history("#ircx", Some(&oldest.timestamp), 3)
            })
            .unwrap();
        boundary = page.first().cloned();
        let mut earlier: Vec<String> = page.iter().map(|m| m.text.clone()).collect();
        earlier.extend(walked);
        walked = earlier;
    }
    assert_eq!(
        walked,
        (0..=4)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
    );
}

/// A page asked for from a message the archive does not hold — one still on
/// its way to disk, or one the server replayed and nothing wrote down — is
/// answered by the timestamp alone, which is what this did before there was an
/// id to send.
#[test]
fn history_pages_from_a_message_the_archive_has_never_seen() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message("a", "#ircx", "2026-01-01T00:00:00Z", "said"),
            message("b", "#ircx", "2026-01-01T00:00:01Z", "and said"),
        ])
        .unwrap();

    let page = store
        .load_history(&HistoryRequest {
            before_id: Some("never-archived".into()),
            ..history("#ircx", Some("2026-01-01T00:00:01Z"), 10)
        })
        .unwrap();

    assert_eq!(
        page.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["said"]
    );
}

#[test]
fn history_is_scoped_to_one_target() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message("a", "#ircx", "2026-01-01T00:00:00Z", "in channel"),
            message("b", "sykk", "2026-01-01T00:00:01Z", "in query"),
        ])
        .unwrap();

    let loaded = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].text, "in channel");
}

#[test]
fn search_marks_the_match_and_filters_by_target() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message(
                "a",
                "#ircx",
                "2026-01-01T00:00:00Z",
                "the migration runner applies anything newer",
            ),
            message("b", "#other", "2026-01-01T00:00:01Z", "migration elsewhere"),
            message("c", "#ircx", "2026-01-01T00:00:02Z", "nothing to see"),
        ])
        .unwrap();

    let hits = store
        .search(&SearchRequest {
            query: "migration".into(),
            network: None,
            target: None,
            sender: None,
            after: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits[0].snippet.contains("<mark>migration</mark>"));
    // Newest first.
    assert_eq!(hits[0].message.target, "#other");
    assert_eq!(hits[0].message.source, MessageSource::LocalArchive);

    let scoped = store
        .search(&SearchRequest {
            query: "migration".into(),
            network: Some("libera".into()),
            target: Some("#ircx".into()),
            sender: None,
            after: None,
            limit: 10,
        })
        .unwrap();
    assert_eq!(scoped.len(), 1);
    assert_eq!(scoped[0].message.target, "#ircx");

    let missing = store
        .search(&SearchRequest {
            query: "absent".into(),
            network: None,
            target: None,
            sender: None,
            after: None,
            limit: 10,
        })
        .unwrap();
    assert!(missing.is_empty());
}

#[test]
fn search_filters_by_sender_and_time_before_limiting() {
    let store = Store::open_in_memory().unwrap();
    let mut wanted = message("wanted", "#ircx", "2026-02-01T00:00:00Z", "deploy_marker");
    wanted.sender.nick = "sable".into();
    let mut too_old = message("old", "#ircx", "2025-02-01T00:00:00Z", "deploy_marker");
    too_old.sender.nick = "sable".into();
    let mut other_sender = message("other", "#ircx", "2026-03-01T00:00:00Z", "deploy_marker");
    other_sender.sender.nick = "moss".into();
    store
        .append_messages(&[wanted, too_old, other_sender])
        .unwrap();

    for query in ["deploy", "_"] {
        let hits = store
            .search(&SearchRequest {
                query: query.into(),
                network: None,
                target: None,
                sender: Some("SABLE".into()),
                after: Some("2026-01-01T00:00:00Z".into()),
                limit: 1,
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message.id, "wanted");
    }
}

#[test]
fn bookmarks_are_idempotent_and_scoped() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message("a", "#ircx", FUTURE, "save this"),
            message("b", "#other", FUTURE, "not this"),
        ])
        .unwrap();

    assert!(store.set_bookmark("libera", "#IRCX", "a", true).unwrap());
    assert!(store.set_bookmark("libera", "#ircx", "a", true).unwrap());
    let hits = store.bookmarks(Some("libera"), Some("#ircx"), 10).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].message.id, "a");
    assert_eq!(hits[0].snippet, "save this");
    assert_eq!(hits[0].note, None);

    assert!(store
        .set_bookmark_note("libera", "#IRCX", "a", "Check the fix")
        .unwrap());
    let hits = store.bookmarks(Some("libera"), Some("#ircx"), 10).unwrap();
    assert_eq!(hits[0].note.as_deref(), Some("Check the fix"));
    assert!(!store
        .set_bookmark_note("libera", "#ircx", "missing", "Lost")
        .unwrap());

    assert!(store.set_bookmark("libera", "#ircx", "a", false).unwrap());
    assert!(store.bookmarks(None, None, 10).unwrap().is_empty());
    assert!(!store
        .set_bookmark("libera", "#ircx", "missing", true)
        .unwrap());
}

#[test]
fn history_around_centers_the_named_archived_message() {
    let store = Store::open_in_memory().unwrap();
    let messages = (0..7)
        .map(|index| {
            message(
                &format!("message-{index}"),
                "#ircx",
                &format!("2026-01-01T00:00:0{index}Z"),
                &format!("line {index}"),
            )
        })
        .collect::<Vec<_>>();
    store.append_messages(&messages).unwrap();

    let window = store
        .load_history_around("libera", "#ircx", "message-3", 5)
        .unwrap();

    assert_eq!(
        window
            .iter()
            .map(|message| message.id.as_str())
            .collect::<Vec<_>>(),
        [
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5"
        ]
    );
}

#[test]
fn search_does_not_see_deleted_messages() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message(
            "a",
            "#ircx",
            "2026-01-01T00:00:00Z",
            "ephemeral chatter",
        )])
        .unwrap();
    store.delete_target("libera", "#ircx").unwrap();

    let hits = store
        .search(&SearchRequest {
            query: "ephemeral".into(),
            network: None,
            target: None,
            sender: None,
            after: None,
            limit: 10,
        })
        .unwrap();
    assert!(hits.is_empty());
}

/// Before the fix each of these was either an error where the results belong
/// or a search for something the user did not ask for.
#[test]
fn punctuation_and_operators_are_searched_for_rather_than_obeyed() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message(
                "a",
                "#ircx",
                "2026-01-01T00:00:00Z",
                "ircx end-to-end run, please ignore",
            ),
            message(
                "b",
                "#ircx",
                "2026-01-01T00:00:01Z",
                "she said \"hello\" and left",
            ),
            message("c", "#ircx", "2026-01-01T00:00:02Z", "end of the story"),
        ])
        .unwrap();

    let found = |query: &str| {
        store
            .search(&SearchRequest {
                query: query.into(),
                network: None,
                target: None,
                sender: None,
                after: None,
                limit: 10,
            })
            .unwrap_or_else(|err| panic!("searching for {query:?} failed: {err}"))
            .into_iter()
            .map(|hit| hit.message.id)
            .collect::<Vec<_>>()
    };

    // The search from the live run: FTS5 read the hyphens as NOT and `to` as
    // a column name, and the archive answered "no such column: to".
    assert_eq!(found("end-to-end"), ["a"]);
    // Quotes, matched or not, are characters in the text being looked for.
    assert_eq!(found("\"hello\""), ["b"]);
    assert_eq!(found("said \"hello"), ["b"]);
    // A lone quote is a character somebody typed. No index can answer it — it
    // tokenises to nothing and is one character long — so the scan does, and
    // finds the message with a quote in it rather than nothing at all. #378.
    assert_eq!(found("\""), ["b"]);
    // A bare operator is a word: `AND` used to be a syntax error.
    assert_eq!(found("AND"), ["b"]);
    // A column filter and a prefix star are neither.
    assert!(found("text:end").is_empty());
    assert!(found("ign*").is_empty());
    // Every word has to appear, in any order.
    assert_eq!(found("ignore run"), ["a"]);
    assert!(found("ignore missing").is_empty());
}

#[test]
fn an_empty_search_finds_nothing_rather_than_failing() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message("a", "#ircx", "2026-01-01T00:00:00Z", "something")])
        .unwrap();

    let hits = store
        .search(&SearchRequest {
            query: "   ".into(),
            network: None,
            target: None,
            sender: None,
            after: None,
            limit: 10,
        })
        .unwrap();

    assert!(hits.is_empty());
}

#[test]
fn prune_honours_the_target_override() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message("a", "#ircx", ANCIENT, "old and expendable"),
            message("b", "#ircx", FUTURE, "recent"),
            message("c", "#keep", ANCIENT, "old but kept"),
            message("d", "#trim", ANCIENT, "old and trimmed harder"),
        ])
        .unwrap();

    store.set_retention("libera", None, Some(30)).unwrap();
    store.set_retention("libera", Some("#keep"), None).unwrap();
    store
        .set_retention("libera", Some("#trim"), Some(1))
        .unwrap();

    assert_eq!(store.prune().unwrap(), 2);
    assert!(
        store
            .load_history(&history("#keep", None, 10))
            .unwrap()
            .len()
            == 1
    );
    assert!(store
        .load_history(&history("#trim", None, 10))
        .unwrap()
        .is_empty());
    let remaining = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].text, "recent");

    assert_eq!(store.prune().unwrap(), 0);
}

/// IRC compares targets without case and rows written before #190 hold
/// whichever casing arrived, so `load_history` matches without case — but the
/// destructive and bulk paths matched exactly. Deleting "#chan" left rows
/// archived as "#Chan" standing, and the display then showed the very rows
/// the user had just watched being deleted; a retention window and a
/// keep-nothing rule missed them the same way.
mod a_target_is_one_conversation_whatever_its_casing {
    use super::*;

    #[test]
    fn deleting_it_takes_the_other_casings_with_it() {
        let store = Store::open_in_memory().unwrap();
        store
            .append_messages(&[message("a", "#Chan", "2026-01-01T00:00:00Z", "hello")])
            .unwrap();

        store.delete_target("libera", "#chan").unwrap();

        assert!(store
            .load_history(&history("#chan", None, 10))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_retention_window_reaches_rows_archived_under_another_casing() {
        let store = Store::open_in_memory().unwrap();
        store
            .append_messages(&[message("a", "#Chan", ANCIENT, "old")])
            .unwrap();
        store
            .set_retention("libera", Some("#chan"), Some(30))
            .unwrap();

        assert_eq!(store.prune().unwrap(), 1);
    }

    #[test]
    fn keep_nothing_suppresses_whichever_casing_the_wire_uses() {
        let store = Store::open_in_memory().unwrap();
        store
            .set_retention("libera", Some("#chan"), Some(0))
            .unwrap();
        store
            .append_messages(&[message("a", "#Chan", "2026-01-01T00:00:00Z", "hello")])
            .unwrap();

        assert!(store
            .load_history(&history("#chan", None, 10))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_search_filtered_to_it_sees_every_casing() {
        let store = Store::open_in_memory().unwrap();
        store
            .append_messages(&[message(
                "a",
                "#Chan",
                "2026-01-01T00:00:00Z",
                "findable words",
            )])
            .unwrap();

        let hits = store
            .search(&SearchRequest {
                query: "findable".into(),
                network: None,
                target: Some("#chan".into()),
                sender: None,
                after: None,
                limit: 10,
            })
            .unwrap();

        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn an_export_of_it_carries_every_casing() {
        let store = Store::open_in_memory().unwrap();
        store
            .append_messages(&[message("a", "#Chan", "2026-01-01T00:00:00Z", "kept words")])
            .unwrap();

        let mut out = Vec::new();
        store.export_target("libera", "#chan", &mut out).unwrap();

        assert!(String::from_utf8(out).unwrap().contains("kept words"));
    }
}

/// What a message owned goes with it. Only `delete_everything` cleared the
/// reactions, annotations and raised tables, so a retention window or a
/// per-conversation delete left who-reacted-with-what and a plugin's
/// paraphrase of the message on disk forever — and a message archived again
/// later under the same msgid was haunted by them. A row waiting for a
/// message the archive never held is a different thing and still waits;
/// arrival-before-archive is why these tables have no foreign key.
mod what_a_deleted_message_owned {
    use super::*;

    fn haunted(store: &Store) -> ChatMessage {
        let message = with_msgid(
            message("m", "#ircx", "2026-01-01T00:00:00Z", "hello"),
            "msgid-1",
        );
        store
            .append_messages(std::slice::from_ref(&message))
            .unwrap();
        store
            .set_reaction("libera", "msgid-1", "nick2", "lol", true)
            .unwrap();
        store
            .set_annotation("libera", "msgid-1", "translator", "a paraphrase")
            .unwrap();
        store.set_raised("libera", "msgid-1", "urgency").unwrap();
        message
    }

    fn archived_again(store: &Store, message: &ChatMessage) -> ChatMessage {
        store
            .append_messages(std::slice::from_ref(message))
            .unwrap();
        let held = store.load_history(&history("#ircx", None, 10)).unwrap();
        assert_eq!(held.len(), 1);
        held.into_iter().next().unwrap()
    }

    fn mark_by_local_id(store: &Store, message: &ChatMessage) {
        store
            .set_annotation("libera", &message.id, "translator", "a paraphrase")
            .unwrap();
        store.set_raised("libera", &message.id, "urgency").unwrap();
    }

    #[test]
    fn goes_with_a_deleted_conversation() {
        let store = Store::open_in_memory().unwrap();
        let message = haunted(&store);

        store.delete_target("libera", "#ircx").unwrap();

        let read = archived_again(&store, &message);
        assert!(read.reactions.is_empty(), "{:?}", read.reactions);
        assert!(read.annotations.is_empty(), "{:?}", read.annotations);
        assert!(read.raised_by.is_empty(), "{:?}", read.raised_by);
    }

    #[test]
    fn goes_with_a_deleted_network_archive() {
        let store = Store::open_in_memory().unwrap();
        let deleted = haunted(&store);
        let mut elsewhere = with_msgid(
            message("o", "#other", "2026-01-01T00:01:00Z", "still here"),
            "msgid-2",
        );
        elsewhere.network = "oftc".into();
        store
            .append_messages(std::slice::from_ref(&elsewhere))
            .unwrap();
        store
            .set_reaction("oftc", "msgid-2", "nick2", "yes", true)
            .unwrap();

        store.delete_network_archive("libera").unwrap();

        let read = archived_again(&store, &deleted);
        assert!(read.reactions.is_empty(), "{:?}", read.reactions);
        assert!(read.annotations.is_empty(), "{:?}", read.annotations);
        assert!(read.raised_by.is_empty(), "{:?}", read.raised_by);
        let mut request = history("#other", None, 10);
        request.network = "oftc".into();
        let held = store.load_history(&request).unwrap();
        assert_eq!(held[0].reactions.len(), 1);
    }

    #[test]
    fn goes_with_a_retention_expiry() {
        let store = Store::open_in_memory().unwrap();
        let old = with_msgid(message("m", "#ircx", ANCIENT, "hello"), "msgid-1");
        store.append_messages(std::slice::from_ref(&old)).unwrap();
        store
            .set_reaction("libera", "msgid-1", "nick2", "lol", true)
            .unwrap();
        store.set_retention("libera", None, Some(30)).unwrap();

        assert_eq!(store.prune().unwrap(), 1);

        let read = archived_again(&store, &old);
        assert!(read.reactions.is_empty(), "{:?}", read.reactions);
    }

    #[test]
    fn local_id_marks_go_with_a_deleted_conversation() {
        let store = Store::open_in_memory().unwrap();
        let message = message("local-1", "#ircx", "2026-01-01T00:00:00Z", "hello");
        store
            .append_messages(std::slice::from_ref(&message))
            .unwrap();
        mark_by_local_id(&store, &message);

        store.delete_target("libera", "#ircx").unwrap();

        let read = archived_again(&store, &message);
        assert!(read.annotations.is_empty(), "{:?}", read.annotations);
        assert!(read.raised_by.is_empty(), "{:?}", read.raised_by);
    }

    #[test]
    fn local_id_marks_go_with_a_retention_expiry() {
        let store = Store::open_in_memory().unwrap();
        let old = message("local-1", "#ircx", ANCIENT, "hello");
        store.append_messages(std::slice::from_ref(&old)).unwrap();
        mark_by_local_id(&store, &old);
        store.set_retention("libera", None, Some(30)).unwrap();

        assert_eq!(store.prune().unwrap(), 1);

        let read = archived_again(&store, &old);
        assert!(read.annotations.is_empty(), "{:?}", read.annotations);
        assert!(read.raised_by.is_empty(), "{:?}", read.raised_by);
    }

    #[test]
    fn confirmed_self_message_cleans_both_local_and_server_keys() {
        let store = Store::open_in_memory().unwrap();
        let mut message = message("local-1", "#ircx", "2026-01-01T00:00:00Z", "hello");
        message.sender.is_self = true;
        message.tags.push(("msgid".into(), Some("server-1".into())));
        store
            .append_messages(std::slice::from_ref(&message))
            .unwrap();
        store
            .set_reaction("libera", "server-1", "nick2", "lol", true)
            .unwrap();
        mark_by_local_id(&store, &message);

        store.delete_target("libera", "#ircx").unwrap();

        let read = archived_again(&store, &message);
        assert!(read.reactions.is_empty(), "{:?}", read.reactions);
        assert!(read.annotations.is_empty(), "{:?}", read.annotations);
        assert!(read.raised_by.is_empty(), "{:?}", read.raised_by);
    }

    #[test]
    fn a_row_still_waiting_for_its_message_keeps_waiting() {
        let store = Store::open_in_memory().unwrap();
        // A reaction to a message this archive has never held.
        store
            .set_reaction("libera", "not-here-yet", "nick2", "lol", true)
            .unwrap();
        haunted(&store);

        store.delete_target("libera", "#ircx").unwrap();

        // The awaited message arrives at last; its reaction is still there.
        let awaited = with_msgid(
            message("w", "#other", "2026-01-01T00:00:00Z", "worth waiting for"),
            "not-here-yet",
        );
        store
            .append_messages(std::slice::from_ref(&awaited))
            .unwrap();
        let held = store.load_history(&history("#other", None, 10)).unwrap();
        assert_eq!(held[0].reactions.len(), 1);
    }
}

#[test]
fn a_network_without_retention_keeps_everything() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message("a", "#ircx", ANCIENT, "old")])
        .unwrap();

    assert_eq!(store.prune().unwrap(), 0);
    assert_eq!(
        store
            .load_history(&history("#ircx", None, 10))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn drafts_upsert_and_clear() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.get_draft("libera", "#ircx").unwrap(), None);

    store
        .set_draft("libera", "#ircx", "half a thought")
        .unwrap();
    store.set_draft("libera", "#ircx", "a whole one").unwrap();
    assert_eq!(
        store.get_draft("libera", "#ircx").unwrap().as_deref(),
        Some("a whole one")
    );
    assert_eq!(store.get_draft("libera", "#other").unwrap(), None);

    store.set_draft("libera", "#ircx", "").unwrap();
    assert_eq!(store.get_draft("libera", "#ircx").unwrap(), None);
}

#[test]
fn drafts_list_without_exposing_their_text() {
    let store = Store::open_in_memory().unwrap();
    store
        .set_draft("libera", "#ircx", "half a thought")
        .unwrap();
    store.set_draft("oftc", "sable", "private words").unwrap();

    let mut drafts = store.list_drafts().unwrap();
    drafts.sort();
    assert_eq!(
        drafts,
        [
            ("libera".into(), "#ircx".into()),
            ("oftc".into(), "sable".into())
        ]
    );
}

#[test]
fn networks_round_trip_without_the_password() {
    let store = Store::open_in_memory().unwrap();
    let mut config = network("Libera");
    config.socks5_proxy = Some("proxy.example.com:1080".into());
    config.quit_message = Some("later".into());
    config.part_message = Some("off to lunch".into());
    config.away_message = Some("in a meeting".into());
    config.sasl = Some(SaslConfig {
        mechanism: SaslMechanism::Plain,
        account: "sykk".into(),
        password: Some("hunter2".into()),
    });

    let id = store.save_network(&config).unwrap();
    let networks = store.list_networks().unwrap();
    assert_eq!(networks.len(), 1);
    let saved = &networks[0];

    assert_eq!(saved.id.as_deref(), Some(id.as_str()));
    assert_eq!(saved.name, config.name);
    assert_eq!(saved.host, config.host);
    assert_eq!(saved.port, config.port);
    assert_eq!(saved.tls, config.tls);
    assert_eq!(saved.tls_verify, config.tls_verify);
    assert_eq!(saved.socks5_proxy, config.socks5_proxy);
    assert_eq!(saved.nick, config.nick);
    assert_eq!(saved.alt_nicks, config.alt_nicks);
    assert_eq!(saved.username, config.username);
    assert_eq!(saved.realname, config.realname);
    assert_eq!(saved.connect_commands, config.connect_commands);
    assert_eq!(saved.autojoin, config.autojoin);
    assert_eq!(saved.auto_connect, config.auto_connect);
    assert_eq!(saved.client_certificate, config.client_certificate);
    assert_eq!(saved.quit_message, config.quit_message);
    assert_eq!(saved.part_message, config.part_message);
    assert_eq!(saved.away_message, config.away_message);

    let sasl = saved.sasl.as_ref().unwrap();
    assert_eq!(sasl.mechanism, SaslMechanism::Plain);
    assert_eq!(sasl.account, "sykk");
    assert_eq!(sasl.password, None);
    assert_eq!(
        store.sasl_password(&id).unwrap().as_deref(),
        Some("hunter2")
    );
}

#[test]
fn an_sts_policy_is_scoped_to_the_hostname_and_expires() {
    let store = Store::open_in_memory().unwrap();
    store
        .save_sts_policy("irc.example.com", Some(6697), 2_000)
        .unwrap();

    assert_eq!(
        store.sts_policy("IRC.EXAMPLE.COM", 1_999).unwrap(),
        Some(ircx_store::StsPolicy {
            port: Some(6697),
            expires_at: 2_000,
        })
    );
    assert_eq!(store.sts_policy("irc.example.com", 2_000).unwrap(), None);
    assert_eq!(store.sts_policy("other.example.com", 1_999).unwrap(), None);
}

#[test]
fn an_sts_policy_can_be_replaced_and_removed() {
    let store = Store::open_in_memory().unwrap();
    store
        .save_sts_policy("irc.example.com", Some(6697), 2_000)
        .unwrap();
    store
        .save_sts_policy("irc.example.com", None, 3_000)
        .unwrap();

    assert_eq!(
        store.sts_policy("irc.example.com", 2_500).unwrap(),
        Some(ircx_store::StsPolicy {
            port: None,
            expires_at: 3_000,
        })
    );
    store.delete_sts_policy("irc.example.com").unwrap();
    assert_eq!(store.sts_policy("irc.example.com", 2_500).unwrap(), None);
}

/// #401. The path is the whole of what is stored — a certificate that came back
/// as `None` would be a network that silently stopped presenting one, and the
/// login it authenticates would fail with nothing to point at.
#[test]
fn a_network_keeps_the_certificate_it_was_given() {
    let store = Store::open_in_memory().unwrap();
    let mut config = network("Libera");
    config.client_certificate = Some("/home/sable/.irc/libera.pem".into());

    let id = store.save_network(&config).unwrap();
    let saved = &store.list_networks().unwrap()[0];
    assert_eq!(
        saved.client_certificate.as_deref(),
        Some("/home/sable/.irc/libera.pem")
    );

    // And taking it away is a thing that has to stick, or a user who removed it
    // goes on presenting it.
    let mut without = saved.clone();
    without.client_certificate = None;
    store.save_network(&without).unwrap();
    assert_eq!(store.list_networks().unwrap()[0].client_certificate, None);

    assert_eq!(
        store.list_networks().unwrap()[0].id.as_deref(),
        Some(id.as_str())
    );
}

#[test]
fn saving_a_network_again_updates_it_in_place() {
    let store = Store::open_in_memory().unwrap();
    let id = store.save_network(&network("Libera")).unwrap();

    let mut edited = network("Libera renamed");
    edited.id = Some(id.clone());
    edited.port = 6667;
    assert_eq!(store.save_network(&edited).unwrap(), id);

    let networks = store.list_networks().unwrap();
    assert_eq!(networks.len(), 1);
    assert_eq!(networks[0].name, "Libera renamed");
    assert_eq!(networks[0].port, 6667);
}

#[test]
fn an_edit_without_a_password_leaves_the_stored_one_alone() {
    let store = Store::open_in_memory().unwrap();
    let mut config = network("Libera");
    config.sasl = Some(SaslConfig {
        mechanism: SaslMechanism::Plain,
        account: "sykk".into(),
        password: Some("hunter2".into()),
    });
    let id = store.save_network(&config).unwrap();

    let reread = store.list_networks().unwrap().remove(0);
    store.save_network(&reread).unwrap();
    assert_eq!(
        store.sasl_password(&id).unwrap().as_deref(),
        Some("hunter2")
    );
}

#[test]
fn dropping_sasl_deletes_the_password() {
    let store = Store::open_in_memory().unwrap();
    let mut config = network("Libera");
    config.sasl = Some(SaslConfig {
        mechanism: SaslMechanism::External,
        account: "sykk".into(),
        password: Some("hunter2".into()),
    });
    let id = store.save_network(&config).unwrap();

    config.id = Some(id.clone());
    config.sasl = None;
    store.save_network(&config).unwrap();

    assert_eq!(store.sasl_password(&id).unwrap(), None);
    assert!(store.list_networks().unwrap()[0].sasl.is_none());
}

#[test]
fn a_remembered_conversation_is_kept_per_network_until_it_is_forgotten() {
    let store = Store::open_in_memory().unwrap();
    store
        .remember_target("libera", &OpenTarget::Channel("##test".into()))
        .unwrap();
    store
        .remember_target("libera", &OpenTarget::Query("NickServ".into()))
        .unwrap();
    // Joining a channel again is the same channel, not a second row.
    store
        .remember_target("libera", &OpenTarget::Channel("##test".into()))
        .unwrap();
    store
        .remember_target("oftc", &OpenTarget::Channel("#debian".into()))
        .unwrap();

    assert_eq!(
        store.open_targets("libera").unwrap(),
        vec![
            OpenTarget::Channel("##test".into()),
            OpenTarget::Query("NickServ".into()),
        ]
    );
    assert_eq!(
        store.open_targets("oftc").unwrap(),
        vec![OpenTarget::Channel("#debian".into())]
    );

    store.forget_target("libera", "##test").unwrap();
    assert_eq!(
        store.open_targets("libera").unwrap(),
        vec![OpenTarget::Query("NickServ".into())]
    );
}

#[test]
fn removing_a_network_forgets_the_conversations_it_had_open() {
    let store = Store::open_in_memory().unwrap();
    let id = store.save_network(&network("Libera")).unwrap();
    store
        .remember_target(&id, &OpenTarget::Channel("#ircx".into()))
        .unwrap();

    store.remove_network(&id).unwrap();

    assert!(store.open_targets(&id).unwrap().is_empty());
}

/// A draft is text somebody typed and did not send. It is neither a setting nor
/// an archived conversation, so "forgets its settings, the conversations stay"
/// does not cover it — and a network id is a fresh uuid, so nothing would ever
/// name this one again. It outlived the network with no screen left that could
/// reach it. #382.
#[test]
fn removing_a_network_takes_its_unsent_drafts() {
    let store = Store::open_in_memory().unwrap();
    let id = store.save_network(&network("Libera")).unwrap();
    let other = store.save_network(&network("OFTC")).unwrap();
    store
        .set_draft(&id, "#ircx", "half-typed and private")
        .unwrap();
    store
        .set_draft(&other, "#debian", "somebody else's")
        .unwrap();

    store.remove_network(&id).unwrap();

    assert_eq!(store.get_draft(&id, "#ircx").unwrap(), None);
    assert_eq!(
        store.get_draft(&other, "#debian").unwrap().as_deref(),
        Some("somebody else's"),
        "another network's drafts are not its business"
    );
}

/// The removal screen says it "forgets its settings", and a retention window is
/// one — set from the archive sheet, and deciding nothing once the network it
/// belongs to is gone.
#[test]
fn removing_a_network_takes_its_retention_windows() {
    let store = Store::open_in_memory().unwrap();
    let id = store.save_network(&network("Libera")).unwrap();
    let other = store.save_network(&network("OFTC")).unwrap();
    store.set_retention(&id, None, Some(90)).unwrap();
    store.set_retention(&id, Some("#ircx"), Some(30)).unwrap();
    store.set_retention(&other, None, Some(7)).unwrap();

    store.remove_network(&id).unwrap();

    assert_eq!(store.retention(&id, None).unwrap(), None);
    assert_eq!(store.retention(&id, Some("#ircx")).unwrap(), None);
    assert_eq!(store.retention(&other, None).unwrap(), Some(Some(7)));
}

#[test]
fn removing_a_network_drops_the_password_and_keeps_the_archive() {
    let store = Store::open_in_memory().unwrap();
    let mut config = network("Libera");
    config.sasl = Some(SaslConfig {
        mechanism: SaslMechanism::Plain,
        account: "sykk".into(),
        password: Some("hunter2".into()),
    });
    let id = store.save_network(&config).unwrap();
    store
        .append_messages(&[message("a", "#ircx", "2026-01-01T00:00:00Z", "said once")])
        .unwrap();

    store.remove_network(&id).unwrap();

    assert!(store.list_networks().unwrap().is_empty());
    assert_eq!(store.sasl_password(&id).unwrap(), None);
    assert_eq!(
        store
            .load_history(&history("#ircx", None, 10))
            .unwrap()
            .len(),
        1
    );
}

/// Reactions key on the msgid they named, not on a row in `messages`, so one
/// can arrive for a message the archive has never held — reacting to something
/// said before this client connected does exactly that. The row waits, and the
/// message finds it whenever a backfill brings it in.
#[test]
fn a_reaction_for_a_message_not_yet_archived_is_waiting_when_it_arrives() {
    let store = Store::open_in_memory().unwrap();
    store
        .set_reaction("libera", "123", "nick2", "lol", true)
        .unwrap();
    assert!(store
        .load_history(&history("#ircx", None, 10))
        .unwrap()
        .is_empty());

    store
        .append_messages(&[with_msgid(
            message("x", "#ircx", "2026-01-01T00:00:00Z", "Hello!"),
            "123",
        )])
        .unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(read[0].reactions.len(), 1);
    assert_eq!(read[0].reactions[0].emoji, "lol");
    assert_eq!(read[0].reactions[0].nicks, vec!["nick2".to_string()]);
}

#[test]
fn reactions_group_by_value_in_the_order_they_arrived() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[with_msgid(
            message("x", "#ircx", "2026-01-01T00:00:00Z", "They won!"),
            "123",
        )])
        .unwrap();
    for (nick, emoji) in [
        ("nick2", "🇦🇷"),
        ("nick3", "🇩🇪"),
        ("nick4", "🇦🇷"),
        // One person sending the same reaction twice holds one of it.
        ("nick2", "🇦🇷"),
    ] {
        store
            .set_reaction("libera", "123", nick, emoji, true)
            .unwrap();
    }

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    let shown: Vec<(&str, Vec<&str>)> = read[0]
        .reactions
        .iter()
        .map(|held| {
            (
                held.emoji.as_str(),
                held.nicks.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        vec![("🇦🇷", vec!["nick2", "nick4"]), ("🇩🇪", vec!["nick3"])]
    );
}

#[test]
fn taking_a_reaction_back_removes_only_the_person_who_sent_it() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[with_msgid(
            message("x", "#ircx", "2026-01-01T00:00:00Z", "They won!"),
            "123",
        )])
        .unwrap();
    store
        .set_reaction("libera", "123", "nick2", "🇦🇷", true)
        .unwrap();
    store
        .set_reaction("libera", "123", "nick3", "🇦🇷", true)
        .unwrap();
    store
        .set_reaction("libera", "123", "nick2", "🇦🇷", false)
        .unwrap();
    // Taking back one that was never sent is a line a server can repeat, not
    // a failure.
    store
        .set_reaction("libera", "123", "nick4", "🇦🇷", false)
        .unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(read[0].reactions[0].nicks, vec!["nick3".to_string()]);
}

/// A message this client sent keeps the local id the UI drew it with, so a
/// reaction to it names the msgid the echo carried instead.
#[test]
fn a_reaction_to_our_own_message_finds_it_by_the_msgid_the_echo_carried() {
    let store = Store::open_in_memory().unwrap();
    let mut ours = message("local-uuid", "#ircx", "2026-01-01T00:00:00Z", "Hello!");
    ours.tags.push(("msgid".into(), Some("456".into())));
    store.append_messages(&[ours]).unwrap();
    store
        .set_reaction("libera", "456", "nick2", "lol", true)
        .unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(read[0].reactions[0].nicks, vec!["nick2".to_string()]);
}

/// A reaction on one network is not a reaction on another that happened to
/// hand out the same msgid.
#[test]
fn reactions_do_not_cross_networks() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[with_msgid(
            message("x", "#ircx", "2026-01-01T00:00:00Z", "Hello!"),
            "123",
        )])
        .unwrap();
    store
        .set_reaction("oftc", "123", "nick2", "lol", true)
        .unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert!(read[0].reactions.is_empty());
}

#[test]
fn an_exported_message_carries_the_reactions_it_collected() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[with_msgid(
            message("x", "#ircx", "2026-01-01T00:00:00Z", "Hello!"),
            "123",
        )])
        .unwrap();
    store
        .set_reaction("libera", "123", "nick2", "lol", true)
        .unwrap();

    let mut out = Vec::new();
    store.export_target("libera", "#ircx", &mut out).unwrap();
    let exported: ChatMessage =
        serde_json::from_str(String::from_utf8(out).unwrap().trim()).unwrap();
    assert_eq!(exported.reactions[0].nicks, vec!["nick2".to_string()]);
}

/// An export written before reactions existed has no field for them, and it
/// still has to read back.
#[test]
fn an_export_from_before_reactions_still_reads() {
    let mut line =
        serde_json::to_value(message("x", "#ircx", "2026-01-01T00:00:00Z", "Hello!")).unwrap();
    line.as_object_mut().unwrap().remove("reactions");

    let read: ChatMessage = serde_json::from_value(line).unwrap();
    assert!(read.reactions.is_empty());
}

#[test]
fn export_writes_one_json_line_per_message() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message("a", "#ircx", "2026-01-01T00:00:01Z", "second"),
            message("b", "#ircx", "2026-01-01T00:00:00Z", "first"),
            message("c", "#other", "2026-01-01T00:00:00Z", "elsewhere"),
        ])
        .unwrap();

    let mut out = Vec::new();
    store.export_target("libera", "#ircx", &mut out).unwrap();
    let exported = String::from_utf8(out).unwrap();

    let lines: Vec<ChatMessage> = exported
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0].text, "first");
    assert_eq!(lines[1].text, "second");
    assert_eq!(lines[0].source, MessageSource::LocalArchive);
}

#[test]
fn deleting_a_target_takes_its_draft_and_nothing_else() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message("a", "#ircx", "2026-01-01T00:00:00Z", "gone"),
            message("b", "#other", "2026-01-01T00:00:00Z", "kept"),
        ])
        .unwrap();
    store.set_draft("libera", "#ircx", "unsent").unwrap();
    store.set_draft("libera", "#other", "also unsent").unwrap();

    store.delete_target("libera", "#ircx").unwrap();

    assert!(store
        .load_history(&history("#ircx", None, 10))
        .unwrap()
        .is_empty());
    assert_eq!(store.get_draft("libera", "#ircx").unwrap(), None);
    assert_eq!(
        store
            .load_history(&history("#other", None, 10))
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.get_draft("libera", "#other").unwrap().as_deref(),
        Some("also unsent")
    );
}

/// #90. A note is held nowhere but the archive once the window has moved on,
/// so a conversation reopened tomorrow reads it back rather than running the
/// annotator again over history.
#[test]
fn an_annotation_comes_back_with_the_message() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message("m1", "#ircx", "2026-01-01T00:00:00Z", "it is 72F")])
        .unwrap();
    store
        .set_annotation("libera", "m1", "units", "22 C")
        .unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(
        read[0].annotations,
        vec![Annotation {
            plugin: "units".into(),
            text: "22 C".into()
        }]
    );
}

/// One note per plugin per message. The annotator runs on arrival and a
/// history backfill can hand it the same message a second time, so the second
/// answer replaces the first rather than doubling it.
#[test]
fn a_plugin_annotating_twice_replaces_what_it_said() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message("m1", "#ircx", "2026-01-01T00:00:00Z", "it is 72F")])
        .unwrap();
    store
        .set_annotation("libera", "m1", "units", "22 C")
        .unwrap();
    store
        .set_annotation("libera", "m1", "units", "22.2 C")
        .unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(read[0].annotations.len(), 1);
    assert_eq!(read[0].annotations[0].text, "22.2 C");
}

#[test]
fn two_plugins_each_keep_their_own_note() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message(
            "m1",
            "#ircx",
            "2026-01-01T00:00:00Z",
            "see example.com",
        )])
        .unwrap();
    store
        .set_annotation("libera", "m1", "units", "22 C")
        .unwrap();
    store
        .set_annotation("libera", "m1", "links", "Example Domain")
        .unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    // Ordered by plugin, so two annotators racing do not swap places between
    // one page load and the next.
    assert_eq!(
        read[0]
            .annotations
            .iter()
            .map(|note| note.plugin.as_str())
            .collect::<Vec<_>>(),
        ["links", "units"]
    );
}

/// The row waits for a message the archive does not hold, exactly as a
/// reaction's does — the annotator can answer a backfill that has not landed.
#[test]
fn an_annotation_can_be_written_before_the_message_it_names() {
    let store = Store::open_in_memory().unwrap();
    store
        .set_annotation("libera", "later", "units", "22 C")
        .unwrap();
    store
        .append_messages(&[message(
            "later",
            "#ircx",
            "2026-01-01T00:00:00Z",
            "it is 72F",
        )])
        .unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(read[0].annotations[0].text, "22 C");
}

/// A raise is written before it is sent, as a note is: the archive is where a
/// raise outside the open window survives, so a conversation reopened tomorrow
/// still shows what was worth reading in it.
#[test]
fn a_raise_comes_back_with_the_message() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message(
            "m1",
            "#ircx",
            "2026-01-01T00:00:00Z",
            "deploy failed",
        )])
        .unwrap();
    store.set_raised("libera", "m1", "deploys").unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(read[0].raised_by, vec!["deploys".to_string()]);
}

/// The same rule raising twice is one raise, so a history backfill handing a
/// rule the same message again cannot double it.
#[test]
fn a_rule_raising_twice_raises_once() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message(
            "m1",
            "#ircx",
            "2026-01-01T00:00:00Z",
            "deploy failed",
        )])
        .unwrap();
    store.set_raised("libera", "m1", "deploys").unwrap();
    store.set_raised("libera", "m1", "deploys").unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(read[0].raised_by, vec!["deploys".to_string()]);
}

/// Two rules can each think so, and a reader is told both: which rule raised a
/// conversation is how they decide whether it should have.
#[test]
fn two_rules_each_keep_their_own_raise() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message(
            "m1",
            "#ircx",
            "2026-01-01T00:00:00Z",
            "deploy failed",
        )])
        .unwrap();
    store.set_raised("libera", "m1", "oncall").unwrap();
    store.set_raised("libera", "m1", "deploys").unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert_eq!(
        read[0].raised_by,
        vec!["deploys", "oncall"],
        "ordered by plugin"
    );
}

/// The three tables hanging off a message are read for a whole page in one
/// statement each, so what a page costs does not follow how long it is. What
/// that puts at risk is which message a row lands on, and a page where most
/// messages carry nothing is the ordinary one.
#[test]
fn a_page_gives_each_message_only_what_hangs_off_it() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            with_msgid(
                message("x", "#ircx", "2026-01-01T00:00:00Z", "first"),
                "111",
            ),
            with_msgid(
                message("x", "#ircx", "2026-01-01T00:00:01Z", "second"),
                "222",
            ),
            with_msgid(
                message("x", "#ircx", "2026-01-01T00:00:02Z", "third"),
                "333",
            ),
        ])
        .unwrap();
    for (nick, emoji) in [("nick2", "🎉"), ("nick3", "👀"), ("nick4", "🎉")] {
        store
            .set_reaction("libera", "111", nick, emoji, true)
            .unwrap();
    }
    store
        .set_reaction("libera", "333", "nick5", "👍", true)
        .unwrap();
    store
        .set_annotation("libera", "333", "units", "22 C")
        .unwrap();
    store.set_raised("libera", "333", "oncall").unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    let shown: Vec<(&str, Vec<&str>)> = read[0]
        .reactions
        .iter()
        .map(|held| {
            (
                held.emoji.as_str(),
                held.nicks.iter().map(String::as_str).collect(),
            )
        })
        .collect();
    assert_eq!(
        shown,
        vec![("🎉", vec!["nick2", "nick4"]), ("👀", vec!["nick3"])],
        "grouped by value in arrival order, as they are for a page of one"
    );
    assert!(read[0].annotations.is_empty());
    assert!(read[0].raised_by.is_empty());

    assert!(read[1].reactions.is_empty(), "nothing hangs off the second");
    assert!(read[1].annotations.is_empty());
    assert!(read[1].raised_by.is_empty());

    assert_eq!(read[2].reactions.len(), 1);
    assert_eq!(read[2].reactions[0].emoji, "👍");
    assert_eq!(read[2].annotations[0].text, "22 C");
    assert_eq!(read[2].raised_by, vec!["oncall"]);
}

/// Two networks can hand out the same msgid, and a search spans them: it is
/// the one read that can put two messages of that name in one page. They are
/// asked for a network at a time, and this is what says so.
#[test]
fn one_msgid_on_two_networks_keeps_its_reactions_apart() {
    let store = Store::open_in_memory().unwrap();
    let mut elsewhere = with_msgid(
        message("x", "#ircx", "2026-01-01T00:00:01Z", "the same msgid"),
        "123",
    );
    elsewhere.network = "oftc".into();
    store
        .append_messages(&[
            with_msgid(
                message("x", "#ircx", "2026-01-01T00:00:00Z", "the same msgid"),
                "123",
            ),
            elsewhere,
        ])
        .unwrap();
    store
        .set_reaction("libera", "123", "nick2", "🇦🇷", true)
        .unwrap();
    store
        .set_reaction("oftc", "123", "nick3", "🇩🇪", true)
        .unwrap();

    let hits = store
        .search(&SearchRequest {
            query: "msgid".into(),
            network: None,
            target: None,
            sender: None,
            after: None,
            limit: 10,
        })
        .unwrap();
    let found: Vec<(&str, Vec<&str>)> = hits
        .iter()
        .map(|hit| {
            (
                hit.message.network.as_str(),
                hit.message
                    .reactions
                    .iter()
                    .map(|held| held.emoji.as_str())
                    .collect(),
            )
        })
        .collect();
    assert_eq!(found, vec![("oftc", vec!["🇩🇪"]), ("libera", vec!["🇦🇷"])]);
}

/// A message nothing raised is the ordinary case, and says so by being empty
/// rather than by carrying a third state.
#[test]
fn a_message_nothing_raised_comes_back_empty() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message("m1", "#ircx", "2026-01-01T00:00:00Z", "morning")])
        .unwrap();

    let read = store.load_history(&history("#ircx", None, 10)).unwrap();
    assert!(read[0].raised_by.is_empty());
}

/// #190. Rows written before one conversation had one name hold whichever
/// casing arrived, so reading by the name the window knows has to find them.
/// A lookup that cannot find a message it holds is worse than one that finds a
/// message twice.
#[test]
fn history_finds_a_conversation_whatever_case_it_was_written_under() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message(
                "m1",
                "NickServ",
                "2026-01-01T00:00:00Z",
                "you are now identified",
            ),
            message("m2", "nickserv", "2026-01-01T00:00:01Z", "STATUS"),
            message("m3", "NICKSERV", "2026-01-01T00:00:02Z", "HELP"),
        ])
        .unwrap();

    let read = store.load_history(&history("nickserv", None, 10)).unwrap();
    assert_eq!(
        read.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["you are now identified", "STATUS", "HELP"],
        "one conversation, however its rows were spelled"
    );
}

/// The folding is not so wide that it merges conversations that are not one.
#[test]
fn history_keeps_two_different_conversations_apart() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message("m1", "NickServ", "2026-01-01T00:00:00Z", "identified"),
            message("m2", "ChanServ", "2026-01-01T00:00:01Z", "op granted"),
        ])
        .unwrap();

    let read = store.load_history(&history("nickserv", None, 10)).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0].text, "identified");
}

/// #90. Where an attachment goes before its link is sent.
mod upload_provider {
    use super::*;
    use ircx_ipc::{S3Credentials, UploadMethod, UploadProvider};

    fn provider() -> UploadProvider {
        UploadProvider {
            endpoint: "https://files.example.com/{name}".into(),
            method: UploadMethod::Put,
            auth_header: Some("Authorization".into()),
            token: Some("Bearer sekrit".into()),
            token_saved: false,
            s3: None,
            form: None,
        }
    }

    /// Signing needs two more things stored and the same one secret, and the
    /// secret goes where the token goes rather than beside them.
    #[test]
    fn an_s3_provider_reads_back_its_region_and_key_but_not_its_secret() {
        let store = Store::open_in_memory().unwrap();
        store
            .save_upload_provider(&UploadProvider {
                endpoint: "https://s3.example.com/bucket/{name}".into(),
                auth_header: None,
                token: Some("wJalrXUtnFEMI".into()),
                s3: Some(S3Credentials {
                    region: "eu-west-1".into(),
                    access_key_id: "AKIAIOSFODNN7EXAMPLE".into(),
                }),
                ..provider()
            })
            .unwrap();

        let read = store.upload_provider().unwrap().expect("a provider");
        let s3 = read.s3.expect("the signing details");
        assert_eq!(s3.region, "eu-west-1");
        assert_eq!(s3.access_key_id, "AKIAIOSFODNN7EXAMPLE");
        assert_eq!(read.token, None, "a secret only ever travels one way");
        assert_eq!(
            store.upload_token().unwrap().as_deref(),
            Some("wJalrXUtnFEMI")
        );
    }

    /// A form host is read back with the fields it was saved with, in order:
    /// catbox will not take the file without `reqtype`, and the order is what
    /// the user typed.
    #[test]
    fn a_form_provider_reads_back_its_fields() {
        let store = Store::open_in_memory().unwrap();
        store
            .save_upload_provider(&UploadProvider {
                endpoint: "https://litterbox.catbox.moe/resources/internals/api.php".into(),
                method: UploadMethod::Post,
                auth_header: None,
                token: None,
                form: Some(ircx_ipc::FormUpload {
                    file_field: "fileToUpload".into(),
                    fields: vec![
                        ("reqtype".into(), "fileupload".into()),
                        ("time".into(), "1h".into()),
                    ],
                }),
                ..provider()
            })
            .unwrap();

        let form = store
            .upload_provider()
            .unwrap()
            .expect("a provider")
            .form
            .expect("the form");
        assert_eq!(form.file_field, "fileToUpload");
        assert_eq!(
            form.fields,
            vec![
                ("reqtype".to_owned(), "fileupload".to_owned()),
                ("time".to_owned(), "1h".to_owned())
            ]
        );
    }

    /// Switching a provider back to one that carries a token must not leave a
    /// region behind for a signer nothing uses.
    #[test]
    fn dropping_the_signing_details_drops_them() {
        let store = Store::open_in_memory().unwrap();
        store
            .save_upload_provider(&UploadProvider {
                s3: Some(S3Credentials {
                    region: "eu-west-1".into(),
                    access_key_id: "AKIA".into(),
                }),
                ..provider()
            })
            .unwrap();
        store.save_upload_provider(&provider()).unwrap();

        assert!(store
            .upload_provider()
            .unwrap()
            .expect("a provider")
            .s3
            .is_none());
    }

    /// "No provider" is a configuration the spec names, and it is the absence
    /// of a row rather than a flag on one.
    #[test]
    fn there_is_none_until_one_is_saved() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.upload_provider().unwrap().is_none());
    }

    #[test]
    fn a_saved_provider_reads_back_without_its_token() {
        let store = Store::open_in_memory().unwrap();
        store.save_upload_provider(&provider()).unwrap();

        let read = store.upload_provider().unwrap().expect("a provider");
        assert_eq!(read.endpoint, "https://files.example.com/{name}");
        assert_eq!(read.method, UploadMethod::Put);
        assert_eq!(read.auth_header.as_deref(), Some("Authorization"));
        assert_eq!(read.token, None, "a token only ever travels one way");
        assert!(read.token_saved, "but whether there is one comes back");
        assert_eq!(
            store.upload_token().unwrap().as_deref(),
            Some("Bearer sekrit")
        );
    }

    /// The screen that says "saved in your system keyring" has to be able to
    /// tell. Guessing it from the provider existing is what let a provider be
    /// saved without the secret it needs.
    #[test]
    fn a_provider_saved_without_a_secret_says_so() {
        let store = Store::open_in_memory().unwrap();
        store
            .save_upload_provider(&UploadProvider {
                token: None,
                ..provider()
            })
            .unwrap();

        let read = store.upload_provider().unwrap().expect("a provider");
        assert!(!read.token_saved);
    }

    #[test]
    fn there_is_only_ever_one() {
        let store = Store::open_in_memory().unwrap();
        store.save_upload_provider(&provider()).unwrap();
        store
            .save_upload_provider(&UploadProvider {
                endpoint: "https://other.example.com/upload".into(),
                method: UploadMethod::Post,
                ..provider()
            })
            .unwrap();

        let read = store.upload_provider().unwrap().expect("a provider");
        assert_eq!(read.endpoint, "https://other.example.com/upload");
        assert_eq!(read.method, UploadMethod::Post);
    }

    /// The user cannot see the token, so a screen that saves an endpoint change
    /// must not take it away.
    #[test]
    fn saving_without_a_token_keeps_the_one_stored() {
        let store = Store::open_in_memory().unwrap();
        store.save_upload_provider(&provider()).unwrap();
        store
            .save_upload_provider(&UploadProvider {
                endpoint: "https://moved.example.com/{name}".into(),
                token: None,
                ..provider()
            })
            .unwrap();

        assert_eq!(
            store.upload_token().unwrap().as_deref(),
            Some("Bearer sekrit")
        );
    }

    #[test]
    fn an_empty_token_clears_the_secret_for_a_provider_that_needs_none() {
        let store = Store::open_in_memory().unwrap();
        store.save_upload_provider(&provider()).unwrap();
        store
            .save_upload_provider(&UploadProvider {
                auth_header: None,
                token: Some(String::new()),
                ..provider()
            })
            .unwrap();

        assert_eq!(store.upload_token().unwrap(), None);
    }

    /// Leaving it behind would keep a credential for something the user said
    /// they no longer use.
    #[test]
    fn removing_the_provider_takes_the_token_with_it() {
        let store = Store::open_in_memory().unwrap();
        store.save_upload_provider(&provider()).unwrap();
        store.remove_upload_provider().unwrap();

        assert!(store.upload_provider().unwrap().is_none());
        assert_eq!(store.upload_token().unwrap(), None);
    }

    /// A network's SASL password and the provider's token share a keyring. The
    /// provider's key is a name no generated network id can equal.
    #[test]
    fn the_token_does_not_collide_with_a_networks_password() {
        let store = Store::open_in_memory().unwrap();
        let id = store
            .save_network(&ircx_ipc::NetworkConfig {
                id: None,
                name: "Libera".into(),
                host: "irc.libera.chat".into(),
                port: 6697,
                tls: true,
                tls_verify: true,
                socks5_proxy: None,
                nick: "sable".into(),
                alt_nicks: vec![],
                username: "sable".into(),
                realname: "sable".into(),
                sasl: Some(ircx_ipc::SaslConfig {
                    mechanism: ircx_ipc::SaslMechanism::Plain,
                    account: "sable".into(),
                    password: Some("hunter2".into()),
                }),
                connect_commands: vec![],
                autojoin: vec![],
                auto_connect: false,
                client_certificate: None,
                quit_message: None,
                part_message: None,
                away_message: None,
            })
            .unwrap();
        store.save_upload_provider(&provider()).unwrap();

        assert_eq!(
            store.upload_token().unwrap().as_deref(),
            Some("Bearer sekrit")
        );
        assert_ne!(id, "upload-provider");
    }
}

/// #219. Where a server-side backfill picks up.
mod newest_timestamp {
    use super::*;

    #[test]
    fn an_empty_archive_has_no_answer() {
        let store = Store::open_in_memory().unwrap();

        assert_eq!(store.newest_timestamp("libera", "#ircx").unwrap(), None);
    }

    #[test]
    fn the_latest_message_in_this_conversation_is_the_answer() {
        let store = Store::open_in_memory().unwrap();
        store
            .append_messages(&[
                message("a", "#ircx", "2026-07-31T09:00:00Z", "first"),
                message("c", "#ircx", "2026-07-31T11:00:00Z", "last"),
                message("b", "#ircx", "2026-07-31T10:00:00Z", "middle"),
                message("d", "#other", "2026-07-31T23:00:00Z", "elsewhere"),
            ])
            .unwrap();

        assert_eq!(
            store
                .newest_timestamp("libera", "#ircx")
                .unwrap()
                .as_deref(),
            Some("2026-07-31T11:00:00Z")
        );
    }

    /// A line this machine stamped is a point in its clock rather than in the
    /// server's record, and asking for the gap from after it would step over
    /// the messages in it. #223.
    #[test]
    fn a_client_stamped_line_is_not_where_the_record_left_off() {
        let store = Store::open_in_memory().unwrap();
        let mut local = message("b", "#ircx", "2999-01-01T00:00:00Z", "typed here");
        local.timestamp_is_local = true;
        store
            .append_messages(&[
                message("a", "#ircx", "2026-07-31T09:00:00Z", "said there"),
                local,
            ])
            .unwrap();

        assert_eq!(
            store
                .newest_timestamp("libera", "#ircx")
                .unwrap()
                .as_deref(),
            Some("2026-07-31T09:00:00Z")
        );
    }

    /// The join that ends an outage is stamped after everything said during it,
    /// so a conversation resumed from one asks for a gap starting after its own
    /// contents — and counts none of what comes back as unread. #565.
    #[test]
    fn a_join_is_not_where_the_record_left_off() {
        let store = Store::open_in_memory().unwrap();
        let mut rejoined = message("b", "#ircx", "2026-07-31T10:00:00Z", "sykk joined #ircx");
        rejoined.kind = MessageKind::Join;
        store
            .append_messages(&[
                message("a", "#ircx", "2026-07-31T09:00:00Z", "said there"),
                rejoined,
            ])
            .unwrap();

        assert_eq!(
            store
                .newest_timestamp("libera", "#ircx")
                .unwrap()
                .as_deref(),
            Some("2026-07-31T09:00:00Z")
        );
    }

    /// The same folding `load_history` does, and for the reason #190 gives:
    /// rows written before it hold whichever casing arrived.
    #[test]
    fn the_target_is_matched_without_case() {
        let store = Store::open_in_memory().unwrap();
        store
            .append_messages(&[message("a", "#IRCX", "2026-07-31T09:00:00Z", "first")])
            .unwrap();

        assert_eq!(
            store
                .newest_timestamp("libera", "#ircx")
                .unwrap()
                .as_deref(),
            Some("2026-07-31T09:00:00Z")
        );
    }
}

/// #241. The archive had all of this and no way to reach any of it.
mod archive_controls {
    use super::*;

    fn stocked() -> Store {
        let store = Store::open_in_memory().unwrap();
        store
            .append_messages(&[
                message("a", "#ircx", "2026-07-31T09:00:00Z", "morning"),
                message("b", "#ircx", "2026-07-31T09:01:00Z", "and again"),
                message("c", "phrack", "2026-07-31T09:02:00Z", "a private word"),
            ])
            .unwrap();
        store
            .set_draft("libera", "#ircx", "half a thought")
            .unwrap();
        store
    }

    #[test]
    fn it_says_how_much_is_kept() {
        let store = stocked();
        let size = store.archive_size().unwrap();

        assert_eq!(size.messages, 3);
        assert!(size.bytes > 0, "a stocked archive weighs something");
    }

    #[test]
    fn everything_exports_every_conversation_oldest_first() {
        let store = stocked();
        let mut out = Vec::new();
        store.export_everything(&mut out).unwrap();

        let lines: Vec<&str> = std::str::from_utf8(&out).unwrap().lines().collect();
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("morning"));
        assert!(lines[2].contains("a private word"));
    }

    #[test]
    fn one_network_exports_only_its_conversations() {
        let store = stocked();
        let mut elsewhere = message("d", "#other", "2026-07-31T09:03:00Z", "not this network");
        elsewhere.network = "oftc".into();
        store.append_messages(&[elsewhere]).unwrap();

        let mut out = Vec::new();
        store.export_network("libera", &mut out).unwrap();

        let export = String::from_utf8(out).unwrap();
        assert!(export.contains("morning"));
        assert!(export.contains("a private word"));
        assert!(!export.contains("not this network"));
    }

    #[test]
    fn deleting_one_network_leaves_the_other_network() {
        let store = stocked();
        let mut elsewhere = message("d", "#other", "2026-07-31T09:03:00Z", "still here");
        elsewhere.network = "oftc".into();
        store.append_messages(&[elsewhere]).unwrap();
        store.set_draft("oftc", "#other", "still typing").unwrap();

        store.delete_network_archive("libera").unwrap();

        assert_eq!(store.archive_size().unwrap().messages, 1);
        assert_eq!(store.get_draft("libera", "#ircx").unwrap(), None);
        assert_eq!(
            store.get_draft("oftc", "#other").unwrap().as_deref(),
            Some("still typing")
        );
        let hits = store
            .search(&SearchRequest {
                query: "still here".into(),
                network: None,
                target: None,
                sender: None,
                after: None,
                limit: 20,
            })
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].message.network, "oftc");
    }

    /// Somebody clearing what was said is not asking to be logged out.
    #[test]
    fn deleting_everything_keeps_the_networks() {
        let store = stocked();
        store
            .save_network(&NetworkConfig {
                id: None,
                name: "Libera".into(),
                host: "irc.libera.chat".into(),
                port: 6697,
                tls: true,
                tls_verify: true,
                socks5_proxy: None,
                nick: "sable".into(),
                alt_nicks: vec![],
                username: "sable".into(),
                realname: "sable".into(),
                sasl: None,
                connect_commands: vec![],
                autojoin: vec![],
                auto_connect: true,
                client_certificate: None,
                quit_message: None,
                part_message: None,
                away_message: None,
            })
            .unwrap();

        store.delete_everything().unwrap();

        assert_eq!(store.archive_size().unwrap().messages, 0);
        assert_eq!(store.list_networks().unwrap().len(), 1);
    }

    /// The full-text index hangs off the messages table by trigger, so a search
    /// after a wipe has to come back empty rather than pointing at rows that
    /// are gone.
    #[test]
    fn deleting_everything_empties_the_search_too() {
        let store = stocked();
        store.delete_everything().unwrap();

        let hits = store
            .search(&SearchRequest {
                query: "morning".into(),
                network: None,
                target: None,
                sender: None,
                after: None,
                limit: 20,
            })
            .unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn deleting_everything_takes_the_drafts_with_it() {
        let store = stocked();
        store.delete_everything().unwrap();

        assert_eq!(store.get_draft("libera", "#ircx").unwrap(), None);
    }
}

/// A delete that leaves the words in the file's free pages is not what somebody
/// clearing an archive asked for, and the size they are shown would still count
/// them.
#[test]
fn deleting_everything_gives_the_space_back() {
    let store = Store::open_in_memory().unwrap();
    let bulk: Vec<ChatMessage> = (0..2000)
        .map(|i| {
            message(
                &format!("m{i}"),
                "#ircx",
                &format!("2026-07-31T09:{:02}:{:02}Z", i / 60 % 60, i % 60),
                "a line with enough words in it to take up room on the disk",
            )
        })
        .collect();
    store.append_messages(&bulk).unwrap();
    let full = store.archive_size().unwrap().bytes;

    store.delete_everything().unwrap();
    let empty = store.archive_size().unwrap().bytes;

    assert_eq!(store.archive_size().unwrap().messages, 0);
    // Not to nothing: the schema and the full-text structures are still there,
    // and an empty archive is allowed to weigh what an empty archive weighs.
    assert!(
        empty * 2 < full,
        "an emptied archive should not still weigh what it did: {empty} against {full}"
    );
}

#[test]
fn deleting_one_network_gives_its_space_back() {
    let store = Store::open_in_memory().unwrap();
    let bulk: Vec<ChatMessage> = (0..2000)
        .map(|i| {
            message(
                &format!("m{i}"),
                "#ircx",
                &format!("2026-07-31T09:{:02}:{:02}Z", i / 60 % 60, i % 60),
                "a line with enough words in it to take up room on the disk",
            )
        })
        .collect();
    store.append_messages(&bulk).unwrap();
    let mut elsewhere = message("elsewhere", "#other", "2026-07-31T10:00:00Z", "keep this");
    elsewhere.network = "oftc".into();
    store.append_messages(&[elsewhere]).unwrap();
    let full = store.archive_size().unwrap().bytes;

    store.delete_network_archive("libera").unwrap();
    let remaining = store.archive_size().unwrap();

    assert_eq!(remaining.messages, 1);
    assert!(
        remaining.bytes * 2 < full,
        "the remaining network should not retain the deleted network's pages: {} against {full}",
        remaining.bytes
    );
}

/// #248. A rename moves everything else about a conversation; the draft lives
/// on disk and was the one piece left behind.
mod a_draft_follows_the_rename {
    use super::*;

    #[test]
    fn the_words_go_with_the_person() {
        let store = Store::open_in_memory().unwrap();
        store
            .set_draft("libera", "oldname", "half a thought")
            .unwrap();

        store.move_draft("libera", "oldname", "newname").unwrap();

        assert_eq!(
            store.get_draft("libera", "newname").unwrap().as_deref(),
            Some("half a thought")
        );
        assert_eq!(store.get_draft("libera", "oldname").unwrap(), None);
    }

    #[test]
    fn a_conversation_with_nothing_written_moves_nothing() {
        let store = Store::open_in_memory().unwrap();

        store.move_draft("libera", "oldname", "newname").unwrap();

        assert_eq!(store.get_draft("libera", "newname").unwrap(), None);
    }

    /// Two drafts meeting is the newer one winning, and the older one going
    /// rather than sitting under a name somebody else now holds.
    #[test]
    fn what_is_already_under_the_new_name_stands() {
        let store = Store::open_in_memory().unwrap();
        store
            .set_draft("libera", "oldname", "the older words")
            .unwrap();
        store
            .set_draft("libera", "newname", "the newer words")
            .unwrap();

        store.move_draft("libera", "oldname", "newname").unwrap();

        assert_eq!(
            store.get_draft("libera", "newname").unwrap().as_deref(),
            Some("the newer words")
        );
        assert_eq!(store.get_draft("libera", "oldname").unwrap(), None);
    }

    #[test]
    fn another_networks_draft_is_left_alone() {
        let store = Store::open_in_memory().unwrap();
        store.set_draft("libera", "oldname", "here").unwrap();
        store.set_draft("oftc", "oldname", "elsewhere").unwrap();

        store.move_draft("libera", "oldname", "newname").unwrap();

        assert_eq!(
            store.get_draft("oftc", "oldname").unwrap().as_deref(),
            Some("elsewhere")
        );
    }
}

/// #249. The spec's Storage section opens with optional local history, and the
/// shortest window #241 offered was seven days.
mod keeping_nothing {
    use super::*;

    fn said(store: &Store, target: &str, id: &str) {
        store
            .append_messages(&[message(id, target, "2026-07-31T09:00:00Z", "a line")])
            .unwrap();
    }

    fn held(store: &Store, target: &str) -> usize {
        store
            .load_history(&history(target, None, 50))
            .unwrap()
            .len()
    }

    #[test]
    fn a_conversation_set_to_keep_nothing_writes_nothing() {
        let store = Store::open_in_memory().unwrap();
        store
            .set_retention("libera", Some("#ircx"), Some(0))
            .unwrap();

        said(&store, "#ircx", "a");

        assert_eq!(held(&store, "#ircx"), 0);
    }

    #[test]
    fn a_network_set_to_keep_nothing_covers_its_conversations() {
        let store = Store::open_in_memory().unwrap();
        store.set_retention("libera", None, Some(0)).unwrap();

        said(&store, "#ircx", "a");
        said(&store, "phrack", "b");

        assert_eq!(held(&store, "#ircx"), 0);
        assert_eq!(held(&store, "phrack"), 0);
    }

    /// The override beats the default in both directions, which is what makes
    /// "keep nothing except this one" sayable.
    #[test]
    fn a_conversation_may_keep_what_its_network_does_not() {
        let store = Store::open_in_memory().unwrap();
        store.set_retention("libera", None, Some(0)).unwrap();
        store.set_retention("libera", Some("#ircx"), None).unwrap();

        said(&store, "#ircx", "a");
        said(&store, "phrack", "b");

        assert_eq!(held(&store, "#ircx"), 1);
        assert_eq!(held(&store, "phrack"), 0);
    }

    #[test]
    fn a_conversation_may_stop_keeping_what_its_network_does() {
        let store = Store::open_in_memory().unwrap();
        store.set_retention("libera", None, Some(30)).unwrap();
        store
            .set_retention("libera", Some("phrack"), Some(0))
            .unwrap();

        said(&store, "#ircx", "a");
        said(&store, "phrack", "b");

        assert_eq!(held(&store, "#ircx"), 1);
        assert_eq!(held(&store, "phrack"), 0);
    }

    /// Nothing said about a conversation is not a conversation nobody wants.
    #[test]
    fn saying_nothing_keeps_everything() {
        let store = Store::open_in_memory().unwrap();

        said(&store, "#ircx", "a");

        assert_eq!(held(&store, "#ircx"), 1);
    }
}

/// A client's own message has no `msgid` until the server echoes it back, and
/// without `echo-message` no echo ever comes. `written_at` is what a replay of
/// that message is recognised by instead. #333.
mod a_replay_of_our_own_message {
    use super::*;

    /// The local copy as `say` files it: ours, client-stamped, no msgid.
    fn ours(id: &str, timestamp: &str, text: &str) -> ChatMessage {
        let mut message = message(id, "#ircx", timestamp, text);
        message.sender.is_self = true;
        message.timestamp_is_local = true;
        message.delivery = Delivery::Pending;
        message
    }

    /// A server stamp from about now. The match is bounded against this
    /// machine's clock, so a fixture in 2999 is correctly refused as too old to
    /// be the line just written — which is what `leaves_a_copy_too_old_to_be…`
    /// below asserts on purpose.
    fn about_now() -> String {
        time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .expect("format now")
    }

    /// The same line coming back inside a `CHATHISTORY` batch, stamped by the
    /// server and carrying the msgid the local copy never got.
    fn replayed(msgid: &str, timestamp: &str, text: &str) -> ChatMessage {
        let mut message = with_msgid(message(msgid, "#ircx", timestamp, text), msgid);
        message.sender.is_self = true;
        message.timestamp_is_local = false;
        message.delivery = Delivery::Delivered;
        message.batch = Some("1".into());
        message
    }

    /// Puts a copy in the archive and reports it written, which is what stamps
    /// `written_at`.
    fn sent(store: &Store, message: &ChatMessage) {
        store
            .append_messages(std::slice::from_ref(message))
            .unwrap();
        let mut written = message.clone();
        written.delivery = Delivery::Sent;
        store.update_message(&written).unwrap();
    }

    fn texts(store: &Store) -> Vec<String> {
        store
            .load_history(&history("#ircx", None, 50))
            .unwrap()
            .into_iter()
            .map(|message| message.text)
            .collect()
    }

    #[test]
    fn claims_the_copy_already_drawn_instead_of_doubling_it() {
        let store = Store::open_in_memory().unwrap();
        let copy = ours("local-1", &about_now(), "line 07 of the paste");
        sent(&store, &copy);

        store
            .append_messages(&[replayed("srv-1", &about_now(), "line 07 of the paste")])
            .unwrap();

        assert_eq!(texts(&store), vec!["line 07 of the paste"]);
        let held = store.load_history(&history("#ircx", None, 50)).unwrap();
        assert_eq!(held[0].id, "local-1", "the id the window drew it with");
        assert!(held[0].id_is_local, "which is still the local one");
        assert_eq!(
            held[0].tags,
            vec![("msgid".to_string(), Some("srv-1".to_string()))],
            "and the msgid a reply or a reaction names"
        );
        assert!(held[0].timestamp_is_local, "typed time, not send time");
    }

    /// The reason a copy is matched at all is that it reached the socket.
    /// Nothing else in the archive can have been what came back.
    #[test]
    fn leaves_a_copy_that_never_left() {
        let store = Store::open_in_memory().unwrap();
        let copy = ours("local-1", FUTURE, "into the void");
        store.append_messages(&[copy]).unwrap();

        store
            .append_messages(&[replayed("srv-1", FUTURE, "into the void")])
            .unwrap();

        assert_eq!(
            texts(&store).len(),
            2,
            "a pending copy is not what the server replayed"
        );
    }

    #[test]
    fn pairs_repeated_lines_up_in_the_order_they_were_said() {
        let store = Store::open_in_memory().unwrap();
        sent(&store, &ours("local-1", &about_now(), "ok"));
        sent(&store, &ours("local-2", &about_now(), "ok"));

        store
            .append_messages(&[
                replayed("srv-1", &about_now(), "ok"),
                replayed("srv-2", &about_now(), "ok"),
            ])
            .unwrap();

        let held = store.load_history(&history("#ircx", None, 50)).unwrap();
        assert_eq!(held.len(), 2, "two said, two held");
        // Which msgid landed on which copy is the whole of it: a reply names a
        // msgid, and the two rows are identical in everything else.
        let paired: Vec<(&str, Option<&str>)> = held
            .iter()
            .map(|message| {
                let msgid = message
                    .tags
                    .iter()
                    .find(|(name, _)| name == "msgid")
                    .and_then(|(_, value)| value.as_deref());
                (message.id.as_str(), msgid)
            })
            .collect();
        assert_eq!(
            paired,
            vec![("local-1", Some("srv-1")), ("local-2", Some("srv-2"))],
            "oldest copy takes the first replay"
        );
    }

    /// Unbounded, a replay could claim a copy from weeks ago — and then the
    /// message that actually arrived is never archived at all.
    #[test]
    fn leaves_a_copy_too_old_to_be_the_one_replayed() {
        let store = Store::open_in_memory().unwrap();
        sent(&store, &ours("local-1", ANCIENT, "ok"));

        store
            .append_messages(&[replayed("srv-1", ANCIENT, "ok")])
            .unwrap();

        assert_eq!(
            texts(&store).len(),
            2,
            "the copy was written now, and the replay is stamped in 2000"
        );
    }

    #[test]
    fn leaves_somebody_else_saying_the_same_thing() {
        let store = Store::open_in_memory().unwrap();
        sent(&store, &ours("local-1", &about_now(), "ok"));

        let mut theirs = replayed("srv-1", &about_now(), "ok");
        theirs.sender.is_self = false;
        theirs.sender.nick = "sable".into();
        store.append_messages(&[theirs]).unwrap();

        assert_eq!(texts(&store).len(), 2);
    }
}

/// FTS5's query language is a language, and the search box is a text field a
/// person types into. `fts_phrases` quotes every whitespace-separated run and
/// doubles a typed quote, so nothing anybody types is read as an operator —
/// but the failure mode if that ever slips is a syntax error thrown at somebody
/// who typed `:)`, so it is worth a battery rather than an example.
///
/// What each query *finds* is not asserted here. What is asserted is that
/// searching never fails.
#[test]
fn nothing_a_person_can_type_is_a_syntax_error() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message(
            "a",
            "#ircx",
            "2026-01-01T00:00:00Z",
            "the deploy is stuck and it printed :) at me",
        )])
        .unwrap();

    for query in [
        // FTS5 operators and syntax, typed literally.
        "AND",
        "OR",
        "NOT",
        "NEAR",
        "*",
        "^",
        "\"",
        "\"\"",
        "(",
        ")",
        "()",
        "{}",
        "-stuck",
        "a OR b",
        "NEAR(a b)",
        "col:value",
        "\"unclosed",
        // Punctuation that tokenises to nothing at all.
        ":)",
        "#",
        "...",
        "!!!",
        "?",
        "/",
        "\\",
        "|",
        // Things people paste.
        "https://example.com/a?b=1",
        "foo_bar()",
        "C++",
        "C#",
        "don't",
        // Not Latin, and not letters.
        "サーバー",
        "café",
        "🔥",
        "🔥🔥",
    ] {
        let answer = store.search(&SearchRequest {
            query: query.into(),
            network: None,
            target: None,
            sender: None,
            after: None,
            limit: 10,
        });
        assert!(
            answer.is_ok(),
            "searching for {query:?} failed: {:?}",
            answer.err()
        );
    }
}

/// Which index answers, and the order they are asked in. `messages_fts` is
/// `unicode61` and matches whole tokens; `messages_substr` is `trigram` and
/// matches any run of three characters; below three characters neither can
/// help and the text itself is read. #378.
#[test]
fn a_substring_is_found_only_where_a_whole_word_was_not() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message("a", "#ircx", "2026-01-01T00:00:00Z", "the deploy is stuck"),
            message("b", "#ircx", "2026-01-01T00:00:01Z", "サーバーが落ちた"),
        ])
        .unwrap();

    let found = |query: &str| {
        store
            .search(&SearchRequest {
                query: query.into(),
                network: None,
                target: None,
                sender: None,
                after: None,
                limit: 10,
            })
            .unwrap()
            .len()
    };

    // A word is a token, and space-separated words are found on their own.
    assert_eq!(found("deploy"), 1);
    assert_eq!(
        found("deploy stuck"),
        1,
        "phrases are ANDed, not adjacent-only"
    );
    // The run with no spaces in it is one token, so the whole of it matches.
    assert_eq!(found("サーバーが落ちた"), 1);
    // And a word inside it, which is the whole point of the second index: it
    // is the only way to search Japanese, Chinese or Thai short of typing the
    // message back.
    assert_eq!(found("落ちた"), 1);
    assert_eq!(found("サーバー"), 1);

    // The fallback is a fallback. Part of a Latin word is found because the
    // whole-word index answered nothing for it — and the consequence, worth
    // knowing: a query's results can shrink as the archive grows, because a
    // whole-word hit appearing later stops the substring pass from running.
    assert_eq!(found("eploy"), 1);

    // Under three characters there is no trigram either, and the scan is what
    // is left. It is the only thing that can find a lone emoji.
    assert_eq!(found("落ち"), 1);
    assert_eq!(found("ちた"), 1);
}

/// The other half of #378: an emoji produced no token under `unicode61` and
/// produces no trigram either, being one character. Both indexes are blind to
/// it and the scan is not.
#[test]
fn an_emoji_is_findable_and_does_not_join_the_words_around_it() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message(
                "a",
                "#ircx",
                "2026-01-01T00:00:00Z",
                "the build failed 🔥 badly",
            ),
            message(
                "b",
                "#ircx",
                "2026-01-01T00:00:01Z",
                "the build failed badly",
            ),
        ])
        .unwrap();

    let found = |query: &str| {
        store
            .search(&SearchRequest {
                query: query.into(),
                network: None,
                target: None,
                sender: None,
                after: None,
                limit: 10,
            })
            .unwrap()
            .into_iter()
            .map(|hit| hit.message.id)
            .collect::<Vec<_>>()
    };

    assert_eq!(found("🔥"), ["a"]);
    // Which is not the same as the emoji separating the words: `unicode61`
    // drops it, so both messages read as "failed badly" to the first index.
    assert_eq!(found("failed badly"), ["b", "a"]);
}

/// The scan builds its own snippet, the FTS paths having a `snippet()` to do
/// it. Same shape, so the frontend reads one thing.
#[test]
fn the_scanned_hit_marks_what_matched() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[message(
            "a",
            "#ircx",
            "2026-01-01T00:00:00Z",
            "everything was fine and then the build failed 🔥 and I went home \
             before anybody could tell me why it had",
        )])
        .unwrap();

    let hit = store
        .search(&SearchRequest {
            query: "🔥".into(),
            network: None,
            target: None,
            sender: None,
            after: None,
            limit: 10,
        })
        .unwrap()
        .remove(0);

    assert!(
        hit.snippet.contains("<mark>🔥</mark>"),
        "the hit is marked where it was found: {}",
        hit.snippet
    );
    assert!(
        hit.snippet.starts_with('…') && hit.snippet.ends_with('…'),
        "and the message it was clipped out of is shown as clipped: {}",
        hit.snippet
    );
}

/// A LIKE pattern is not what the user typed. Without escaping, `_` matches any
/// character and `%` matches everything, so a search for either returns the
/// archive.
#[test]
fn a_wildcard_typed_into_the_search_box_is_a_character_to_look_for() {
    let store = Store::open_in_memory().unwrap();
    store
        .append_messages(&[
            message(
                "a",
                "#ircx",
                "2026-01-01T00:00:00Z",
                "rate_limit is the flag",
            ),
            message("b", "#ircx", "2026-01-01T00:00:01Z", "nothing special here"),
            message("c", "#ircx", "2026-01-01T00:00:02Z", "100% certain"),
        ])
        .unwrap();

    let found = |query: &str| {
        store
            .search(&SearchRequest {
                query: query.into(),
                network: None,
                target: None,
                sender: None,
                after: None,
                limit: 10,
            })
            .unwrap()
            .into_iter()
            .map(|hit| hit.message.id)
            .collect::<Vec<_>>()
    };

    assert_eq!(found("_"), ["a"]);
    assert_eq!(found("%"), ["c"]);
}

/// The list somebody typed, in the order they typed it. Alphabetical would
/// reorder the page under them on every save.
#[test]
fn highlight_words_keep_the_order_they_were_written_in() {
    let store = Store::open_in_memory().unwrap();
    store
        .set_highlight_words(&["release".into(), "deploy".into(), "oncall".into()])
        .unwrap();

    assert_eq!(
        store.highlight_words().unwrap(),
        ["release", "deploy", "oncall"]
    );
}

/// The match is caseless, so two spellings are one word. The first one typed is
/// the one kept, which is the spelling the page shows back.
#[test]
fn one_word_twice_in_any_case_is_one_row() {
    let store = Store::open_in_memory().unwrap();
    store
        .set_highlight_words(&["Deploy".into(), "deploy".into(), "DEPLOY".into()])
        .unwrap();

    assert_eq!(store.highlight_words().unwrap(), ["Deploy"]);
}

/// Wholesale, because a word has no identity beyond itself: adding one and
/// removing one are the same write.
#[test]
fn writing_the_words_replaces_whatever_was_there() {
    let store = Store::open_in_memory().unwrap();
    store.set_highlight_words(&["deploy".into()]).unwrap();
    store.set_highlight_words(&["oncall".into()]).unwrap();

    assert_eq!(store.highlight_words().unwrap(), ["oncall"]);

    store.set_highlight_words(&[]).unwrap();
    assert!(store.highlight_words().unwrap().is_empty());
}

/// A row is the whole state, so unmuting is a deletion and asking about
/// something never muted is an empty answer rather than a missing one.
#[test]
fn muting_is_a_row_and_unmuting_takes_it_away() {
    let store = Store::open_in_memory().unwrap();
    store.set_muted("libera", Some("#ircx"), true).unwrap();
    store.set_muted("libera", None, true).unwrap();

    let mut targets = store.muted_targets("libera").unwrap();
    targets.sort();
    assert_eq!(
        targets,
        ["", "#ircx"],
        "an empty target is the network itself"
    );

    store.set_muted("libera", Some("#ircx"), false).unwrap();
    assert_eq!(store.muted_targets("libera").unwrap(), [""]);
}

/// The settings window has no network list to look an id up in, so the name
/// travels with it.
#[test]
fn the_muted_list_names_the_network() {
    let store = Store::open_in_memory().unwrap();
    let id = store.save_network(&network("Libera.Chat")).unwrap();
    store.set_muted(&id, Some("#ircx"), true).unwrap();
    store.set_muted("gone", Some("#orphan"), true).unwrap();

    let listed = store.muted_conversations().unwrap();
    assert!(
        listed.contains(&(id.clone(), "Libera.Chat".into(), "#ircx".into())),
        "the configured network is named: {listed:?}"
    );
    assert!(
        listed.contains(&("gone".into(), "gone".into(), "#orphan".into())),
        "a network with no config falls back to its id rather than vanishing: {listed:?}"
    );
}

/// A mute follows a renamed query the way its draft does. Leaving it behind
/// fails in the direction that interrupts you.
#[test]
fn a_mute_follows_a_renamed_query() {
    let store = Store::open_in_memory().unwrap();
    store.set_muted("libera", Some("buildbot"), true).unwrap();
    store.move_muted("libera", "buildbot", "buildbot_").unwrap();

    assert_eq!(store.muted_targets("libera").unwrap(), ["buildbot_"]);
}

/// Mute is a setting, and one on a network that is gone is one nobody can find
/// to undo.
#[test]
fn removing_a_network_takes_its_mutes() {
    let store = Store::open_in_memory().unwrap();
    let id = store.save_network(&network("Libera.Chat")).unwrap();
    store.set_muted(&id, Some("#ircx"), true).unwrap();
    store.remove_network(&id).unwrap();

    assert!(store.muted_targets(&id).unwrap().is_empty());
}

/// The session folds a nick by the network's casemapping before it asks, but
/// the row was written in whatever case somebody typed, so the delete has to
/// find it caselessly.
#[test]
fn unignoring_finds_the_row_whatever_case_it_was_typed_in() {
    let store = Store::open_in_memory().unwrap();
    store.set_ignored("libera", "Spambot", true).unwrap();

    assert_eq!(store.ignored_nicks("libera").unwrap(), ["Spambot"]);

    store.set_ignored("libera", "spambot", false).unwrap();
    assert!(store.ignored_nicks("libera").unwrap().is_empty());
}

/// An ignore is per network, because a nick means nothing without the network
/// it was said on: the same eight letters are two different people.
#[test]
fn an_ignore_does_not_cross_networks() {
    let store = Store::open_in_memory().unwrap();
    store.set_ignored("libera", "spambot", true).unwrap();

    assert!(store.ignored_nicks("oftc").unwrap().is_empty());
}

/// The settings window has no network list to look an id up in, so the name
/// travels with it, the way it does for a mute.
#[test]
fn the_ignored_list_names_the_network() {
    let store = Store::open_in_memory().unwrap();
    let id = store.save_network(&network("Libera.Chat")).unwrap();
    store.set_ignored(&id, "spambot", true).unwrap();
    store.set_ignored("gone", "someone", true).unwrap();

    let listed = store.ignored_people().unwrap();
    assert!(
        listed.contains(&(id.clone(), "Libera.Chat".into(), "spambot".into())),
        "the configured network is named: {listed:?}"
    );
    assert!(
        listed.contains(&("gone".into(), "gone".into(), "someone".into())),
        "a network with no config falls back to its id rather than vanishing: {listed:?}"
    );
}

/// An ignore is a setting, and one on a network that is gone is one nobody can
/// find to undo.
#[test]
fn removing_a_network_takes_its_ignores() {
    let store = Store::open_in_memory().unwrap();
    let id = store.save_network(&network("Libera.Chat")).unwrap();
    store.set_ignored(&id, "spambot", true).unwrap();
    store.remove_network(&id).unwrap();

    assert!(store.ignored_nicks(&id).unwrap().is_empty());
}

/// Stored and read back in the order they were written, as the words beside
/// them are, and one spelling per name however it was cased.
#[test]
fn hushed_nicks_round_trip_in_the_order_they_were_written() {
    let store = Store::open_in_memory().unwrap();
    assert!(store.hushed_nicks().unwrap().is_empty());

    store
        .set_hushed_nicks(&["NickServ".into(), "ChanServ".into()])
        .unwrap();
    assert_eq!(store.hushed_nicks().unwrap(), ["NickServ", "ChanServ"]);

    // The caseless key: the spelling typed first is the one kept.
    store
        .set_hushed_nicks(&["NickServ".into(), "nickserv".into()])
        .unwrap();
    assert_eq!(store.hushed_nicks().unwrap(), ["NickServ"]);

    store.set_hushed_nicks(&[]).unwrap();
    assert!(store.hushed_nicks().unwrap().is_empty());
}

/// Nobody has chosen yet on a database that has just been made, and the answer
/// then is to hide: a client that keeps running is what a status icon is for.
#[test]
fn closing_to_the_tray_is_the_answer_until_somebody_says_otherwise() {
    let store = Store::open_in_memory().unwrap();
    assert!(store.close_to_tray().unwrap());

    store.set_close_to_tray(false).unwrap();
    assert!(!store.close_to_tray().unwrap());

    store.set_close_to_tray(true).unwrap();
    assert!(store.close_to_tray().unwrap());
}

/// Never, until somebody chooses a number. An away status the reader did not
/// ask for is this client saying something about them that they never said.
#[test]
fn nobody_is_marked_away_for_a_setting_they_never_made() {
    let store = Store::open_in_memory().unwrap();
    assert_eq!(store.away_after().unwrap(), None);

    store.set_away_after(Some(15)).unwrap();
    assert_eq!(store.away_after().unwrap(), Some(15));

    // Off is a row saying zero as much as it is no row at all, because turning
    // it off is a choice made after one that wrote something down.
    store.set_away_after(None).unwrap();
    assert_eq!(store.away_after().unwrap(), None);
}
