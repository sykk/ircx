use rusqlite::Connection;

use crate::StoreError;

const MIGRATIONS: &[&str] = &[
    INITIAL,
    MESSAGE_ID_INDEX,
    OPEN_TARGETS,
    REACTIONS,
    VIA,
    ANNOTATIONS,
    RAISED,
    UPLOAD_PROVIDER,
    UPLOAD_S3,
    WRITTEN_AT,
    SUBSTRING_INDEX,
    CLIENT_CERTIFICATE,
    TIMELINE_NOCASE,
    UPLOAD_FORM,
    HIGHLIGHT_WORDS,
    MUTED,
    STS_POLICY,
    BOOKMARKS,
];

/// Applies every migration the database has not seen yet. Safe to call on a
/// database at any earlier version, including an empty one.
pub(crate) fn migrate(conn: &mut Connection) -> Result<(), StoreError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
             version    INTEGER PRIMARY KEY,
             applied_at TEXT NOT NULL
         )",
    )?;

    let current: u32 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_version",
        [],
        |row| row.get(0),
    )?;
    let supported = MIGRATIONS.len() as u32;
    if current > supported {
        return Err(StoreError::SchemaTooNew {
            found: current,
            supported,
        });
    }

    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_version (version, applied_at)
             VALUES (?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))",
            [index as u32 + 1],
        )?;
        tx.commit()?;
    }

    Ok(())
}

const INITIAL: &str = r#"
CREATE TABLE networks (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    host             TEXT NOT NULL,
    port             INTEGER NOT NULL,
    tls              INTEGER NOT NULL,
    tls_verify       INTEGER NOT NULL,
    nick             TEXT NOT NULL,
    alt_nicks        TEXT NOT NULL,
    username         TEXT NOT NULL,
    realname         TEXT NOT NULL,
    sasl_mechanism   TEXT,
    sasl_account     TEXT,
    connect_commands TEXT NOT NULL,
    autojoin         TEXT NOT NULL,
    auto_connect     INTEGER NOT NULL
);

CREATE TABLE messages (
    id                 INTEGER PRIMARY KEY,
    message_id         TEXT NOT NULL,
    server_msgid       TEXT,
    network            TEXT NOT NULL,
    target             TEXT NOT NULL,
    kind               TEXT NOT NULL,
    sender_nick        TEXT NOT NULL,
    sender_user        TEXT,
    sender_host        TEXT,
    sender_account     TEXT,
    sender_is_self     INTEGER NOT NULL,
    timestamp          TEXT NOT NULL,
    timestamp_is_local INTEGER NOT NULL,
    text               TEXT NOT NULL,
    tags               TEXT NOT NULL,
    reply_to           TEXT,
    batch              TEXT,
    delivery           TEXT NOT NULL,
    attachments        TEXT NOT NULL,
    encryption         TEXT NOT NULL,
    raw                TEXT NOT NULL
);

CREATE INDEX idx_messages_timeline ON messages (network, target, timestamp DESC);

CREATE UNIQUE INDEX idx_messages_msgid ON messages (network, server_msgid)
    WHERE server_msgid IS NOT NULL;

-- Replayed history without a msgid can only be recognised by its content.
CREATE UNIQUE INDEX idx_messages_content
    ON messages (network, target, timestamp, sender_nick, text)
    WHERE server_msgid IS NULL;

CREATE VIRTUAL TABLE messages_fts USING fts5 (
    text,
    content = 'messages',
    content_rowid = 'id'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE drafts (
    network TEXT NOT NULL,
    target  TEXT NOT NULL,
    text    TEXT NOT NULL,
    PRIMARY KEY (network, target)
);

-- An empty target is the network-wide default. A sentinel rather than NULL
-- because SQLite lets NULL repeat inside a primary key.
CREATE TABLE retention (
    network TEXT NOT NULL,
    target  TEXT NOT NULL,
    days    INTEGER,
    PRIMARY KEY (network, target)
);
"#;

/// Confirming a delivery reaches its row by the id the message was drawn with,
/// which is the one lookup the timeline index cannot serve.
const MESSAGE_ID_INDEX: &str = r#"
CREATE INDEX idx_messages_message_id ON messages (network, message_id);
"#;

/// The conversations that were open when the app last ran. Separate from
/// `networks.autojoin`, which is a preference only the user edits: this is a
/// record of where they were, and closing a conversation deletes its row.
const OPEN_TARGETS: &str = r#"
CREATE TABLE open_targets (
    network TEXT NOT NULL,
    target  TEXT NOT NULL,
    kind    TEXT NOT NULL,
    PRIMARY KEY (network, target)
);
"#;

/// Reactions key on the `msgid` the `+reply` tag named, not on a row in
/// `messages`. There is deliberately no foreign key: a reaction can arrive for
/// a message this archive has never held, and the row has to survive until the
/// message turns up — from a `chathistory` backfill, or never.
///
/// The unique index is the retraction rule as well as a constraint: one person
/// holds one of each reaction on a message, so sending it twice adds nothing
/// and `+draft/unreact` has exactly one row to remove.
const REACTIONS: &str = r#"
CREATE TABLE reactions (
    id      INTEGER PRIMARY KEY,
    network TEXT NOT NULL,
    msgid   TEXT NOT NULL,
    nick    TEXT NOT NULL,
    emoji   TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_reactions_one_each ON reactions (network, msgid, nick, emoji);
"#;

/// The PEM a network presents to authenticate with SASL EXTERNAL. Null for
/// every network configured before this, which is every network that has been
/// configured: nothing could present one until #401.
///
/// The path, not the key. A private key copied in here would be a second copy
/// of the secret with none of the file's permissions, and the passwords beside
/// it are in the keyring rather than in this file for the same reason.
const CLIENT_CERTIFICATE: &str = r#"
ALTER TABLE networks ADD COLUMN client_certificate TEXT;
"#;

/// The timeline queries match `target` without case (`load_history` says why),
/// which the BINARY-collated index could not serve: SQLite used it for the
/// network alone, then scanned that network's every row and sorted them in a
/// temp B-tree — per history page, per backfill anchor, per replayed self
/// message. Declaring the collation on the column brings the seek back.
const TIMELINE_NOCASE: &str = r#"
DROP INDEX idx_messages_timeline;
CREATE INDEX idx_messages_timeline
    ON messages (network, target COLLATE NOCASE, timestamp DESC);
"#;

/// Which plugin produced a message, by its id. Null for everything the client
/// or the server said, which is every row written before this.
const VIA: &str = r#"
ALTER TABLE messages ADD COLUMN via TEXT;
"#;

/// What a plugin said about a message. Keyed by the message and the plugin, so
/// a plugin that answers the same message twice replaces what it said: the
/// annotator runs on arrival, and a history backfill can hand it the same
/// message a second time.
///
/// A row can name a message the archive does not hold, exactly as a reaction
/// can, and waits for one.
const ANNOTATIONS: &str = r#"
CREATE TABLE annotations (
    network TEXT NOT NULL,
    msgid   TEXT NOT NULL,
    plugin  TEXT NOT NULL,
    text    TEXT NOT NULL,
    PRIMARY KEY (network, msgid, plugin)
);
"#;

/// Where an attachment goes before its link is sent. One row or none: "no
/// provider" is a configuration the spec names, and it is the absence of the
/// row rather than a flag on it.
///
/// The token is not here. It goes to the OS keyring beside the SASL passwords,
/// for the same reason.
const UPLOAD_PROVIDER: &str = r#"
CREATE TABLE upload_provider (
    only        INTEGER PRIMARY KEY CHECK (only = 0),
    endpoint    TEXT NOT NULL,
    method      TEXT NOT NULL,
    auth_header TEXT
);
"#;

/// S3-compatible storage signs the request instead of sending a token, so it
/// needs two more things stored and the same one secret. Null in both columns
/// is the provider kind that was here before.
const UPLOAD_S3: &str = r#"
ALTER TABLE upload_provider ADD COLUMN s3_region TEXT;
ALTER TABLE upload_provider ADD COLUMN s3_access_key_id TEXT;
"#;

/// A host that takes the file as a form upload rather than as the request
/// body, which is what the hosts asking for no account take. The field the file
/// goes in and whatever else the host wants told, as the JSON `FormUpload`
/// serialises to; null is a provider that sends the file as the body.
const UPLOAD_FORM: &str = r#"
ALTER TABLE upload_provider ADD COLUMN form TEXT;
"#;

/// When a message of ours reached the socket, on this machine's clock. The
/// `timestamp` beside it is when it was typed, and a rate-limited line can sit
/// between the two for the better part of a minute.
///
/// It is what a history replay is matched against where the server does not
/// echo, so nothing else can tell the replay from a message never seen before.
/// Rows already archived have none and go on doubling; there is nothing to
/// infer it from. #333.
const WRITTEN_AT: &str = r#"
ALTER TABLE messages ADD COLUMN written_at TEXT;
"#;

/// Which messages a notification rule thought worth interrupting the user for,
/// and which rule thought so. Keyed the same way an annotation is, so a plugin
/// answering the same message twice raises it once.
///
/// There is no row for a message a rule passed over: a rule raises and cannot
/// lower, so absence is the only thing "not raised" could mean.
const RAISED: &str = r#"
CREATE TABLE raised (
    network TEXT NOT NULL,
    msgid   TEXT NOT NULL,
    plugin  TEXT NOT NULL,
    PRIMARY KEY (network, msgid, plugin)
);
"#;

/// A second index over the same column, tokenised into overlapping
/// three-character runs, so a search can reach inside a word.
///
/// `unicode61` splits on non-alphanumerics, which is the whole story for a
/// language that puts spaces between its words and no story at all for one that
/// does not: `サーバーが落ちた` is a single token, so the only query that finds
/// it is the entire message typed back. This one indexes `サーバ`, `ーバー`,
/// `ーが落` and so on, so `落ちた` reaches it.
///
/// It does not replace `messages_fts`, which is why both are here. Trigram
/// matches nothing shorter than three characters, so it cannot answer `ok` or
/// `hi` — ordinary Latin queries that the whole-word index answers today.
/// Neither index is a superset of the other, and `Store::search` picks.
///
/// Two costs, both in `docs/measurements.md`: a third of the archive on disk,
/// and the `rebuild` below, which is what an archive that already exists pays
/// on the one launch that applies this — 786 ms for 100,000 messages, inside
/// `Store::open`. Doing it in the background instead would leave a window where
/// search answers one thing for old history and another for new, which is worse
/// than a slow launch.
const SUBSTRING_INDEX: &str = r#"
CREATE VIRTUAL TABLE messages_substr USING fts5 (
    text,
    tokenize = 'trigram',
    content = 'messages',
    content_rowid = 'id'
);

INSERT INTO messages_substr (messages_substr) VALUES ('rebuild');

CREATE TRIGGER messages_substr_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_substr (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER messages_substr_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_substr (messages_substr, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER messages_substr_update AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_substr (messages_substr, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO messages_substr (rowid, text) VALUES (new.id, new.text);
END;
"#;

/// The words that raise a conversation the way the reader's nickname does.
///
/// One table for the client rather than one per network: the question a word
/// answers is "tell me when anybody says this", and nobody means it about one
/// network and not another.
///
/// `NOCASE` because the match is case folded, so `Deploy` and `deploy` are one
/// word and the primary key is what says so. The reader's own spelling is what
/// comes back — the row is stored as it was typed, and only compared caselessly.
const HIGHLIGHT_WORDS: &str = r#"
CREATE TABLE highlight_word (
    word TEXT PRIMARY KEY COLLATE NOCASE
);
"#;

/// Conversations the reader does not want interrupting them.
///
/// Keyed the way `retention` is, and an empty target means the network itself
/// rather than one conversation on it. A row is the whole of it: mute is a
/// boolean, so present and absent are the two states and there is nothing to
/// store beside the key.
const MUTED: &str = r#"
CREATE TABLE muted (
    network TEXT NOT NULL,
    target  TEXT NOT NULL,
    PRIMARY KEY (network, target)
);
"#;

const STS_POLICY: &str = r#"
CREATE TABLE sts_policy (
    host       TEXT PRIMARY KEY COLLATE NOCASE,
    port       INTEGER,
    expires_at INTEGER NOT NULL
);
"#;

const BOOKMARKS: &str = r#"
CREATE TABLE bookmarks (
    message INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE
);
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// The caseless target match has to be a seek. With the BINARY-collated
    /// index it degraded to scanning the whole network's rows and sorting
    /// them, on every history page — asserted on the plan, because the query
    /// answers correctly either way and nothing else would catch the slide.
    #[test]
    fn the_timeline_index_serves_the_caseless_match() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();

        let plan: String = conn
            .query_row(
                "EXPLAIN QUERY PLAN
                 SELECT id FROM messages
                  WHERE network = 'n' AND target = '#c' COLLATE NOCASE
                  ORDER BY timestamp DESC LIMIT 50",
                [],
                |row| row.get(3),
            )
            .unwrap();
        assert!(
            plan.contains("idx_messages_timeline") && plan.contains("target=?"),
            "the match should seek the index, not scan the network: {plan}"
        );
    }

    #[test]
    fn applies_once_and_is_idempotent_on_reopen() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        migrate(&mut conn).unwrap();

        let versions: Vec<u32> = conn
            .prepare("SELECT version FROM schema_version ORDER BY version")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(versions, (1..=MIGRATIONS.len() as u32).collect::<Vec<_>>());
    }

    /// The upgrade a user with an existing archive takes. Every earlier
    /// migration has to still apply on top of real rows, and the new table has
    /// to arrive without touching them.
    #[test]
    fn an_archive_one_version_behind_gains_the_table_and_keeps_its_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        for sql in MIGRATIONS.iter().take(MIGRATIONS.len() - 1) {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (
                 version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        )
        .unwrap();
        for version in 1..MIGRATIONS.len() as u32 {
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?1, '')",
                [version],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO messages (message_id, network, target, kind, sender_nick,
                                   sender_is_self, timestamp, timestamp_is_local, text,
                                   tags, delivery, attachments, encryption, raw)
             VALUES ('m1','libera','#ircx','privmsg','sable',0,'2026-01-01T00:00:00Z',0,
                     'hello','[]','\"delivered\"','[]','plaintext','')",
            [],
        )
        .unwrap();

        migrate(&mut conn).unwrap();

        let held: u32 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(held, 1, "the upgrade keeps what was already archived");
        // Whatever the last migration added, reached through the row that was
        // already there. Naming the column rather than a table keeps this
        // honest as migrations are appended: it was an insert into `raised`
        // while that was last, which by then tested the migration before it.
        //
        // For the substring index that means the backfill: a message archived
        // before the index existed has to be in it, or search answers one thing
        // for old history and another for new.
        let indexed: u32 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages_substr WHERE messages_substr MATCH '\"ell\"'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            indexed, 1,
            "the rebuild reaches history older than the index"
        );
    }

    /// #401. The networks somebody already configured have to survive gaining
    /// the column, and come back with nothing in it rather than with a path
    /// they never set.
    #[test]
    fn a_network_configured_before_the_column_keeps_its_settings() {
        let mut conn = Connection::open_in_memory().unwrap();
        for sql in MIGRATIONS.iter().take(MIGRATIONS.len() - 1) {
            conn.execute_batch(sql).unwrap();
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (
                 version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
        )
        .unwrap();
        for version in 1..MIGRATIONS.len() as u32 {
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?1, '')",
                [version],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO networks (id, name, host, port, tls, tls_verify, nick, alt_nicks,
                                   username, realname, connect_commands, autojoin, auto_connect)
             VALUES ('n1','Libera','irc.libera.chat',6697,1,1,'sable','[]','sable','Sable',
                     '[]','[]',1)",
            [],
        )
        .unwrap();

        migrate(&mut conn).unwrap();

        let (nick, certificate): (String, Option<String>) = conn
            .query_row(
                "SELECT nick, client_certificate FROM networks WHERE id = 'n1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(nick, "sable");
        assert_eq!(certificate, None);
    }

    #[test]
    fn refuses_a_database_from_the_future() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn).unwrap();
        conn.execute(
            "INSERT INTO schema_version (version, applied_at) VALUES (99, '')",
            [],
        )
        .unwrap();

        let err = migrate(&mut conn).unwrap_err();
        assert!(matches!(err, StoreError::SchemaTooNew { found: 99, .. }));
    }
}
