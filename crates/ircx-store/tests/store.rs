use ircx_ipc::{
    Attachment, AttachmentPreview, ChatMessage, Delivery, EncryptionState, HistoryRequest,
    MessageKind, MessageSource, NetworkConfig, SaslConfig, SaslMechanism, SearchRequest, Sender,
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
        reply_to: None,
        batch: None,
        delivery: Delivery::Delivered,
        attachments: vec![],
        encryption: EncryptionState::Plaintext,
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
        nick: "sykk".into(),
        alt_nicks: vec!["sykk_".into(), "sykk__".into()],
        username: "sykk".into(),
        realname: "sykk on ircx".into(),
        sasl: None,
        connect_commands: vec!["MODE sykk +i".into()],
        autojoin: vec!["#ircx".into()],
        auto_connect: true,
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
            limit: 10,
        })
        .unwrap();
    assert!(missing.is_empty());
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
    assert!(found("\"").is_empty());
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
fn networks_round_trip_without_the_password() {
    let store = Store::open_in_memory().unwrap();
    let mut config = network("Libera");
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
    assert_eq!(saved.nick, config.nick);
    assert_eq!(saved.alt_nicks, config.alt_nicks);
    assert_eq!(saved.username, config.username);
    assert_eq!(saved.realname, config.realname);
    assert_eq!(saved.connect_commands, config.connect_commands);
    assert_eq!(saved.autojoin, config.autojoin);
    assert_eq!(saved.auto_connect, config.auto_connect);

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
