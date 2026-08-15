use std::collections::HashMap;

use ircx_ipc::{Annotation, ChatMessage, Delivery, MessageSource, Reaction, Sender};
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

/// A replayed message claiming the copy this client drew when it was typed.
///
/// Matched on the text rather than on time, because the two stamps are on
/// different clocks: `written_at` is ours, the replay's timestamp is the
/// server's, and a server an hour out would otherwise turn this off without
/// saying so. The hour is a staleness bound rather than the match itself —
/// unbounded, a replay could claim a copy from weeks ago and the message
/// arriving now would never be archived at all, which is worse than the
/// doubling this exists to stop.
///
/// That a copy reached the socket is part of the comparison rather than a
/// clause of its own: `written_at` is stamped on the `sent` transition and
/// nowhere else, so a line still queued or already failed has none, and `ABS`
/// of a NULL is NULL, which no row matches on.
///
/// The timestamp is deliberately not taken. An echo arrives while the message
/// is the newest thing on screen, so `confirm` moving it costs nothing; a
/// replay can arrive a relaunch later, and a line that jumped four seconds down
/// the timeline on startup would be a stranger thing than the doubling. The
/// tags are taken, because the `msgid` among them is what a reply or a reaction
/// names, and a message that cannot be answered is not fixed.
///
/// A msgid the archive already holds adopts nothing: the same words said
/// twice leave a second unclaimed copy, and a replay of the *claimed* one
/// would otherwise hand its msgid to the twin — which the unique index
/// refuses, taking the caller's whole transaction with it.
const ADOPT: &str = "UPDATE messages
        SET server_msgid = ?1, tags = ?6, raw = ?7
     WHERE id = (
        SELECT id FROM messages
         WHERE network = ?2 AND target = ?3 COLLATE NOCASE AND text = ?4
           AND sender_is_self = 1 AND server_msgid IS NULL
           AND ABS(strftime('%s', written_at) - strftime('%s', ?5)) <= 3600
         ORDER BY id
         LIMIT 1
     )
     AND NOT EXISTS (
        SELECT 1 FROM messages WHERE network = ?2 AND server_msgid = ?1
     )";

/// Whether this message is a replay of one already archived. Repeated identical
/// lines pair up oldest first, so saying the same thing twice matches the two
/// copies in the order they were said.
fn adopted(tx: &Transaction, message: &ChatMessage) -> Result<bool, StoreError> {
    if !message.sender.is_self {
        return Ok(false);
    }
    let Some(msgid) = server_msgid(message) else {
        return Ok(false);
    };
    let claimed = tx.execute(
        ADOPT,
        params![
            msgid,
            message.network,
            message.target,
            message.text,
            message.timestamp,
            to_json(&message.tags)?,
            message.raw,
        ],
    )?;
    Ok(claimed == 1)
}

pub(crate) fn insert(tx: &Transaction, message: &ChatMessage) -> Result<(), StoreError> {
    if adopted(tx, message)? {
        return Ok(());
    }
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
            tags = ?7, raw = ?8,
            written_at = COALESCE(
                written_at,
                CASE WHEN ?9 THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
            )
     WHERE network = ?1 AND message_id = ?2
       AND NOT EXISTS (
        SELECT 1 FROM messages
         WHERE network = ?1 AND server_msgid = ?3 AND message_id != ?2
     )";

/// Matching no row means the message was never archived, which is nothing the
/// caller can act on. A msgid already on some other row means a replay claimed
/// the wrong twin first; refusing the update is the honest answer the unique
/// index would otherwise give as an error.
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
            // The clock is taken here rather than passed in because the write
            // is the only thing this stamp has to be near, and the update that
            // reports one arrives within milliseconds of it. `COALESCE` keeps
            // the first: a later state does not restamp a line already gone.
            message.delivery == Delivery::Sent,
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
        // Same, from `attach_raised`.
        raised_by: Vec::new(),
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

/// How many msgids go into one `IN` list. SQLite takes far more bound
/// parameters than this; the chunk is what stops a caller's own limit — which
/// `search` takes from the user — deciding how large a statement gets.
const KEYS_AT_A_TIME: usize = 500;

/// Where in the page each `(network, msgid)` is, which is what the answer to
/// one statement has to be fanned back out over.
///
/// A key can name more than one row. A search reads whichever conversations
/// match, so the same message can arrive twice in one set of results, and both
/// copies want what hangs off it.
fn positions<'a>(
    messages: &'a [ChatMessage],
    key: fn(&'a ChatMessage) -> &'a str,
) -> HashMap<(&'a str, &'a str), Vec<usize>> {
    let mut at: HashMap<(&str, &str), Vec<usize>> = HashMap::new();
    for (index, message) in messages.iter().enumerate() {
        at.entry((message.network.as_str(), key(message)))
            .or_default()
            .push(index);
    }
    at
}

/// Asks one of the tables hanging off a message for the whole page at once,
/// and hands every row back with the network it was read under.
///
/// The three of them were a statement per message until #526: six hundred
/// executions for a 200-row page, most of them answering nothing, and three
/// quarters of what reading the page cost. `docs/measurements.md` has the
/// figures. All three tables are keyed by `(network, msgid)`, so a page is one
/// `IN` list per network it names.
///
/// The list is bound parameters rather than text, and `{msgids}` in the
/// statement is where they go. It is chunked because a page's size is the
/// caller's, and a statement's is not something a caller should be choosing.
fn rows_for_page(
    conn: &Connection,
    sql: &str,
    at: &HashMap<(&str, &str), Vec<usize>>,
    mut take: impl FnMut(&str, &Row<'_>) -> Result<(), StoreError>,
) -> Result<(), StoreError> {
    let mut by_network: HashMap<&str, Vec<&str>> = HashMap::new();
    for (network, msgid) in at.keys() {
        by_network.entry(network).or_default().push(msgid);
    }

    for (network, msgids) in by_network {
        for chunk in msgids.chunks(KEYS_AT_A_TIME) {
            let list = (0..chunk.len())
                .map(|index| format!("?{}", index + 2))
                .collect::<Vec<_>>()
                .join(", ");
            // Cached, because a reader paging back through a conversation asks
            // for the same page size every time, which is the same statement
            // text with the same two hundred placeholders in it.
            let mut stmt = conn.prepare_cached(&sql.replace("{msgids}", &list))?;
            let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
            bound.push(&network);
            bound.extend(chunk.iter().map(|msgid| msgid as &dyn rusqlite::ToSql));
            let mut rows = stmt.query(bound.as_slice())?;
            while let Some(row) = rows.next()? {
                take(network, row)?;
            }
        }
    }
    Ok(())
}

const REACTIONS: &str = "SELECT msgid, nick, emoji FROM reactions
     WHERE network = ?1 AND msgid IN ({msgids}) ORDER BY id";

/// Fills in the reactions for messages already read. Grouped by value in the
/// order the first of each arrived, and the nicks within a value likewise, so
/// the chips a reader sees do not reshuffle between one page load and the next.
pub(crate) fn attach_reactions(
    conn: &Connection,
    messages: &mut [ChatMessage],
) -> Result<(), StoreError> {
    let at = positions(messages, reaction_key);
    let mut filled: Vec<Vec<Reaction>> = vec![Vec::new(); messages.len()];
    rows_for_page(conn, REACTIONS, &at, |network, row| {
        let msgid: String = row.get(0)?;
        let nick: String = row.get(1)?;
        let emoji: String = row.get(2)?;
        for index in at.get(&(network, msgid.as_str())).into_iter().flatten() {
            let reactions = &mut filled[*index];
            match reactions.iter_mut().find(|held| held.emoji == emoji) {
                Some(held) => held.nicks.push(nick.clone()),
                None => reactions.push(Reaction {
                    emoji: emoji.clone(),
                    nicks: vec![nick.clone()],
                }),
            }
        }
        Ok(())
    })?;
    for (message, reactions) in messages.iter_mut().zip(filled) {
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

const ANNOTATIONS: &str = "SELECT msgid, plugin, text FROM annotations
     WHERE network = ?1 AND msgid IN ({msgids}) ORDER BY plugin";

/// Fills in the notes for messages already read. Ordered by plugin rather than
/// by arrival, because two annotators race and a reader should not find the
/// same two notes swapping places between one page load and the next.
pub(crate) fn attach_annotations(
    conn: &Connection,
    messages: &mut [ChatMessage],
) -> Result<(), StoreError> {
    let at = positions(messages, |message| message.id.as_str());
    let mut filled: Vec<Vec<Annotation>> = vec![Vec::new(); messages.len()];
    rows_for_page(conn, ANNOTATIONS, &at, |network, row| {
        let msgid: String = row.get(0)?;
        let annotation = Annotation {
            plugin: row.get(1)?,
            text: row.get(2)?,
        };
        for index in at.get(&(network, msgid.as_str())).into_iter().flatten() {
            filled[*index].push(annotation.clone());
        }
        Ok(())
    })?;
    for (message, annotations) in messages.iter_mut().zip(filled) {
        message.annotations = annotations;
    }
    Ok(())
}

const SET_RAISED: &str =
    "INSERT OR IGNORE INTO raised (network, msgid, plugin) VALUES (?1, ?2, ?3)";

pub(crate) fn set_raised(
    conn: &Connection,
    network: &str,
    msgid: &str,
    plugin: &str,
) -> Result<(), StoreError> {
    conn.execute(SET_RAISED, params![network, msgid, plugin])?;
    Ok(())
}

const RAISED: &str = "SELECT msgid, plugin FROM raised
     WHERE network = ?1 AND msgid IN ({msgids}) ORDER BY plugin";

/// Fills in who raised each message on a page already read, ordered by plugin
/// for the reason the notes are.
pub(crate) fn attach_raised(
    conn: &Connection,
    messages: &mut [ChatMessage],
) -> Result<(), StoreError> {
    let at = positions(messages, |message| message.id.as_str());
    let mut filled: Vec<Vec<String>> = vec![Vec::new(); messages.len()];
    rows_for_page(conn, RAISED, &at, |network, row| {
        let msgid: String = row.get(0)?;
        let plugin: String = row.get(1)?;
        for index in at.get(&(network, msgid.as_str())).into_iter().flatten() {
            filled[*index].push(plugin.clone());
        }
        Ok(())
    })?;
    for (message, raised) in messages.iter_mut().zip(filled) {
        message.raised_by = raised;
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
