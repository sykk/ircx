//! SQLite persistence: message archive with FTS5, drafts, network config, and
//! credentials held in the OS keyring.

mod credentials;
mod error;
mod message;
mod migrations;

pub use error::StoreError;

use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, PoisonError};

use ircx_ipc::{
    ChatMessage, HistoryRequest, NetworkConfig, NetworkId, SaslConfig, SearchHit, SearchRequest,
    TargetName,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::de::DeserializeOwned;
use serde::Serialize;

use credentials::{CredentialStore, MemoryCredentials, OsKeyring};

const NETWORK_COLUMNS: &str = "id, name, host, port, tls, tls_verify, nick, alt_nicks, username, \
     realname, sasl_mechanism, sasl_account, connect_commands, autojoin, auto_connect";

/// A network-wide retention rule is stored as a target override with no target.
const DEFAULT_TARGET: &str = "";

pub struct Store {
    conn: Mutex<Connection>,
    credentials: Box<dyn CredentialStore>,
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
        let conn = Connection::open(path).map_err(|source| StoreError::Open {
            path: path.to_path_buf(),
            source,
        })?;
        Self::init(conn, Box::new(OsKeyring))
    }

    /// Ephemeral in every respect: passwords go to a process-local map instead
    /// of the OS keyring, so tests never write to the developer's login store.
    pub fn open_in_memory() -> Result<Self, StoreError> {
        let conn = Connection::open_in_memory().map_err(|source| StoreError::Open {
            path: ":memory:".into(),
            source,
        })?;
        Self::init(conn, Box::new(MemoryCredentials::default()))
    }

    fn init(
        mut conn: Connection,
        credentials: Box<dyn CredentialStore>,
    ) -> Result<Self, StoreError> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        migrations::migrate(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            credentials,
        })
    }

    /// A panic elsewhere leaves the connection usable: rusqlite rolls an open
    /// transaction back when its guard drops, so the poison flag is noise here.
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Messages already in the archive are skipped, so replaying history over
    /// an existing timeline is a no-op rather than a second copy.
    pub fn append_messages(&self, messages: &[ChatMessage]) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        for message in messages {
            message::insert(&tx, message)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Applies what a server echo added to a message already archived: its
    /// delivery state, the server's msgid and time, the tags it arrived with.
    /// Silently does nothing when the message is not in the archive.
    pub fn update_message(&self, message: &ChatMessage) -> Result<(), StoreError> {
        message::confirm(&self.conn(), message)
    }

    /// Oldest first, so a caller can render the page in order. `before` pages
    /// backwards from the oldest message already on screen.
    pub fn load_history(&self, req: &HistoryRequest) -> Result<Vec<ChatMessage>, StoreError> {
        let sql = format!(
            "SELECT {columns}
             FROM messages m
             WHERE m.network = ?1 AND m.target = ?2 AND (?3 IS NULL OR m.timestamp < ?3)
             ORDER BY m.timestamp DESC, m.id DESC
             LIMIT ?4",
            columns = message::COLUMNS,
        );

        let conn = self.conn();
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = stmt.query(params![req.network, req.target, req.before, req.limit])?;
        let mut page = Vec::new();
        while let Some(row) = rows.next()? {
            page.push(message::from_row(row)?);
        }
        message::attach_reactions(&conn, &mut page)?;
        page.reverse();
        Ok(page)
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
        message::set_reaction(&self.conn(), network, msgid, nick, emoji, active)
    }

    /// `req.query` is text a person typed, not an FTS5 expression: it is
    /// quoted term by term before it reaches MATCH, so a hyphen, a colon or a
    /// bare `OR` is searched for rather than obeyed.
    pub fn search(&self, req: &SearchRequest) -> Result<Vec<SearchHit>, StoreError> {
        let query = fts_phrases(&req.query);
        if query.is_empty() {
            return Ok(Vec::new());
        }

        let sql = format!(
            "SELECT {columns}, snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12)
             FROM messages_fts
             JOIN messages m ON m.id = messages_fts.rowid
             WHERE messages_fts MATCH ?1
               AND (?2 IS NULL OR m.network = ?2)
               AND (?3 IS NULL OR m.target = ?3)
             ORDER BY m.timestamp DESC, m.id DESC
             LIMIT ?4",
            columns = message::COLUMNS,
        );

        let conn = self.conn();
        let mut stmt = conn.prepare(&sql).map_err(search_error)?;
        let mut rows = stmt
            .query(params![query, req.network, req.target, req.limit])
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
            .map(|(message, snippet)| SearchHit { message, snippet })
            .collect())
    }

    pub fn list_networks(&self) -> Result<Vec<NetworkConfig>, StoreError> {
        let conn = self.conn();
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

    /// The SASL password goes to the keyring and never to SQLite. A config
    /// saved without one leaves any stored password alone; dropping SASL
    /// entirely deletes it.
    pub fn save_network(&self, config: &NetworkConfig) -> Result<NetworkId, StoreError> {
        let id = match &config.id {
            Some(id) => id.clone(),
            None => self
                .conn()
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

        self.conn().execute(
            &format!(
                "INSERT INTO networks ({NETWORK_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
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
                     auto_connect = excluded.auto_connect"
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
            ],
        )?;

        Ok(id)
    }

    /// Drops the config, its password and the conversations it had open.
    /// Messages from the network stay; `delete_target` is how an archive is
    /// thrown away.
    pub fn remove_network(&self, id: &NetworkId) -> Result<(), StoreError> {
        self.credentials.delete(id)?;
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM networks WHERE id = ?1", params![id])?;
        tx.execute("DELETE FROM open_targets WHERE network = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Records a conversation as open, so the next launch comes back to it.
    /// Idempotent: joining a channel again is not a second row.
    pub fn remember_target(&self, network: &str, target: &OpenTarget) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT INTO open_targets (network, target, kind) VALUES (?1, ?2, ?3)
             ON CONFLICT (network, target) DO UPDATE SET kind = excluded.kind",
            params![network, target.name(), target.kind()],
        )?;
        Ok(())
    }

    /// Drops a conversation from the set the next launch reopens. The messages
    /// stay; `delete_target` is how an archive is thrown away.
    pub fn forget_target(&self, network: &str, target: &str) -> Result<(), StoreError> {
        self.conn().execute(
            "DELETE FROM open_targets WHERE network = ?1 AND target = ?2",
            params![network, target],
        )?;
        Ok(())
    }

    pub fn open_targets(&self, network: &str) -> Result<Vec<OpenTarget>, StoreError> {
        let conn = self.conn();
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
            .conn()
            .query_row(
                "SELECT text FROM drafts WHERE network = ?1 AND target = ?2",
                params![network, target],
                |row| row.get(0),
            )
            .optional()?;
        Ok(draft)
    }

    /// Empty text clears the draft rather than storing a blank one.
    pub fn set_draft(&self, network: &str, target: &str, text: &str) -> Result<(), StoreError> {
        let conn = self.conn();
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

    /// `target` of `None` sets the network default. `days` of `None` keeps
    /// messages forever, and as a target override it outranks the default.
    pub fn set_retention(
        &self,
        network: &str,
        target: Option<&str>,
        days: Option<u32>,
    ) -> Result<(), StoreError> {
        self.conn().execute(
            "INSERT INTO retention (network, target, days) VALUES (?1, ?2, ?3)
             ON CONFLICT (network, target) DO UPDATE SET days = excluded.days",
            params![network, target.unwrap_or(DEFAULT_TARGET), days],
        )?;
        Ok(())
    }

    /// Deletes everything past its retention window and returns how many
    /// messages went. A no-op when nothing has expired, so it is safe on
    /// every startup.
    pub fn prune(&self) -> Result<u64, StoreError> {
        // CASE, not COALESCE: a target row with NULL days means keep forever
        // and has to beat the network default rather than fall through to it.
        // Comparing against a NULL window is never true, so those rows stay.
        let deleted = self.conn().execute(
            "DELETE FROM messages WHERE id IN (
                 SELECT m.id
                 FROM messages m
                 LEFT JOIN retention t ON t.network = m.network AND t.target = m.target
                 LEFT JOIN retention n ON n.network = m.network AND n.target = ''
                 WHERE m.timestamp < strftime(
                     '%Y-%m-%dT%H:%M:%SZ',
                     'now',
                     '-' || (CASE WHEN t.network IS NOT NULL THEN t.days ELSE n.days END) || ' days'
                 )
             )",
            [],
        )?;
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
             WHERE m.network = ?1 AND m.target = ?2
             ORDER BY m.timestamp, m.id",
            columns = message::COLUMNS,
        );

        let conn = self.conn();
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

    pub fn delete_target(&self, network: &str, target: &str) -> Result<(), StoreError> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE network = ?1 AND target = ?2",
            params![network, target],
        )?;
        tx.execute(
            "DELETE FROM drafts WHERE network = ?1 AND target = ?2",
            params![network, target],
        )?;
        tx.commit()?;
        Ok(())
    }
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
    })
}

/// Turns what the user typed into an FTS5 expression that means it literally.
/// Each whitespace-separated run becomes a quoted phrase — FTS5 reads no
/// operator inside quotes — and a typed quote is doubled, which is how FTS5
/// escapes one. Phrases side by side are ANDed, so every word has to appear.
fn fts_phrases(query: &str) -> String {
    query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
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
            })
            .unwrap();

        let conn = store.conn();
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
}
