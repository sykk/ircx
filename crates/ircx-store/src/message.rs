use ircx_ipc::{Annotation, ChatMessage, MessageSource, Reaction, Sender};
use rusqlite::{params, Connection, Row, Transaction};

use crate::{from_json_column, to_json, StoreError};

pub(crate) const COLUMNS: &str = "m.message_id, m.network, m.target, m.kind, m.sender_nick, \
     m.sender_user, m.sender_host, m.sender_account, m.sender_is_self, m.timestamp, \
     m.timestamp_is_local, m.text, m.tags, m.reply_to, m.batch, m.delivery, m.attachments, \
     m.encryption, m.raw, m.server_msgid, m.via";

/// How many columns `COLUMNS` selects. A query that appends its own column
/// reads it at this index; hardcoding the number instead means the next column
/// added above silently hands that query the wrong one.
pub(crate) const COLUMN_COUNT: usize = 21;

const INSERT: &str = "INSERT OR IGNORE INTO messages (
        message_id, server_msgid, network, target, kind, sender_nick, sender_user, sender_host,
        sender_account, sender_is_self, timestamp, timestamp_is_local, text, tags, reply_to,
        batch, delivery, attachments, encryption, raw, via
     ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
        ?21
     )";

pub(crate) fn insert(tx: &Transaction, message: &ChatMessage) -> Result<(), StoreError> {
    tx.execute(
        INSERT,
        params![
            message.id,
            server_msgid(message),
            message.network,
            message.target,
            to_json(&message.kind)?,
            message.sender.nick,
            message.sender.user,
            message.sender.host,
            message.sender.account,
            message.sender.is_self,
            message.timestamp,
            message.timestamp_is_local,
            message.text,
            to_json(&message.tags)?,
            message.reply_to,
            message.batch,
            to_json(&message.delivery)?,
            to_json(&message.attachments)?,
            to_json(&message.encryption)?,
            message.raw,
            message.via,
        ],
    )?;
    Ok(())
}

/// Everything an echo told us about a message that is already a row. It is an
/// update because `INSERT` above is `INSERT OR IGNORE` and the optimistic copy
/// was written the moment the user pressed enter.
const CONFIRM: &str = "UPDATE messages
        SET server_msgid = ?3, timestamp = ?4, timestamp_is_local = ?5, delivery = ?6,
            tags = ?7, raw = ?8
     WHERE network = ?1 AND message_id = ?2";

/// Matching no row means the message was never archived, which is nothing the
/// caller can act on.
pub(crate) fn confirm(conn: &Connection, message: &ChatMessage) -> Result<(), StoreError> {
    conn.execute(
        CONFIRM,
        params![
            message.network,
            message.id,
            server_msgid(message),
            message.timestamp,
            message.timestamp_is_local,
            to_json(&message.delivery)?,
            to_json(&message.tags)?,
            message.raw,
        ],
    )?;
    Ok(())
}

pub(crate) fn from_row(row: &Row) -> Result<ChatMessage, StoreError> {
    let id: String = row.get(0)?;
    let msgid: Option<String> = row.get(19)?;
    Ok(ChatMessage {
        // A confirmed message of our own holds both: the local id the UI drew
        // it with, and the server's msgid beside it.
        id_is_local: msgid.as_deref() != Some(id.as_str()),
        id,
        network: row.get(1)?,
        target: row.get(2)?,
        kind: from_json_column(row, 3)?,
        sender: Sender {
            nick: row.get(4)?,
            user: row.get(5)?,
            host: row.get(6)?,
            account: row.get(7)?,
            is_self: row.get(8)?,
        },
        timestamp: row.get(9)?,
        timestamp_is_local: row.get(10)?,
        text: row.get(11)?,
        tags: from_json_column(row, 12)?,
        // Reactions live in their own table, keyed by msgid rather than by a
        // row here; `attach_reactions` fills them in for a page that has been
        // read.
        reactions: Vec::new(),
        // Same: `attach_annotations` fills these in for a page that has been
        // read.
        annotations: Vec::new(),
        reply_to: row.get(13)?,
        batch: row.get(14)?,
        delivery: from_json_column(row, 15)?,
        attachments: from_json_column(row, 16)?,
        encryption: from_json_column(row, 17)?,
        raw: row.get(18)?,
        source: MessageSource::LocalArchive,
        via: row.get(20)?,
    })
}

const SET_REACTION: &str = "INSERT OR IGNORE INTO reactions (network, msgid, nick, emoji)
     VALUES (?1, ?2, ?3, ?4)";

const UNSET_REACTION: &str =
    "DELETE FROM reactions WHERE network = ?1 AND msgid = ?2 AND nick = ?3 AND emoji = ?4";

pub(crate) fn set_reaction(
    conn: &Connection,
    network: &str,
    msgid: &str,
    nick: &str,
    emoji: &str,
    active: bool,
) -> Result<(), StoreError> {
    let sql = match active {
        true => SET_REACTION,
        false => UNSET_REACTION,
    };
    conn.execute(sql, params![network, msgid, nick, emoji])?;
    Ok(())
}

const REACTIONS: &str =
    "SELECT nick, emoji FROM reactions WHERE network = ?1 AND msgid = ?2 ORDER BY id";

/// Fills in the reactions for messages already read. Grouped by value in the
/// order the first of each arrived, and the nicks within a value likewise, so
/// the chips a reader sees do not reshuffle between one page load and the next.
pub(crate) fn attach_reactions(
    conn: &Connection,
    messages: &mut [ChatMessage],
) -> Result<(), StoreError> {
    let mut stmt = conn.prepare_cached(REACTIONS)?;
    for message in messages {
        let (network, key) = (message.network.clone(), reaction_key(message).to_string());
        let mut rows = stmt.query(params![network, key])?;
        let mut reactions: Vec<Reaction> = Vec::new();
        while let Some(row) = rows.next()? {
            let nick: String = row.get(0)?;
            let emoji: String = row.get(1)?;
            match reactions.iter_mut().find(|held| held.emoji == emoji) {
                Some(held) => held.nicks.push(nick),
                None => reactions.push(Reaction {
                    emoji,
                    nicks: vec![nick],
                }),
            }
        }
        message.reactions = reactions;
    }
    Ok(())
}

const SET_ANNOTATION: &str =
    "INSERT INTO annotations (network, msgid, plugin, text) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (network, msgid, plugin) DO UPDATE SET text = excluded.text";

pub(crate) fn set_annotation(
    conn: &Connection,
    network: &str,
    msgid: &str,
    plugin: &str,
    text: &str,
) -> Result<(), StoreError> {
    conn.execute(SET_ANNOTATION, params![network, msgid, plugin, text])?;
    Ok(())
}

const ANNOTATIONS: &str =
    "SELECT plugin, text FROM annotations WHERE network = ?1 AND msgid = ?2 ORDER BY plugin";

/// Fills in the notes for messages already read. Ordered by plugin rather than
/// by arrival, because two annotators race and a reader should not find the
/// same two notes swapping places between one page load and the next.
pub(crate) fn attach_annotations(
    conn: &Connection,
    messages: &mut [ChatMessage],
) -> Result<(), StoreError> {
    let mut stmt = conn.prepare_cached(ANNOTATIONS)?;
    for message in messages {
        let (network, key) = (message.network.clone(), message.id.clone());
        let mut rows = stmt.query(params![network, key])?;
        let mut annotations = Vec::new();
        while let Some(row) = rows.next()? {
            annotations.push(Annotation {
                plugin: row.get(0)?,
                text: row.get(1)?,
            });
        }
        message.annotations = annotations;
    }
    Ok(())
}

/// What a `+reply` can name this message by. Only a server msgid reaches
/// another client, so a message that has one is found by it; one that does not
/// falls back to its local id, which nothing remote will ever ask for.
fn reaction_key(message: &ChatMessage) -> &str {
    server_msgid(message).unwrap_or(&message.id)
}

/// Only a server msgid identifies a message across a replay. A locally minted
/// id is left out so the row falls to content-based dedupe instead.
///
/// A message we sent keeps its local id, so for that one the server's name for
/// it is the `msgid` tag its echo carried.
fn server_msgid(message: &ChatMessage) -> Option<&str> {
    if !message.id_is_local {
        return Some(message.id.as_str());
    }
    message
        .tags
        .iter()
        .find(|(name, _)| name == "msgid")
        .and_then(|(_, value)| value.as_deref())
        .filter(|msgid| !msgid.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{COLUMNS, COLUMN_COUNT};

    /// The number and the list have to agree, because a query that appends its
    /// own column reads it at `COLUMN_COUNT` and would otherwise be handed the
    /// last column of this list instead.
    #[test]
    fn the_column_count_matches_the_columns() {
        assert_eq!(COLUMNS.split(',').count(), COLUMN_COUNT);
    }
}
