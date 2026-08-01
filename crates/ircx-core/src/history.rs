//! The `draft/chathistory` request: what to ask a server for, given what the
//! archive already holds.
//!
//! Only the request lives here. What comes back is a batch, and `message.rs`
//! already labels a `chathistory` batch `ServerHistory` and keeps it out of the
//! unread counts.

use time::{OffsetDateTime, UtcOffset};

use crate::session::build;

/// How much to ask for when the server states no limit of its own. Matches the
/// page the timeline reads from the archive, so a backfill and a scroll are the
/// same size to a reader.
pub(crate) const PAGE: u32 = 200;

/// How many conversations one `TARGETS` answer may name.
///
/// Smaller than a page of messages because each one costs a request of its own,
/// and because a nick messaged by a hundred people over a weekend should not
/// come back to a hundred rows. Whatever is beyond this is still in the
/// server's memory and still arrives the moment somebody speaks.
pub(crate) const TARGETS: u32 = 50;

/// How many pages of one gap to fetch before giving up on catching all of it.
///
/// A cap rather than a loop until the server runs out: a conversation somebody
/// was away from for a month is not worth a thousand requests, and the reader is
/// told where the fetching stopped. At `PAGE` apiece this is the last two
/// thousand messages of what was missed.
pub(crate) const GAP_PAGES: u32 = 10;

/// Which conversations were spoken in between `since` and now.
///
/// Both bounds have to be selectors: a server answers `*` with
/// `FAIL CHATHISTORY INVALID_PARAMS`, so there is no asking for "everything".
/// That suits the only question worth asking — what happened while this client
/// was away — which needs a near side anyway.
pub(crate) fn targets(since: &str, now: &str) -> Option<String> {
    let from = selector(since)?;
    let to = selector(now)?;
    build(
        "CHATHISTORY",
        &["TARGETS", &from, &to, &TARGETS.to_string()],
    )
}

/// `since` is when this conversation was last heard from. With one, the ask is
/// for the gap; without one, for the most recent page, which is what a channel
/// joined for the first time has to show.
pub(crate) fn request(target: &str, since: Option<&str>, limit: u32) -> Option<String> {
    let limit = limit.to_string();
    match since.and_then(selector) {
        Some(after) => build("CHATHISTORY", &["AFTER", target, &after, &limit]),
        None => build("CHATHISTORY", &["LATEST", target, "*", &limit]),
    }
}

/// `timestamp=` is milliseconds and a `Z`. The archive holds whatever the
/// `time` tag said or this machine's clock at nanosecond precision, so the
/// value is reformatted rather than passed through.
///
/// Truncating the sub-second part moves the bound earlier, which at worst asks
/// again for a message already held — the archive refuses the duplicate.
/// Rounding up would step over one.
///
/// A timestamp that will not parse comes from a server-set tag rather than from
/// an impossibility. Asking for the latest page instead loses nothing.
fn selector(timestamp: &str) -> Option<String> {
    let at = OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339)
        .ok()?
        .to_offset(UtcOffset::UTC);
    Some(format!(
        "timestamp={:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_archive_asks_for_the_most_recent_page() {
        assert_eq!(
            request("#ircx", None, 200).as_deref(),
            Some("CHATHISTORY LATEST #ircx * 200")
        );
    }

    #[test]
    fn an_archive_asks_for_what_came_after_it() {
        assert_eq!(
            request("#ircx", Some("2026-07-31T09:15:04.123456789Z"), 50).as_deref(),
            Some("CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:15:04.123Z 50")
        );
    }

    #[test]
    fn a_timestamp_off_utc_is_asked_for_in_utc() {
        assert_eq!(
            request("#ircx", Some("2026-07-31T11:15:04+02:00"), 50).as_deref(),
            Some("CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:15:04.000Z 50")
        );
    }

    #[test]
    fn a_timestamp_that_will_not_parse_asks_for_the_latest_page() {
        assert_eq!(
            request("#ircx", Some("whenever"), 200).as_deref(),
            Some("CHATHISTORY LATEST #ircx * 200")
        );
    }
}
