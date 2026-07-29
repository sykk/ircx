use ircx_ipc::{ChatMessage, MessageSource, Sender};
use rusqlite::{params, Row, Transaction};

use crate::{from_json_column, to_json, StoreError};

pub(crate) const COLUMNS: &str = "m.message_id, m.network, m.target, m.kind, m.sender_nick, \
     m.sender_user, m.sender_host, m.sender_account, m.sender_is_self, m.timestamp, \
     m.timestamp_is_local, m.text, m.tags, m.reply_to, m.batch, m.delivery, m.attachments, \
     m.encryption, m.raw";

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

/// `ChatMessage::id` holds either a server msgid or a locally minted UUID, and
/// only the former identifies a message across a replay. Recover it from the
/// tags, falling back to the shape of the id for senders that drop the tag.
fn server_msgid(message: &ChatMessage) -> Option<&str> {
    let tagged = message
        .tags
        .iter()
        .find(|(name, _)| name == "msgid")
        .and_then(|(_, value)| value.as_deref())
        .filter(|value| !value.is_empty());

    tagged.or_else(|| (!is_uuid(&message.id)).then_some(message.id.as_str()))
}

fn is_uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_uuid_is_not_a_msgid() {
        assert!(is_uuid("67e55044-10b1-426f-9247-bb680e5fe0c8"));
        assert!(!is_uuid("hZ0jgN2P8CqiO3F9Hx1nOs"));
        assert!(!is_uuid("67e55044-10b1-426f-9247-bb680e5fe0cZ"));
    }
}
