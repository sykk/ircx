use ircx_ipc::{ChatMessage, MessageSource, Sender};
use rusqlite::{params, Row, Transaction};

use crate::{from_json_column, to_json, StoreError};

pub(crate) const COLUMNS: &str = "m.message_id, m.network, m.target, m.kind, m.sender_nick, \
     m.sender_user, m.sender_host, m.sender_account, m.sender_is_self, m.timestamp, \
     m.timestamp_is_local, m.text, m.tags, m.reply_to, m.batch, m.delivery, m.attachments, \
     m.encryption, m.raw, m.server_msgid";

const INSERT: &str = "INSERT OR IGNORE INTO messages (
        message_id, server_msgid, network, target, kind, sender_nick, sender_user, sender_host,
        sender_account, sender_is_self, timestamp, timestamp_is_local, text, tags, reply_to,
        batch, delivery, attachments, encryption, raw
     ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
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
        ],
    )?;
    Ok(())
}

pub(crate) fn from_row(row: &Row) -> Result<ChatMessage, StoreError> {
    Ok(ChatMessage {
        id: row.get(0)?,
        id_is_local: row.get::<_, Option<String>>(19)?.is_none(),
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
        reply_to: row.get(13)?,
        batch: row.get(14)?,
        delivery: from_json_column(row, 15)?,
        attachments: from_json_column(row, 16)?,
        encryption: from_json_column(row, 17)?,
        raw: row.get(18)?,
        source: MessageSource::LocalArchive,
    })
}

/// Only a server msgid identifies a message across a replay. A locally minted
/// id is left out so the row falls to content-based dedupe instead.
fn server_msgid(message: &ChatMessage) -> Option<&str> {
    (!message.id_is_local).then_some(message.id.as_str())
}
