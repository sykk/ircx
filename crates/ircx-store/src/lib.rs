//! SQLite persistence: message archive with FTS5, drafts, network config, and
//! credentials held in the OS keyring.

mod credentials;
mod error;
mod message;
mod migrations;

pub use error::{in_words, StoreError};

use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use ircx_ipc::{
    ChatMessage, HistoryRequest, NetworkConfig, NetworkId, S3Credentials, SaslConfig, SearchHit,
    SearchRequest, TargetName, TransferSettings, UploadProvider,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde::Serialize;

use credentials::{CredentialStore, MemoryCredentials, OsKeyring};

const NETWORK_COLUMNS: &str = "id, name, host, port, tls, tls_verify, nick, alt_nicks, username, \
     realname, sasl_mechanism, sasl_account, connect_commands, autojoin, auto_connect, \
     client_certificate, socks5_proxy";

/// A network-wide retention rule is stored as a target override with no target.
const DEFAULT_TARGET: &str = "";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StsPolicy {
    pub port: Option<u16>,
    pub expires_at: i64,
}

/// One SQLite database, reached by more than one connection so that reading it
/// and changing it are not the same queue.
///
/// Until #435 there was one `Connection` behind one `Mutex`, and everything
/// took it: the archive writer, the archive sheet's two buttons, and the search
/// somebody types. A search issued during an export waited out the whole export
/// — 216 ms of a 265 ms one, and 700 ms of a 749 ms delete — because
/// `export_everything` holds the guard across every row. WAL was already on and
/// bought nothing, since the contention was the Rust mutex rather than SQLite.
///
/// Three roles, by how long each holds a connection:
///
/// - `write` is every mutation. One at a time is what SQLite wants anyway.
/// - `read` is every bounded read: a search, a page of history, the network
///   list. Each is a `LIMIT` or a single row, so they cost each other nothing
///   measurable by sharing one connection, and they no longer queue behind a
///   write.
/// - a read that walks the whole archive — the two exports — opens a connection
///   of its own and drops it, because two of those *would* cost each other.
///
/// What that leaves is `VACUUM`, which takes SQLite's own exclusive lock and
/// blocks readers whatever connection they are on. It is the short end of a
/// delete: at 60,000 messages the `DELETE` is 645 ms and the `VACUUM` 80 ms.
pub struct Store {
    write: Mutex<Connection>,
    /// `None` for an in-memory archive. `Connection::open_in_memory` gives each
    /// connection a database of its own, so a second one here would be a second
    /// empty archive rather than another way into this one.
    read: Option<Mutex<Connection>>,
    /// Where to open a connection for a read that walks everything. `None` for
    /// the same reason as `read`.
    path: Option<std::path::PathBuf>,
    credentials: Box<dyn CredentialStore>,
}

/// A connection for a read that walks everything: its own where the archive is
/// a file, the shared reader where it is in memory.
enum Walking<'a> {
    Own(Connection),
    Shared(MutexGuard<'a, Connection>),
}

impl std::ops::Deref for Walking<'_> {
    type Target = Connection;

    fn deref(&self) -> &Connection {
        match self {
            Self::Own(conn) => conn,
            Self::Shared(conn) => conn,
        }
    }
}

/// What the archive weighs, for a screen that would otherwise ask somebody to
/// trust a retention setting they cannot see the effect of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveSize {
    pub messages: u64,
    pub bytes: u64,
}

/// A conversation that was open when the app last ran. The kind travels with
/// the name because a name on its own cannot be read as one or the other
/// before the server has said what a channel looks like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenTarget {
    Channel(TargetName),
    Query(TargetName),
}

impl OpenTarget {
    pub fn name(&self) -> &str {
        match self {
            Self::Channel(name) | Self::Query(name) => name,
        }
    }

    fn kind(&self) -> &'static str {
        match self {
            Self::Channel(_) => "channel",
            Self::Query(_) => "query",
        }
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        Self::open_with(path, Box::new(OsKeyring))
    }

    /// An archive on disk whose credentials go to a process-local map instead
    /// of the OS keyring.
    ///
    /// For tests that need a real file — two connections onto one, a cold page
    /// cache — and have no business asking the machine for its keyring. A CI
    /// runner has no Secret Service to ask, and saving a network reaches the
    /// credential store whether or not the network has a password: it clears
    /// whatever was there before.
    pub fn open_without_keyring(path: &Path) -> Result<Self, StoreError> {
        Self::open_with(path, Box::new(MemoryCredentials::default()))
    }

    fn open_with(path: &Path, credentials: Box<dyn CredentialStore>) -> Result<Self, StoreError> {
        let opened = |source| StoreError::Open {
            path: path.to_path_buf(),
            source,
        };
        let conn = Connection::open(path).map_err(opened)?;
        let mut store = Self::init(conn, credentials)?;
        // After `init`, so the reader opens onto a schema the migrations have
        // already finished with.
        let read = Self::prepared(Connection::open(path).map_err(opened)?)?;
        store.read = Some(Mutex::new(read));
        store.path = Some(path.to_path_buf());
        Ok(store)
    }

    /// Ephemeral in every respect: passwords go to a process-local map instead
    /// of the OS keyring, so tests never write to the developer's login store.
    ///
    /// One connection, for the reason on `Store::read`.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory().map_err(|source| StoreError::Open {
            path: ":memory:".into(),
            source,
        })?;
        Self::init(conn, Box::new(MemoryCredentials::default()))
    }

    /// What every connection to the archive is set up with. `journal_mode` is
    /// written into the file and read back by the next connection; the other two
    /// belong to the connection and have to be said again on each.
    fn prepared(conn: Connection) -> Result<Connection, StoreError> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        Ok(conn)
    }

    fn init(conn: Connection, credentials: Box<dyn CredentialStore>) -> Result<Self, StoreError> {
        let mut conn = Self::prepared(conn)?;
        migrations::migrate(&mut conn)?;
        Ok(Self {
            write: Mutex::new(conn),
            read: None,
            path: None,
            credentials,
        })
    }

    /// A panic elsewhere leaves the connection usable: rusqlite rolls an open
    /// transaction back when its guard drops, so the poison flag is noise here.
    fn writing(&self) -> MutexGuard<'_, Connection> {
        self.write.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A read short enough that sharing one connection with the other short
    /// reads costs nothing. Falls back to the writer for an in-memory archive,
    /// which has only the one.
    fn reading(&self) -> MutexGuard<'_, Connection> {
        match &self.read {
            Some(read) => read.lock().unwrap_or_else(PoisonError::into_inner),
            None => self.writing(),
        }
    }

    /// A read that walks the whole archive, on a connection nothing else is
    /// waiting for. Two exports at once would otherwise be each other's
    /// problem, which is the fault #435 describes moved rather than fixed.
    ///
    /// A connection that cannot be opened is not worth failing an export over,
    /// so the shared reader is the fallback and the export still runs.
    fn walking(&self) -> Walking<'_> {
        match self.path.as_deref().map(Connection::open) {
            Some(Ok(conn)) => match Self::prepared(conn) {
                Ok(conn) => Walking::Own(conn),
                Err(_) => Walking::Shared(self.reading()),
            },
            _ => Walking::Shared(self.reading()),
        }
    }

    /// Messages already in the archive are skipped, so replaying history over
    /// an existing timeline is a no-op rather than a second copy.
    pub fn append_messages(&self, messages: &[ChatMessage]) -> Result<(), StoreError> {
        let mut conn = self.writing();
        let tx = conn.transaction()?;
        // A conversation set to keep nothing is not written and then swept: a
        // window of zero is somebody saying they do not want the record, and
        // written-then-deleted is not that. Looked up per conversation rather
        // than per message, since a batch is almost always one. #249.
        let mut asked: Vec<(String, String, bool)> = Vec::new();
        for message in messages {
            let keeping = match asked.iter().find(|(network, target, _)| {
                network == &message.network && target == &message.target
            }) {
                Some((_, _, keeping)) => *keeping,
                None => {
                    let keeping = keeps_anything(&tx, &message.network, &message.target)?;
                    asked.push((message.network.clone(), message.target.clone(), keeping));
                    keeping
                }
            };
            if keeping {
                message::insert(&tx, message)?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Applies what a server echo added to a message already archived: its
    /// delivery state, the server's msgid and time, the tags it arrived with.
    /// Silently does nothing when the message is not in the archive.
    pub fn update_message(&self, message: &ChatMessage) -> Result<(), StoreError> {
        message::confirm(&self.writing(), message)
    }

    /// When this conversation was last heard from, which is where a server-side
    /// backfill picks up. `None` when the archive holds nothing the server
    /// stamped.
    ///
    /// Client-stamped rows are ignored: this is a point in the server's own
    /// record, and a line this machine timestamped is a point in its clock. A
    /// fast clock would otherwise ask for the gap from after the messages in
    /// it. The session applies the same rule to what arrives live, so a rejoin
    /// and a relaunch ask from the same place.
    ///
    /// So are joins and quits, for the reason #565 gives: the join that ends an
    /// outage is stamped after everything said during it, and a conversation
    /// resumed from it asks for a gap that starts after its own contents.
    ///
    /// Matched without case for the reason `load_history` gives below.
    pub fn newest_timestamp(
        &self,
        network: &str,
        target: &str,
    ) -> Result<Option<String>, StoreError> {
        let conn = self.reading();
        let mut stmt = conn.prepare(
            r#"SELECT timestamp FROM messages
             WHERE network = ?1 AND target = ?2 COLLATE NOCASE
               AND timestamp_is_local = 0
               AND kind IN ('"privmsg"', '"notice"', '"action"')
             ORDER BY timestamp DESC, id DESC
             LIMIT 1"#,
        )?;
        let mut rows = stmt.query(params![network, target])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    /// Oldest first, so a caller can render the page in order. `before` pages
    /// backwards from the oldest message already on screen.
    ///
    /// The target is matched without case, because IRC compares targets that
    /// way and rows written before #190 hold whichever casing arrived. It is
    /// ASCII folding rather than the server's casemapping, which differs only
    /// for `[]\^` in a nick — and errs toward showing a message rather than
    /// losing one, which is the direction a reader can do something about.
    ///
    /// The two callers get two statements rather than one holding
    /// `?3 IS NULL OR m.timestamp < ?3`, which is #527. A disjunction is not
    /// something SQLite can put on the index, so that one statement started at
    /// the newest message whatever it was asked for and discarded its way down
    /// to the page — and a reader paging back paid for the whole distance
    /// again on every page. Written as a plain comparison it is a range the
    /// index serves, and the walk starts where it was asked to.
    ///
    /// The boundary is the timestamp *and* the row, which is #619. The order
    /// is total — timestamp, then rowid — and a filter naming the timestamp
    /// alone is not: every message sharing the oldest held one's millisecond
    /// falls between the page and the window, and the next ask names a bound
    /// that has moved past them. They stay in the archive, unreachable. The
    /// rowid is looked up rather than sent because the caller has the msgid
    /// and not the row, exactly as `load_history_around` does it below.
    ///
    /// This disjunction is not the one #527 was about. That one asked whether
    /// the *parameter* was null, which left SQLite nothing to seek to; this one
    /// is bounded above either way, and the planner reads `timestamp <= ?3` out
    /// of it and serves the same index seek as the plain comparison did.
    pub fn load_history(&self, req: &HistoryRequest) -> Result<Vec<ChatMessage>, StoreError> {
        let conn = self.reading();
        let boundary = match (&req.before, &req.before_id) {
            (Some(_), Some(id)) => conn
                .query_row(
                    "SELECT id FROM messages
                     WHERE network = ?1 AND target = ?2 COLLATE NOCASE AND message_id = ?3",
                    params![req.network, req.target, id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?,
            _ => None,
        };

        let sql = match (&req.before, boundary) {
            (Some(_), Some(_)) => format!(
                "SELECT {columns}
                 FROM messages m
                 WHERE m.network = ?1 AND m.target = ?2 COLLATE NOCASE
                   AND (m.timestamp < ?3 OR (m.timestamp = ?3 AND m.id < ?4))
                 ORDER BY m.timestamp DESC, m.id DESC
                 LIMIT ?5",
                columns = message::COLUMNS,
            ),
            (Some(_), None) => format!(
                "SELECT {columns}
                 FROM messages m
                 WHERE m.network = ?1 AND m.target = ?2 COLLATE NOCASE
                   AND m.timestamp < ?3
                 ORDER BY m.timestamp DESC, m.id DESC
                 LIMIT ?4",
                columns = message::COLUMNS,
            ),
            (None, _) => format!(
                "SELECT {columns}
                 FROM messages m
                 WHERE m.network = ?1 AND m.target = ?2 COLLATE NOCASE
                 ORDER BY m.timestamp DESC, m.id DESC
                 LIMIT ?3",
                columns = message::COLUMNS,
            ),
        };

        let mut stmt = conn.prepare(&sql)?;
        let mut rows = match (&req.before, boundary) {
            (Some(before), Some(row_id)) => {
                stmt.query(params![req.network, req.target, before, row_id, req.limit])?
            }
            (Some(before), None) => {
                stmt.query(params![req.network, req.target, before, req.limit])?
            }
            (None, _) => stmt.query(params![req.network, req.target, req.limit])?,
        };
        let mut page = Vec::new();
        while let Some(row) = rows.next()? {
            page.push(message::from_row(row)?);
        }
        message::attach_reactions(&conn, &mut page)?;
        message::attach_annotations(&conn, &mut page)?;
        message::attach_raised(&conn, &mut page)?;
        page.reverse();
        Ok(page)
    }

    pub fn load_history_around(
        &self,
        network: &str,
        target: &str,
        message_id: &str,
        limit: u32,
    ) -> Result<Vec<ChatMessage>, StoreError> {
        let conn = self.reading();
        let pivot: Option<(String, i64)> = conn
            .query_row(
                "SELECT timestamp, id FROM messages
                 WHERE network = ?1 AND target = ?2 COLLATE NOCASE AND message_id = ?3",
                params![network, target, message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((timestamp, row_id)) = pivot else {
            return Ok(Vec::new());
        };

        let before_limit = limit / 2 + 1;
        let after_limit = limit.saturating_sub(before_limit);
        let before_sql = format!(
            "SELECT {columns} FROM messages m
             WHERE m.network = ?1 AND m.target = ?2 COLLATE NOCASE
               AND (m.timestamp < ?3 OR (m.timestamp = ?3 AND m.id <= ?4))
             ORDER BY m.timestamp DESC, m.id DESC LIMIT ?5",
            columns = message::COLUMNS,
        );
        let after_sql = format!(
            "SELECT {columns} FROM messages m
             WHERE m.network = ?1 AND m.target = ?2 COLLATE NOCASE
               AND (m.timestamp > ?3 OR (m.timestamp = ?3 AND m.id > ?4))
             ORDER BY m.timestamp, m.id LIMIT ?5",
            columns = message::COLUMNS,
        );

        let mut before_stmt = conn.prepare(&before_sql)?;
        let mut before_rows =
            before_stmt.query(params![network, target, timestamp, row_id, before_limit])?;
        let mut messages = Vec::new();
        while let Some(row) = before_rows.next()? {
            messages.push(message::from_row(row)?);
        }
        messages.reverse();

        let mut after_stmt = conn.prepare(&after_sql)?;
        let mut after_rows =
            after_stmt.query(params![network, target, timestamp, row_id, after_limit])?;
        while let Some(row) = after_rows.next()? {
            messages.push(message::from_row(row)?);
        }
        message::attach_reactions(&conn, &mut messages)?;
        message::attach_annotations(&conn, &mut messages)?;
        message::attach_raised(&conn, &mut messages)?;
        Ok(messages)
    }

    /// Records one reaction, or takes it back. `msgid` need not be a message
    /// the archive holds: the row waits for one, which is what lets a reaction
    /// to something said before this client connected survive.
    ///
    /// Adding a reaction someone already holds changes nothing, and taking
    /// back one they never sent is not an error. A server can deliver either
    /// line twice.
    pub fn set_reaction(
        &self,
        network: &str,
        msgid: &str,
        nick: &str,
        emoji: &str,
        active: bool,
    ) -> Result<(), StoreError> {
        message::set_reaction(&self.writing(), network, msgid, nick, emoji, active)
    }

    /// Records what a plugin said about a message, replacing what that plugin
    /// said before. `msgid` need not be a message the archive holds — the row
    /// waits for one, exactly as a reaction's does.
    pub fn set_annotation(
        &self,
        network: &str,
        msgid: &str,
        plugin: &str,
        text: &str,
    ) -> Result<(), StoreError> {
        message::set_annotation(&self.writing(), network, msgid, plugin, text)
    }

    /// Records that a rule thought this message worth interrupting the user
    /// for. Recording it twice is recording it once, and there is nothing to
    /// record for a message a rule passed over: a rule raises and cannot lower.
    pub fn set_raised(&self, network: &str, msgid: &str, plugin: &str) -> Result<(), StoreError> {
        message::set_raised(&self.writing(), network, msgid, plugin)
    }

    /// The configured upload provider, or `None` when there is not one — which
    /// the spec names as a configuration rather than a failure.
    ///
    /// The token is never read back, for the reason the SASL password is not:
    /// a value that only travels one way cannot be leaked by a screen that
    /// shows what is stored. Whether there is one is read back, because a
    /// screen that cannot ask that has to guess, and a provider saved without
    /// its secret is a provider that fails at the upload.
    pub fn upload_provider(&self) -> Result<Option<UploadProvider>, StoreError> {
        let conn = self.reading();
        let mut stmt = conn.prepare(
            "SELECT endpoint, method, auth_header, s3_region, s3_access_key_id, form
             FROM upload_provider WHERE only = 0",
        )?;
        let mut rows = stmt.query([])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        // Both columns or neither: a half-configured signer would sign with a
        // region nobody chose.
        let region: Option<String> = row.get(3)?;
        let access_key_id: Option<String> = row.get(4)?;
        let form: Option<String> = row.get(5)?;
        Ok(Some(UploadProvider {
            endpoint: row.get(0)?,
            method: serde_json::from_str(&row.get::<_, String>(1)?)?,
            auth_header: row.get(2)?,
            token: None,
            token_saved: self.upload_token()?.is_some(),
            s3: region
                .zip(access_key_id)
                .map(|(region, access_key_id)| S3Credentials {
                    region,
                    access_key_id,
                }),
            form: form.map(|form| serde_json::from_str(&form)).transpose()?,
        }))
    }

    /// The token the provider is called with, read at the moment of an upload
    /// rather than held anywhere it could be shown.
    pub fn upload_token(&self) -> Result<Option<String>, StoreError> {
        self.credentials.get(credentials::UPLOAD_PROVIDER)
    }

    /// Replaces the provider. A `token` of `None` leaves whatever is stored
    /// alone; an empty token clears it when the provider needs no credential.
    pub fn save_upload_provider(&self, provider: &UploadProvider) -> Result<(), StoreError> {
        match provider.token.as_deref() {
            Some(token) if !token.is_empty() => {
                self.credentials.set(credentials::UPLOAD_PROVIDER, token)?;
            }
            Some("")
                if provider.s3.is_none()
                    && provider.auth_header.as_deref().is_none_or(str::is_empty) =>
            {
                self.credentials.delete(credentials::UPLOAD_PROVIDER)?;
            }
            _ => {}
        }
        self.writing().execute(
            "INSERT INTO upload_provider
                 (only, endpoint, method, auth_header, s3_region, s3_access_key_id, form)
             VALUES (0, ?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (only) DO UPDATE SET
                 endpoint = excluded.endpoint,
                 method = excluded.method,
                 auth_header = excluded.auth_header,
                 s3_region = excluded.s3_region,
                 s3_access_key_id = excluded.s3_access_key_id,
                 form = excluded.form",
            params![
                provider.endpoint,
                to_json(&provider.method)?,
                provider.auth_header,
                provider.s3.as_ref().map(|s3| &s3.region),
                provider.s3.as_ref().map(|s3| &s3.access_key_id),
                provider.form.as_ref().map(to_json).transpose()?,
            ],
        )?;
        Ok(())
    }

    /// Forgets the provider and its token together. Leaving the token behind
    /// would keep a credential for something the user said they no longer use.
    pub fn remove_upload_provider(&self) -> Result<(), StoreError> {
        self.writing().execute("DELETE FROM upload_provider", [])?;
        self.credentials.delete(credentials::UPLOAD_PROVIDER)
    }

    /// `req.query` is text a person typed, not an FTS5 expression: it is
    /// quoted term by term before it reaches MATCH, so a hyphen, a colon or a
    /// bare `OR` is searched for rather than obeyed.
    ///
    /// Whole words first, substrings only if that found nothing. Two indexes
    /// answer different questions and neither contains the other — `messages_fts`
    /// splits on spaces and so cannot see inside `サーバーが落ちた`,
    /// `messages_substr` indexes three-character runs and so cannot answer `ok`.
    /// Running the whole-word index first is also what keeps `deploy` from
    /// dragging in `redeployment`: a substring match is the fallback, not the
    /// default. #378.
    pub fn search(&self, req: &SearchRequest) -> Result<Vec<SearchHit>, StoreError> {
        let terms: Vec<&str> = req.query.split_whitespace().collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }

        let whole_words = self.matching("messages_fts", &fts_phrases(&terms), req)?;
        if !whole_words.is_empty() {
            return Ok(whole_words);
        }

        // Below three characters there is no trigram to look up, so an emoji or
        // a one-character word in a script that has them is unindexable by
        // either table and the text itself is the only place left to look.
        if terms.iter().all(|term| term.chars().count() >= TRIGRAM_MIN) {
            self.matching("messages_substr", &fts_phrases(&terms), req)
        } else {
            self.scanning(&terms, req)
        }
    }

    pub fn set_bookmark(
        &self,
        network: &str,
        target: &str,
        message_id: &str,
        active: bool,
    ) -> Result<bool, StoreError> {
        let conn = self.writing();
        let found: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages
             WHERE network = ?1 AND target = ?2 COLLATE NOCASE AND message_id = ?3)",
            params![network, target, message_id],
            |row| row.get(0),
        )?;
        if !found {
            return Ok(false);
        }
        if active {
            conn.execute(
                "INSERT OR IGNORE INTO bookmarks(message)
                 SELECT id FROM messages
                 WHERE network = ?1 AND target = ?2 COLLATE NOCASE AND message_id = ?3",
                params![network, target, message_id],
            )?;
        } else {
            conn.execute(
                "DELETE FROM bookmarks WHERE message IN (
                     SELECT id FROM messages
                     WHERE network = ?1 AND target = ?2 COLLATE NOCASE AND message_id = ?3
                 )",
                params![network, target, message_id],
            )?;
        }
        Ok(true)
    }

    pub fn bookmarks(
        &self,
        network: Option<&str>,
        target: Option<&str>,
        limit: u32,
    ) -> Result<Vec<SearchHit>, StoreError> {
        let sql = format!(
            "SELECT {columns}, m.text, b.note FROM bookmarks b
             JOIN messages m ON m.id = b.message
             WHERE (?1 IS NULL OR m.network = ?1)
               AND (?2 IS NULL OR m.target = ?2 COLLATE NOCASE)
             ORDER BY m.timestamp DESC, m.id DESC LIMIT ?3",
            columns = message::COLUMNS,
        );
        let conn = self.reading();
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params![network, target, limit])?;
        let mut messages = Vec::new();
        let mut snippets = Vec::new();
        let mut notes = Vec::new();
        while let Some(row) = rows.next()? {
            messages.push(message::from_row(row)?);
            snippets.push(row.get(message::COLUMN_COUNT)?);
            notes.push(row.get::<_, String>(message::COLUMN_COUNT + 1)?);
        }
        message::attach_reactions(&conn, &mut messages)?;
        Ok(messages
            .into_iter()
            .zip(snippets)
            .zip(notes)
            .map(|((message, snippet), note)| SearchHit {
                message,
                snippet,
                note: (!note.is_empty()).then_some(note),
            })
            .collect())
    }

    pub fn set_bookmark_note(
        &self,
        network: &str,
        target: &str,
        message_id: &str,
        note: &str,
    ) -> Result<bool, StoreError> {
        let changed = self.writing().execute(
            "UPDATE bookmarks SET note = ?4 WHERE message IN (
                 SELECT id FROM messages
                 WHERE network = ?1 AND target = ?2 COLLATE NOCASE AND message_id = ?3
             )",
            params![network, target, message_id, note],
        )?;
        Ok(changed > 0)
    }

    /// One of the two FTS tables, asked the same question. The table name is
    /// interpolated because SQLite takes no parameter there; both names are
    /// this function's own literals, never anything the user typed.
    fn matching(
        &self,
        index: &str,
        query: &str,
        req: &SearchRequest,
    ) -> Result<Vec<SearchHit>, StoreError> {
        let sql = format!(
            "SELECT {columns}, snippet({index}, 0, '<mark>', '</mark>', '…', 12)
             FROM {index}
             JOIN messages m ON m.id = {index}.rowid
             WHERE {index} MATCH ?1
               AND (?2 IS NULL OR m.network = ?2)
               AND (?3 IS NULL OR m.target = ?3 COLLATE NOCASE)
               AND (?4 IS NULL OR m.sender_nick = ?4 COLLATE NOCASE)
               AND (?5 IS NULL OR m.timestamp >= ?5)
             ORDER BY m.timestamp DESC, m.id DESC
             LIMIT ?6",
            columns = message::COLUMNS,
        );

        let conn = self.reading();
        let mut stmt = conn.prepare(&sql).map_err(search_error)?;
        let mut rows = stmt
            .query(params![
                query,
                req.network,
                req.target,
                req.sender,
                req.after,
                req.limit
            ])
            .map_err(search_error)?;
        let mut found = Vec::new();
        let mut snippets: Vec<String> = Vec::new();
        while let Some(row) = rows.next().map_err(search_error)? {
            found.push(message::from_row(row)?);
            snippets.push(row.get(message::COLUMN_COUNT)?);
        }
        message::attach_reactions(&conn, &mut found)?;

        Ok(found
            .into_iter()
            .zip(snippets)
            .map(|(message, snippet)| SearchHit {
                message,
                snippet,
                note: None,
            })
            .collect())
    }

    /// What is left when no index can help: read the text and look. Reached
    /// only by a query with a term under three characters that the whole-word
    /// index already failed to answer, which in practice is a lone emoji or a
    /// single CJK character.
    ///
    /// It is a scan, and the `LIKE` is what makes it one. The network and
    /// target filters narrow it where the user has picked a conversation, and
    /// `LIMIT` stops it early where there are hits; a query with none reads the
    /// archive. Measured in `docs/measurements.md`.
    fn scanning(&self, terms: &[&str], req: &SearchRequest) -> Result<Vec<SearchHit>, StoreError> {
        // Every term has to appear, which is what the FTS paths mean by ANDing
        // their phrases. `instr` is case-sensitive and `LIKE` is not, for ASCII;
        // neither folds case in Japanese, which has none.
        let conditions = (0..terms.len())
            .map(|index| format!("m.text LIKE '%' || ?{} || '%' ESCAPE '\\'", index + 6))
            .collect::<Vec<_>>()
            .join(" AND ");
        let sql = format!(
            "SELECT {columns} FROM messages m
             WHERE (?1 IS NULL OR m.network = ?1)
               AND (?2 IS NULL OR m.target = ?2)
               AND (?3 IS NULL OR m.sender_nick = ?3 COLLATE NOCASE)
               AND (?4 IS NULL OR m.timestamp >= ?4)
               AND {conditions}
             ORDER BY m.timestamp DESC, m.id DESC
             LIMIT ?5",
            columns = message::COLUMNS,
        );

        let conn = self.reading();
        let mut stmt = conn.prepare(&sql)?;
        let mut bound: Vec<&dyn rusqlite::ToSql> = vec![
            &req.network,
            &req.target,
            &req.sender,
            &req.after,
            &req.limit,
        ];
        let escaped: Vec<String> = terms.iter().map(|term| like_literal(term)).collect();
        bound.extend(escaped.iter().map(|term| term as &dyn rusqlite::ToSql));

        let mut rows = stmt.query(bound.as_slice())?;
        let mut found = Vec::new();
        while let Some(row) = rows.next()? {
            found.push(message::from_row(row)?);
        }
        message::attach_reactions(&conn, &mut found)?;

        Ok(found
            .into_iter()
            .map(|message| {
                let snippet = around_match(&message.text, terms[0]);
                SearchHit {
                    message,
                    snippet,
                    note: None,
                }
            })
            .collect())
    }

    pub fn list_networks(&self) -> Result<Vec<NetworkConfig>, StoreError> {
        let conn = self.reading();
        let mut stmt = conn.prepare(&format!(
            "SELECT {NETWORK_COLUMNS} FROM networks ORDER BY name"
        ))?;
        let mut rows = stmt.query([])?;
        let mut networks = Vec::new();
        while let Some(row) = rows.next()? {
            networks.push(network_from_row(row)?);
        }
        Ok(networks)
    }

    pub fn sts_policy(&self, host: &str, now: i64) -> Result<Option<StsPolicy>, StoreError> {
        self.reading()
            .query_row(
                "SELECT port, expires_at FROM sts_policy
                 WHERE host = ?1 AND expires_at > ?2",
                params![host, now],
                |row| {
                    Ok(StsPolicy {
                        port: row.get(0)?,
                        expires_at: row.get(1)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn save_sts_policy(
        &self,
        host: &str,
        port: Option<u16>,
        expires_at: i64,
    ) -> Result<(), StoreError> {
        self.writing().execute(
            "INSERT INTO sts_policy (host, port, expires_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (host) DO UPDATE SET
                 port = excluded.port,
                 expires_at = excluded.expires_at",
            params![host, port, expires_at],
        )?;
        Ok(())
    }

    pub fn delete_sts_policy(&self, host: &str) -> Result<(), StoreError> {
        self.writing()
            .execute("DELETE FROM sts_policy WHERE host = ?1", [host])?;
        Ok(())
    }

    /// The SASL password goes to the keyring and never to SQLite. A config
    /// saved without one leaves any stored password alone; dropping SASL
    /// entirely deletes it.
    pub fn save_network(&self, config: &NetworkConfig) -> Result<NetworkId, StoreError> {
        let id = match &config.id {
            Some(id) => id.clone(),
            None => self
                .writing()
                .query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?,
        };

        match config.sasl.as_ref() {
            Some(sasl) => {
                if let Some(password) = sasl.password.as_deref().filter(|p| !p.is_empty()) {
                    self.credentials.set(&id, password)?;
                }
            }
            None => self.credentials.delete(&id)?,
        }

        let mechanism = config
            .sasl
            .as_ref()
            .map(|sasl| to_json(&sasl.mechanism))
            .transpose()?;
        let account = config.sasl.as_ref().map(|sasl| sasl.account.clone());

        self.writing().execute(
            &format!(
                "INSERT INTO networks ({NETWORK_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT (id) DO UPDATE SET
                     name = excluded.name,
                     host = excluded.host,
                     port = excluded.port,
                     tls = excluded.tls,
                     tls_verify = excluded.tls_verify,
                     nick = excluded.nick,
                     alt_nicks = excluded.alt_nicks,
                     username = excluded.username,
                     realname = excluded.realname,
                     sasl_mechanism = excluded.sasl_mechanism,
                     sasl_account = excluded.sasl_account,
                     connect_commands = excluded.connect_commands,
                     autojoin = excluded.autojoin,
                     auto_connect = excluded.auto_connect,
                     client_certificate = excluded.client_certificate,
                     socks5_proxy = excluded.socks5_proxy"
            ),
            params![
                id,
                config.name,
                config.host,
                config.port,
                config.tls,
                config.tls_verify,
                config.nick,
                to_json(&config.alt_nicks)?,
                config.username,
                config.realname,
                mechanism,
                account,
                to_json(&config.connect_commands)?,
                to_json(&config.autojoin)?,
                config.auto_connect,
                config.client_certificate,
                config.socks5_proxy,
            ],
        )?;

        Ok(id)
    }

    /// Drops the config, its password and the conversations it had open.
    /// Messages from the network stay; `delete_target` is how an archive is
    /// thrown away.
    /// Forgets a network and everything about it that is not conversation.
    ///
    /// The messages stay, which is what the removal screen promises: "the
    /// conversations already archived stay on this computer". Everything else
    /// keyed to the network goes with it, because a network id is a fresh uuid
    /// and nothing will ever name this one again — a row left here is not kept,
    /// it is stranded.
    ///
    /// `drafts` in particular. A draft is text the user typed and did not send,
    /// it is neither a setting nor an archived conversation, and it used to
    /// outlive the network it belonged to with no screen left that could reach
    /// it. `delete_target` and `delete_everything` both take drafts; this is
    /// the third door and it did not.
    pub fn remove_network(&self, id: &NetworkId) -> Result<(), StoreError> {
        self.credentials.delete(id)?;
        let mut conn = self.writing();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM networks WHERE id = ?1", params![id])?;
        tx.execute("DELETE FROM open_targets WHERE network = ?1", params![id])?;
        tx.execute("DELETE FROM drafts WHERE network = ?1", params![id])?;
        // Retention is a setting, and "forgets its settings" is what the screen
        // says. A window set for a network that is gone decides nothing and
        // reads as one somebody would have to find to change.
        tx.execute("DELETE FROM retention WHERE network = ?1", params![id])?;
        // Mute is a setting too, and a conversation muted on a network that is
        // gone is one nobody can find to unmute.
        tx.execute("DELETE FROM muted WHERE network = ?1", params![id])?;
        // And an ignore, for the same reason: a nick means nothing without the
        // network it was said on.
        tx.execute("DELETE FROM ignored WHERE network = ?1", params![id])?;
        tx.execute("DELETE FROM watched_nicks WHERE network = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Records a conversation as open, so the next launch comes back to it.
    /// Idempotent: joining a channel again is not a second row.
    pub fn remember_target(&self, network: &str, target: &OpenTarget) -> Result<(), StoreError> {
        self.writing().execute(
            "INSERT INTO open_targets (network, target, kind) VALUES (?1, ?2, ?3)
             ON CONFLICT (network, target) DO UPDATE SET kind = excluded.kind",
            params![network, target.name(), target.kind()],
        )?;
        Ok(())
    }

    /// Drops a conversation from the set the next launch reopens. The messages
    /// stay; `delete_target` is how an archive is thrown away.
    pub fn forget_target(&self, network: &str, target: &str) -> Result<(), StoreError> {
        self.writing().execute(
            "DELETE FROM open_targets WHERE network = ?1 AND target = ?2",
            params![network, target],
        )?;
        Ok(())
    }

    pub fn open_targets(&self, network: &str) -> Result<Vec<OpenTarget>, StoreError> {
        let conn = self.reading();
        let mut stmt = conn
            .prepare("SELECT target, kind FROM open_targets WHERE network = ?1 ORDER BY target")?;
        let mut rows = stmt.query(params![network])?;
        let mut targets = Vec::new();
        while let Some(row) = rows.next()? {
            let name: TargetName = row.get(0)?;
            let kind: String = row.get(1)?;
            targets.push(match kind.as_str() {
                "channel" => OpenTarget::Channel(name),
                _ => OpenTarget::Query(name),
            });
        }
        Ok(targets)
    }

    pub fn sasl_password(&self, network: &NetworkId) -> Result<Option<String>, StoreError> {
        self.credentials.get(network)
    }

    pub fn get_draft(&self, network: &str, target: &str) -> Result<Option<String>, StoreError> {
        let draft = self
            .reading()
            .query_row(
                "SELECT text FROM drafts WHERE network = ?1 AND target = ?2",
                params![network, target],
                |row| row.get(0),
            )
            .optional()?;
        Ok(draft)
    }

    pub fn list_drafts(&self) -> Result<Vec<(String, String)>, StoreError> {
        let conn = self.reading();
        let mut statement = conn.prepare("SELECT network, target FROM drafts")?;
        let drafts = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(drafts)
    }

    /// Empty text clears the draft rather than storing a blank one.
    /// Takes a half-written message with the person it was being written to.
    ///
    /// A rename moves everything else about a conversation (#235) and left this
    /// behind, so the pane that followed somebody to their new name opened with
    /// an empty composer and the words sat under a name nobody holds. Nothing
    /// happens when there is no draft, and anything already under the new name
    /// wins — it is the more recent of the two.
    pub fn move_draft(&self, network: &str, from: &str, to: &str) -> Result<(), StoreError> {
        self.writing().execute(
            "UPDATE OR IGNORE drafts SET target = ?3
             WHERE network = ?1 AND target = ?2",
            params![network, from, to],
        )?;
        // An ignored update leaves the old row behind, which is a draft for a
        // name that is now somebody else's.
        self.writing().execute(
            "DELETE FROM drafts WHERE network = ?1 AND target = ?2",
            params![network, from],
        )?;
        Ok(())
    }

    pub fn set_draft(&self, network: &str, target: &str, text: &str) -> Result<(), StoreError> {
        let conn = self.writing();
        if text.is_empty() {
            conn.execute(
                "DELETE FROM drafts WHERE network = ?1 AND target = ?2",
                params![network, target],
            )?;
        } else {
            conn.execute(
                "INSERT INTO drafts (network, target, text) VALUES (?1, ?2, ?3)
                 ON CONFLICT (network, target) DO UPDATE SET text = excluded.text",
                params![network, target, text],
            )?;
        }
        Ok(())
    }

    /// Mutes a conversation, or the whole network when `target` is `None`.
    ///
    /// A row is the whole state, so unmuting deletes rather than writing a
    /// false. Nothing else is stored against the key and a table of rows saying
    /// "not muted" would be a second way to say what absence already says.
    pub fn set_muted(
        &self,
        network: &str,
        target: Option<&str>,
        muted: bool,
    ) -> Result<(), StoreError> {
        let target = target.unwrap_or(DEFAULT_TARGET);
        let conn = self.writing();
        if muted {
            conn.execute(
                "INSERT OR IGNORE INTO muted (network, target) VALUES (?1, ?2)",
                params![network, target],
            )?;
        } else {
            conn.execute(
                "DELETE FROM muted WHERE network = ?1 AND target = ?2 COLLATE NOCASE",
                params![network, target],
            )?;
        }
        Ok(())
    }

    /// What is muted on one network, as the targets themselves — an empty
    /// string among them being the network itself. What a session holds, so it
    /// can answer per message without going to disk.
    pub fn muted_targets(&self, network: &str) -> Result<Vec<String>, StoreError> {
        let conn = self.reading();
        let mut statement = conn.prepare("SELECT target FROM muted WHERE network = ?1")?;
        let targets = statement
            .query_map(params![network], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(targets)
    }

    /// Everything muted, on every network, with the network named.
    ///
    /// The name travels with the id because the settings window has no network
    /// list to look one up in — it runs no event bridge — and a page listing
    /// hashes is a page nobody can act on. Ordered so the list does not move
    /// under somebody halfway down it.
    pub fn muted_conversations(&self) -> Result<Vec<(String, String, String)>, StoreError> {
        let conn = self.reading();
        let mut statement = conn.prepare(
            "SELECT m.network, COALESCE(n.name, m.network), m.target
             FROM muted m LEFT JOIN networks n ON n.id = m.network
             ORDER BY COALESCE(n.name, m.network), m.target",
        )?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Moves a mute to the nick a query was renamed to.
    ///
    /// A mute follows a rename the way a draft does. The alternative fails in
    /// the direction that interrupts you: a bot muted for its build output
    /// renames itself and starts being loud again, for a reason nobody watching
    /// the sidebar could work out.
    pub fn move_muted(&self, network: &str, from: &str, to: &str) -> Result<(), StoreError> {
        self.writing().execute(
            "UPDATE OR REPLACE muted SET target = ?3
             WHERE network = ?1 AND target = ?2 COLLATE NOCASE",
            params![network, from, to],
        )?;
        Ok(())
    }

    /// Starts or stops ignoring somebody on one network.
    ///
    /// A row is the whole state, the way a mute is: absence says "not
    /// ignored" and there is nothing to store beside the key.
    pub fn set_ignored(&self, network: &str, nick: &str, ignored: bool) -> Result<(), StoreError> {
        let conn = self.writing();
        if ignored {
            conn.execute(
                "INSERT OR IGNORE INTO ignored (network, nick) VALUES (?1, ?2)",
                params![network, nick],
            )?;
        } else {
            conn.execute(
                "DELETE FROM ignored WHERE network = ?1 AND nick = ?2 COLLATE NOCASE",
                params![network, nick],
            )?;
        }
        Ok(())
    }

    /// Who is ignored on one network. What a session holds, so it can answer
    /// per message without going to disk.
    pub fn ignored_nicks(&self, network: &str) -> Result<Vec<String>, StoreError> {
        let conn = self.reading();
        let mut statement = conn.prepare("SELECT nick FROM ignored WHERE network = ?1")?;
        let nicks = statement
            .query_map(params![network], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(nicks)
    }

    /// Everybody ignored, on every network, with the network named. The name
    /// travels with the id for the reason `muted_conversations` explains.
    pub fn ignored_people(&self) -> Result<Vec<(String, String, String)>, StoreError> {
        let conn = self.reading();
        let mut statement = conn.prepare(
            "SELECT i.network, COALESCE(n.name, i.network), i.nick
             FROM ignored i LEFT JOIN networks n ON n.id = i.network
             ORDER BY COALESCE(n.name, i.network), i.nick",
        )?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn set_watched_nick(
        &self,
        network: &str,
        nick: &str,
        watched: bool,
    ) -> Result<(), StoreError> {
        let conn = self.writing();
        if watched {
            conn.execute(
                "INSERT OR IGNORE INTO watched_nicks (network, nick) VALUES (?1, ?2)",
                params![network, nick],
            )?;
        } else {
            conn.execute(
                "DELETE FROM watched_nicks WHERE network = ?1 AND nick = ?2 COLLATE NOCASE",
                params![network, nick],
            )?;
        }
        Ok(())
    }

    pub fn watched_nicks(&self, network: &str) -> Result<Vec<String>, StoreError> {
        let conn = self.reading();
        let mut statement =
            conn.prepare("SELECT nick FROM watched_nicks WHERE network = ?1 ORDER BY nick")?;
        let nicks = statement
            .query_map(params![network], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(nicks)
    }

    pub fn watched_people(&self) -> Result<Vec<(String, String, String)>, StoreError> {
        let conn = self.reading();
        let mut statement = conn.prepare(
            "SELECT w.network, COALESCE(n.name, w.network), w.nick
             FROM watched_nicks w LEFT JOIN networks n ON n.id = w.network
             ORDER BY COALESCE(n.name, w.network), w.nick",
        )?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// The words that raise a conversation beside the reader's nickname, in the
    /// order they were last written.
    ///
    /// Insertion order rather than alphabetical: this is a list somebody typed,
    /// and a page that reorders it under them on every save is one they cannot
    /// keep their place in.
    pub fn highlight_words(&self) -> Result<Vec<String>, StoreError> {
        let conn = self.reading();
        let mut statement = conn.prepare("SELECT word FROM highlight_word ORDER BY rowid")?;
        let words = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(words)
    }

    /// Replaces the list wholesale, which is how the page edits it: a word has
    /// no identity beyond itself, so an addition and a removal are the same
    /// write.
    pub fn set_highlight_words(&self, words: &[String]) -> Result<(), StoreError> {
        let mut conn = self.writing();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM highlight_word", [])?;
        for word in words {
            // Two spellings of one word collide on the caseless key, and the
            // one typed first is the one kept.
            tx.execute(
                "INSERT OR IGNORE INTO highlight_word (word) VALUES (?1)",
                params![word],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// `None` where nothing has been changed, which is the ordinary case: the
    /// defaults include a download directory only the application layer can
    /// name, so an unwritten row is left for it to fill in rather than being
    /// invented here.
    pub fn transfer_settings(&self) -> Result<Option<TransferSettings>, StoreError> {
        let conn = self.reading();
        let settings = conn
            .query_row(
                "SELECT directory, first_port, last_port, address, passive
                 FROM transfer_settings WHERE only = 0",
                [],
                |row| {
                    let first: Option<u16> = row.get(1)?;
                    let last: Option<u16> = row.get(2)?;
                    Ok(TransferSettings {
                        directory: row.get(0)?,
                        ports: first.zip(last),
                        address: row.get(3)?,
                        passive: row.get::<_, i64>(4)? != 0,
                    })
                },
            )
            .optional()?;
        Ok(settings)
    }

    pub fn save_transfer_settings(&self, settings: &TransferSettings) -> Result<(), StoreError> {
        let (first, last) = match settings.ports {
            Some((first, last)) => (Some(first), Some(last)),
            None => (None, None),
        };
        self.writing().execute(
            "INSERT INTO transfer_settings (only, directory, first_port, last_port, address, passive)
             VALUES (0, ?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (only) DO UPDATE SET
                 directory = excluded.directory,
                 first_port = excluded.first_port,
                 last_port = excluded.last_port,
                 address = excluded.address,
                 passive = excluded.passive",
            params![
                settings.directory,
                first,
                last,
                settings.address,
                settings.passive as i64
            ],
        )?;
        Ok(())
    }

    /// Whether closing the window hides it rather than ending the session.
    ///
    /// No row means nobody has chosen, and the answer then is to hide: a client
    /// left running is what a status icon is for. Whether there is an icon to
    /// hide to is the shell's question, not this one's.
    pub fn close_to_tray(&self) -> Result<bool, StoreError> {
        let chosen: Option<i64> = self
            .reading()
            .query_row(
                "SELECT close_to_tray FROM tray_settings WHERE only = 0",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(chosen != Some(0))
    }

    pub fn set_close_to_tray(&self, hide: bool) -> Result<(), StoreError> {
        self.writing().execute(
            "INSERT INTO tray_settings (only, close_to_tray) VALUES (0, ?1)
             ON CONFLICT (only) DO UPDATE SET close_to_tray = excluded.close_to_tray",
            params![hide as i64],
        )?;
        Ok(())
    }

    /// `target` of `None` sets the network default. `days` of `None` keeps
    /// messages forever, and as a target override it outranks the default.
    pub fn set_retention(
        &self,
        network: &str,
        target: Option<&str>,
        days: Option<u32>,
    ) -> Result<(), StoreError> {
        self.writing().execute(
            "INSERT INTO retention (network, target, days) VALUES (?1, ?2, ?3)
             ON CONFLICT (network, target) DO UPDATE SET days = excluded.days",
            params![network, target.unwrap_or(DEFAULT_TARGET), days],
        )?;
        Ok(())
    }

    /// What rule is written down for this conversation, or for the network when
    /// `target` is `None`.
    ///
    /// Two levels of absence, and they mean different things: no row at all is
    /// "nothing said about this", and a row holding `NULL` is "keep forever",
    /// which as an override beats the network's own window.
    pub fn retention(
        &self,
        network: &str,
        target: Option<&str>,
    ) -> Result<Option<Option<u32>>, StoreError> {
        self.reading()
            .query_row(
                "SELECT days FROM retention WHERE network = ?1 AND target = ?2",
                params![network, target.unwrap_or(DEFAULT_TARGET)],
                |row| row.get::<_, Option<u32>>(0),
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Deletes everything past its retention window and returns how many
    /// messages went. A no-op when nothing has expired, so it is safe on
    /// every startup.
    pub fn prune(&self) -> Result<u64, StoreError> {
        // CASE, not COALESCE: a target row with NULL days means keep forever
        // and has to beat the network default rather than fall through to it.
        // Comparing against a NULL window is never true, so those rows stay.
        const EXPIRED: &str = "SELECT m.id
                 FROM messages m
                 LEFT JOIN retention t ON t.network = m.network
                     AND t.target = m.target COLLATE NOCASE
                 LEFT JOIN retention n ON n.network = m.network AND n.target = ''
                 WHERE m.timestamp < strftime(
                     '%Y-%m-%dT%H:%M:%SZ',
                     'now',
                     '-' || (CASE WHEN t.network IS NOT NULL THEN t.days ELSE n.days END) || ' days'
                 )";
        let mut conn = self.writing();
        let tx = conn.transaction()?;
        take_what_messages_owned(
            &tx,
            &format!(
                "SELECT e.network, e.server_msgid, e.message_id FROM messages e
                  WHERE e.id IN ({EXPIRED})"
            ),
            [],
        )?;
        let deleted = tx.execute(&format!("DELETE FROM messages WHERE id IN ({EXPIRED})"), [])?;
        tx.commit()?;
        Ok(deleted as u64)
    }

    /// JSON Lines, oldest first: one serialised `ChatMessage` per line, which
    /// keeps the export lossless and re-readable.
    pub fn export_target(
        &self,
        network: &str,
        target: &str,
        out: &mut dyn Write,
    ) -> Result<(), StoreError> {
        let sql = format!(
            "SELECT {columns}
             FROM messages m
             WHERE m.network = ?1 AND m.target = ?2 COLLATE NOCASE
             ORDER BY m.timestamp, m.id",
            columns = message::COLUMNS,
        );

        let conn = self.walking();
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params![network, target])?;
        while let Some(row) = rows.next()? {
            let mut message = message::from_row(row)?;
            message::attach_reactions(&conn, std::slice::from_mut(&mut message))?;
            let line = serde_json::to_string(&message)?;
            out.write_all(line.as_bytes())?;
            out.write_all(b"\n")?;
        }
        Ok(())
    }

    /// Every conversation on one network, oldest first.
    pub fn export_network(&self, network: &str, out: &mut dyn Write) -> Result<(), StoreError> {
        let sql = format!(
            "SELECT {columns}
             FROM messages m
             WHERE m.network = ?1
             ORDER BY m.timestamp, m.id",
            columns = message::COLUMNS,
        );

        let conn = self.walking();
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params![network])?;
        while let Some(row) = rows.next()? {
            let mut message = message::from_row(row)?;
            message::attach_reactions(&conn, std::slice::from_mut(&mut message))?;
            let line = serde_json::to_string(&message)?;
            out.write_all(line.as_bytes())?;
            out.write_all(b"\n")?;
        }
        Ok(())
    }

    /// How much conversation is on disk: how many messages, and what the
    /// database costs to keep.
    ///
    /// The size is the file's rather than the messages': indexes and the
    /// full-text table are most of what an archive weighs, and a number that
    /// left them out would be wrong in the direction that matters.
    pub fn archive_size(&self) -> Result<ArchiveSize, StoreError> {
        let conn = self.reading();
        let messages: u64 =
            conn.query_row("SELECT count(*) FROM messages", [], |row| row.get(0))?;
        let pages: u64 = conn.query_row("PRAGMA page_count", [], |row| row.get(0))?;
        let page_size: u64 = conn.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        Ok(ArchiveSize {
            messages,
            bytes: pages * page_size,
        })
    }

    /// Every conversation, oldest first, in the format `export_target` writes.
    pub fn export_everything(&self, out: &mut dyn Write) -> Result<(), StoreError> {
        let sql = format!(
            "SELECT {columns}
             FROM messages m
             ORDER BY m.timestamp, m.id",
            columns = message::COLUMNS,
        );
        let conn = self.walking();
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let mut message = message::from_row(row)?;
            message::attach_reactions(&conn, std::slice::from_mut(&mut message))?;
            let line = serde_json::to_string(&message)?;
            out.write_all(line.as_bytes())?;
            out.write_all(b"\n")?;
        }
        Ok(())
    }

    /// Every message this client has kept, and everything hanging off one.
    ///
    /// Networks, credentials and which conversations were open are left alone:
    /// this is the archive rather than the account, and somebody clearing what
    /// was said is not asking to be logged out.
    pub fn delete_everything(&self) -> Result<(), StoreError> {
        let mut conn = self.writing();
        let tx = conn.transaction()?;
        // Messages first: the FTS triggers hang off that table, and the rest
        // are rows keyed by a msgid that will no longer name anything.
        for table in ["messages", "drafts", "reactions", "annotations", "raised"] {
            tx.execute(&format!("DELETE FROM {table}"), [])?;
        }
        tx.commit()?;
        // A delete leaves the rows in the file's free pages, where anybody
        // reading the bytes still finds them and where the size on disk still
        // counts them. Somebody clearing an archive means the words to be gone,
        // so the file is rewritten without them. Outside the transaction
        // because SQLite will not vacuum inside one.
        conn.execute_batch("VACUUM")?;
        Ok(())
    }

    pub fn delete_target(&self, network: &str, target: &str) -> Result<(), StoreError> {
        let mut conn = self.writing();
        let tx = conn.transaction()?;
        take_what_messages_owned(
            &tx,
            "SELECT network, server_msgid, message_id FROM messages
              WHERE network = ?1 AND target = ?2 COLLATE NOCASE",
            params![network, target],
        )?;
        tx.execute(
            "DELETE FROM messages WHERE network = ?1 AND target = ?2 COLLATE NOCASE",
            params![network, target],
        )?;
        tx.execute(
            "DELETE FROM drafts WHERE network = ?1 AND target = ?2 COLLATE NOCASE",
            params![network, target],
        )?;
        tx.commit()?;
        conn.execute_batch("VACUUM")?;
        Ok(())
    }

    pub fn delete_network_archive(&self, network: &str) -> Result<(), StoreError> {
        let mut conn = self.writing();
        let tx = conn.transaction()?;
        take_what_messages_owned(
            &tx,
            "SELECT network, server_msgid, message_id FROM messages
              WHERE network = ?1",
            params![network],
        )?;
        tx.execute("DELETE FROM messages WHERE network = ?1", params![network])?;
        tx.execute("DELETE FROM drafts WHERE network = ?1", params![network])?;
        tx.commit()?;
        conn.execute_batch("VACUUM")?;
        Ok(())
    }
}

/// Takes the reactions, annotations and raised marks of the messages `owned`
/// selects, before those messages go. A reaction names the server's msgid;
/// annotations and raises name the id the window drew, which stays local when
/// an echo later adds a server msgid. One still waiting for a message that never
/// arrived keeps waiting — arrival-before-archive is why these tables have no
/// foreign key.
fn take_what_messages_owned(
    tx: &rusqlite::Transaction,
    owned: &str,
    params: impl rusqlite::Params + Clone,
) -> Result<(), StoreError> {
    tx.execute(
        &format!(
            "WITH owned(network, server_msgid, message_id) AS ({owned})
             DELETE FROM reactions WHERE (network, msgid) IN (
                 SELECT network, server_msgid FROM owned WHERE server_msgid IS NOT NULL
             )"
        ),
        params.clone(),
    )?;
    for table in ["annotations", "raised"] {
        tx.execute(
            &format!(
                "WITH owned(network, server_msgid, message_id) AS ({owned})
                 DELETE FROM {table} WHERE (network, msgid) IN (
                     SELECT network, message_id FROM owned
                 )"
            ),
            params.clone(),
        )?;
    }
    Ok(())
}

/// Whether this conversation is written down at all.
///
/// The same precedence `prune` uses and for the same reason: a target row beats
/// the network's, and a row holding `NULL` means keep forever rather than
/// falling through to the default.
fn keeps_anything(conn: &Connection, network: &str, target: &str) -> Result<bool, StoreError> {
    let days: Option<Option<u32>> = conn
        .query_row(
            "SELECT CASE WHEN t.network IS NOT NULL THEN t.days ELSE n.days END
             FROM (SELECT 1) one
             LEFT JOIN retention t ON t.network = ?1 AND t.target = ?2 COLLATE NOCASE
             LEFT JOIN retention n ON n.network = ?1 AND n.target = ''",
            params![network, target],
            |row| row.get(0),
        )
        .optional()?
        .flatten()
        .map(Some)
        .or(Some(None));
    Ok(!matches!(days, Some(Some(0))))
}

fn network_from_row(row: &Row) -> Result<NetworkConfig, StoreError> {
    let mechanism: Option<String> = row.get(10)?;
    let account: Option<String> = row.get(11)?;
    let sasl = match (mechanism, account) {
        (Some(mechanism), Some(account)) => Some(SaslConfig {
            mechanism: serde_json::from_str(&mechanism)?,
            account,
            password: None,
        }),
        _ => None,
    };

    Ok(NetworkConfig {
        id: Some(row.get(0)?),
        name: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        tls: row.get(4)?,
        tls_verify: row.get(5)?,
        nick: row.get(6)?,
        alt_nicks: from_json_column(row, 7)?,
        username: row.get(8)?,
        realname: row.get(9)?,
        sasl,
        connect_commands: from_json_column(row, 12)?,
        autojoin: from_json_column(row, 13)?,
        auto_connect: row.get(14)?,
        client_certificate: row.get(15)?,
        socks5_proxy: row.get(16)?,
    })
}

/// The shortest query the trigram index can answer. Below it there is no
/// three-character run to look up and MATCH returns nothing at all, which is
/// not the same as no message containing it.
const TRIGRAM_MIN: usize = 3;

/// Turns what the user typed into an FTS5 expression that means it literally.
/// Each term becomes a quoted phrase — FTS5 reads no operator inside quotes —
/// and a typed quote is doubled, which is how FTS5 escapes one. Phrases side by
/// side are ANDed, so every word has to appear.
fn fts_phrases(terms: &[&str]) -> String {
    terms
        .iter()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

/// A term as a LIKE operand rather than a pattern: `%`, `_` and the escape
/// character itself are what the user typed, not wildcards. Without this a
/// search for `_` matches every message with at least one character in it.
fn like_literal(term: &str) -> String {
    let mut escaped = String::with_capacity(term.len());
    for character in term.chars() {
        if matches!(character, '%' | '_' | '\\') {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

/// How much of a message travels either side of the hit, in characters. The
/// FTS paths get this from `snippet()`, which counts tokens; there are no
/// tokens on this path, so it counts what a reader sees.
const SNIPPET_REACH: usize = 24;

/// A snippet for the scanning path, shaped like the one `snippet()` returns:
/// the hit inside `<mark>`, a window of text either side, and `…` wherever the
/// message was clipped.
/// Case is folded for ASCII and left alone otherwise, which is what SQLite's
/// `LIKE` did to select the row — so the mark lands on what matched.
fn around_match(text: &str, term: &str) -> String {
    let characters: Vec<char> = text.chars().collect();
    let needle: Vec<char> = term.chars().collect();
    let found = characters.windows(needle.len()).position(|window| {
        window
            .iter()
            .zip(&needle)
            .all(|(here, wanted)| here.eq_ignore_ascii_case(wanted))
    });
    let Some(start) = found else {
        return characters.iter().take(SNIPPET_REACH * 2).collect();
    };
    let end = start + needle.len();

    let before = start.saturating_sub(SNIPPET_REACH);
    let after = (end + SNIPPET_REACH).min(characters.len());
    let slice = |from: usize, to: usize| characters[from..to].iter().collect::<String>();

    format!(
        "{}{}<mark>{}</mark>{}{}",
        if before > 0 { "…" } else { "" },
        slice(before, start),
        slice(start, end),
        slice(end, after),
        if after < characters.len() { "…" } else { "" },
    )
}

/// SQLite reports a malformed FTS5 query as a plain error whose message names
/// `fts5`. The query text came from the user, so report it back as theirs
/// rather than as a database failure.
fn search_error(err: rusqlite::Error) -> StoreError {
    let message = err.to_string();
    if message.contains("fts5:") {
        StoreError::Search(message)
    } else {
        StoreError::Sqlite(err)
    }
}

pub(crate) fn to_json<T: Serialize>(value: &T) -> Result<String, StoreError> {
    Ok(serde_json::to_string(value)?)
}

pub(crate) fn from_json_column<T: DeserializeOwned>(
    row: &Row,
    index: usize,
) -> Result<T, StoreError> {
    let raw: String = row.get(index)?;
    Ok(serde_json::from_str(&raw)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ircx_ipc::{SaslConfig, SaslMechanism};

    #[test]
    fn a_password_never_lands_in_sqlite() {
        let store = Store::open_in_memory().unwrap();
        store
            .save_network(&NetworkConfig {
                id: None,
                name: "Libera".into(),
                host: "irc.libera.chat".into(),
                port: 6697,
                tls: true,
                tls_verify: true,
                socks5_proxy: None,
                nick: "sykk".into(),
                alt_nicks: vec!["sykk_".into()],
                username: "sykk".into(),
                realname: "sykk".into(),
                sasl: Some(SaslConfig {
                    mechanism: SaslMechanism::Plain,
                    account: "sykk".into(),
                    password: Some("hunter2".into()),
                }),
                connect_commands: vec![],
                autojoin: vec!["#ircx".into()],
                auto_connect: true,
                client_certificate: None,
            })
            .unwrap();

        let conn = store.writing();
        let mut stmt = conn.prepare("SELECT * FROM networks").unwrap();
        let columns = stmt.column_count();
        let mut rows = stmt.query([]).unwrap();
        let mut inspected = 0;
        while let Some(row) = rows.next().unwrap() {
            for index in 0..columns {
                let value: rusqlite::types::Value = row.get(index).unwrap();
                assert_ne!(
                    value,
                    rusqlite::types::Value::Text("hunter2".into()),
                    "column {index} holds the SASL password"
                );
                inspected += 1;
            }
        }
        assert!(inspected > 0);
    }

    #[test]
    fn watched_nicks_survive_reloads_and_remove_caselessly() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("archive.sqlite3");
        Store::open_without_keyring(&path)
            .unwrap()
            .set_watched_nick("libera", "Sable", true)
            .unwrap();
        let store = Store::open_without_keyring(&path).unwrap();

        assert_eq!(store.watched_nicks("libera").unwrap(), vec!["Sable"]);

        store.set_watched_nick("libera", "sable", false).unwrap();
        assert!(store.watched_nicks("libera").unwrap().is_empty());
    }
}
