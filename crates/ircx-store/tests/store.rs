use ircx_ipc::{
    Attachment, AttachmentPreview, ChatMessage, Delivery, EncryptionState, HistoryRequest,
    MessageKind, MessageSource, NetworkConfig, SaslConfig, SaslMechanism, SearchRequest, Sender,
};
use ircx_store::Store;

/// Old enough to fall outside any retention window used here.
const ANCIENT: &str = "2000-01-01T00:00:00Z";

/// Stands in for "just now" without pulling in a clock: no retention window
/// reaches into the future, so these messages always survive a prune.
const FUTURE: &str = "2999-01-01T00:00:00Z";

fn message(id: &str, target: &str, timestamp: &str, text: &str) -> ChatMessage {
    ChatMessage {
        id: id.into(),
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

#[test]
fn a_malformed_search_is_reported_as_a_query_error() {
    let store = Store::open_in_memory().unwrap();
    let err = store
        .search(&SearchRequest {
            query: "AND".into(),
            network: None,
            target: None,
            limit: 10,
        })
        .unwrap_err();

    assert!(
        matches!(err, ircx_store::StoreError::Search(_)),
        "expected a search error, got {err:?}"
    );
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
