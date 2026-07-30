use rusqlite::Connection;

use crate::StoreError;

const MIGRATIONS: &[&str] = &[INITIAL, MESSAGE_ID_INDEX, OPEN_TARGETS, REACTIONS, VIA];

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

/// Which plugin produced a message, by its id. Null for everything the client
/// or the server said, which is every row written before this.
const VIA: &str = r#"
ALTER TABLE messages ADD COLUMN via TEXT;
"#;

#[cfg(test)]
mod tests {
    use super::*;

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
