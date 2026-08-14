//! The `draft/chathistory` request: what to ask a server for, given what the
//! archive already holds.
//!
//! Only the request lives here. What comes back is a batch, and `message.rs`
//! already labels a `chathistory` batch `ServerHistory` and keeps it out of the
//! unread counts.

use ircx_proto::MessageBuilder;
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
/// told where the fetching stopped. At `PAGE` apiece this is two thousand
/// messages of what was missed.
pub(crate) const GAP_PAGES: u32 = 10;

/// How much of that budget is spent walking forward from the archive's
/// watermark before the walk turns round and spends the rest at the near end.
///
/// The cap is what makes the direction matter. Under it every page arrives
/// whichever way the walk runs; at it, the direction decides which half of the
/// gap the reader loses — and fetched forward, what is lost is the stretch that
/// leads into the conversation happening now. Halved, the reader keeps what
/// continues from where they stopped reading and what runs up to the live seam,
/// with the hole between them rather than under the seam. #520.
pub(crate) const GAP_FORWARD: u32 = GAP_PAGES / 2;

/// Which conversations were spoken in between `since` and now.
///
/// Both bounds have to be selectors: a server answers `*` with
/// `FAIL CHATHISTORY INVALID_PARAMS`, so there is no asking for "everything".
/// That suits the only question worth asking — what happened while this client
/// was away — which needs a near side anyway.
pub(crate) fn targets(since: &str, now: &str) -> Option<String> {
    let from = at(since)?;
    let to = at(now)?;
    build(
        "CHATHISTORY",
        &["TARGETS", &from, &to, &TARGETS.to_string()],
    )
}

/// Where the ask for a gap starts from.
///
/// A timestamp is always there; a msgid is there whenever a server gave one and
/// is preferred, because it is the only one of the two that is exact. `AFTER`
/// is exclusive and a millisecond is not a unique key, so a timestamp steps over
/// everything sharing it — which against a real server cost the message at the
/// far side of a page boundary, and costs however many share that millisecond.
/// #253.
pub(crate) struct Resume<'a> {
    pub(crate) timestamp: &'a str,
    /// `None` on the first request of a gap, which has only the archive's
    /// watermark to go on, and from any server that sends no `msgid`.
    pub(crate) msgid: Option<&'a str>,
}

/// `since` is where this conversation was last heard from. With one, the ask is
/// for the gap; without one, for the most recent page, which is what a channel
/// joined for the first time has to show.
pub(crate) fn request(target: &str, since: Option<Resume<'_>>, limit: u32) -> Option<String> {
    let limit = limit.to_string();
    match since.and_then(selector) {
        Some(after) => build("CHATHISTORY", &["AFTER", target, &after, &limit]),
        None => build("CHATHISTORY", &["LATEST", target, "*", &limit]),
    }
}

/// The page behind what a reader already holds, which is the other direction
/// from `request`: `AFTER` fills forward from the archive's newest message and
/// this reaches back past its oldest.
///
/// `label` names the request on the batch that answers it. Nothing else can:
/// a gap fill and a page back are both `chathistory` batches for the same
/// conversation, and the answer to this one is a page nobody was waiting for
/// unless it can be matched to the reader who asked.
///
/// `None` is the second half of a gap fill, which walks back from now (#520)
/// and wants the opposite: an unlabelled batch is the one nobody is waiting on,
/// and what fills a gap is what the reader missed rather than what they scrolled
/// to.
///
/// No fallback to `LATEST` where the selector will not build, unlike `request`.
/// The reader is asking for what is behind a particular message, and the most
/// recent page is what they are already looking at.
pub(crate) fn before(
    target: &str,
    from: Resume<'_>,
    limit: u32,
    label: Option<&str>,
) -> Option<String> {
    let selector = selector(from)?;
    let mut request = MessageBuilder::new("CHATHISTORY");
    if let Some(label) = label {
        request = request.tag("label", Some(label.to_string()));
    }
    request
        .param("BEFORE")
        .param(target)
        .param(selector)
        .param(limit.to_string())
        .build()
        .ok()
        .map(|message| message.to_line())
}

/// A millisecond before the message named, which is where a row belonging above
/// it goes.
///
/// The timeline files a message by its timestamp and the archive reads it back
/// the same way, so a row stamped with its neighbour's own timestamp has no
/// settled side to land on. A millisecond is what the wire's own resolution
/// makes the smallest step there is.
pub(crate) fn just_before(timestamp: &str) -> Option<String> {
    let at = OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339)
        .ok()?
        - time::Duration::milliseconds(1);
    at.format(&time::format_description::well_known::Rfc3339)
        .ok()
}

/// The msgid where there is one to use, and the timestamp otherwise.
///
/// A msgid is a tag value and unescaping turns `\s` into a space, so one can
/// arrive holding a character that would end the parameter early. That msgid is
/// passed over rather than refused: falling back to the timestamp fetches the
/// same page less exactly, where refusing would abandon the gap.
fn selector(from: Resume<'_>) -> Option<String> {
    from.msgid
        .filter(|id| !id.is_empty() && !id.contains([' ', '\r', '\n', '\0']))
        .map(|id| format!("msgid={id}"))
        .or_else(|| at(from.timestamp))
}

/// `timestamp=` is milliseconds and a `Z`. The archive holds whatever the
/// `time` tag said or this machine's clock at nanosecond precision, so the
/// value is reformatted rather than passed through.
///
/// Truncating the sub-second part moves the bound earlier, which for `AFTER` at
/// worst asks again for a message already held — the archive refuses the
/// duplicate. Rounding up would step over one.
///
/// For `BEFORE` the same truncation asks for slightly less, so a message
/// sharing that millisecond and older than the one named can be missed. It is
/// the sliver a server that sends no msgid costs; with one, `selector` never
/// comes here.
///
/// A timestamp that will not parse comes from a server-set tag rather than from
/// an impossibility. Asking for the latest page instead loses nothing.
fn at(timestamp: &str) -> Option<String> {
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

    fn at_only(timestamp: &str) -> Resume<'_> {
        Resume {
            timestamp,
            msgid: None,
        }
    }

    #[test]
    fn an_empty_archive_asks_for_the_most_recent_page() {
        assert_eq!(
            request("#ircx", None, 200).as_deref(),
            Some("CHATHISTORY LATEST #ircx * 200")
        );
    }

    #[test]
    fn a_reader_scrolling_back_asks_for_the_page_behind_what_they_hold() {
        assert_eq!(
            before(
                "#ircx",
                at_only("2026-07-31T09:15:04.123456789Z"),
                200,
                Some("ircx-1")
            )
            .as_deref(),
            Some("@label=ircx-1 CHATHISTORY BEFORE #ircx timestamp=2026-07-31T09:15:04.123Z 200")
        );
    }

    #[test]
    fn a_page_back_prefers_the_msgid_the_server_gave() {
        let from = Resume {
            timestamp: "2026-07-31T09:15:04.123Z",
            msgid: Some("pqpmmxnsetcinv4abh5jmxn3gs"),
        };

        assert_eq!(
            before("#ircx", from, 200, Some("ircx-7")).as_deref(),
            Some("@label=ircx-7 CHATHISTORY BEFORE #ircx msgid=pqpmmxnsetcinv4abh5jmxn3gs 200")
        );
    }

    /// The second half of a gap fill asks the same question with nobody waiting
    /// on the answer, so it goes out bare. #520.
    #[test]
    fn a_gap_walking_back_asks_without_a_label() {
        assert_eq!(
            before("#ircx", at_only("2026-07-31T09:15:04.123Z"), 200, None).as_deref(),
            Some("CHATHISTORY BEFORE #ircx timestamp=2026-07-31T09:15:04.123Z 200")
        );
    }

    /// Where `request` falls back to the latest page, this asks for nothing. The
    /// reader wants what is behind one particular message, and the latest page
    /// is what they are already looking at.
    #[test]
    fn a_page_back_from_a_timestamp_that_will_not_parse_asks_for_nothing() {
        assert!(before("#ircx", at_only("the other day"), 200, Some("ircx-1")).is_none());
        assert_eq!(
            request("#ircx", Some(at_only("the other day")), 200).as_deref(),
            Some("CHATHISTORY LATEST #ircx * 200")
        );
    }

    #[test]
    fn an_archive_asks_for_what_came_after_it() {
        assert_eq!(
            request("#ircx", Some(at_only("2026-07-31T09:15:04.123456789Z")), 50).as_deref(),
            Some("CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:15:04.123Z 50")
        );
    }

    #[test]
    fn a_timestamp_off_utc_is_asked_for_in_utc() {
        assert_eq!(
            request("#ircx", Some(at_only("2026-07-31T11:15:04+02:00")), 50).as_deref(),
            Some("CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:15:04.000Z 50")
        );
    }

    #[test]
    fn a_timestamp_that_will_not_parse_asks_for_the_latest_page() {
        assert_eq!(
            request("#ircx", Some(at_only("whenever")), 200).as_deref(),
            Some("CHATHISTORY LATEST #ircx * 200")
        );
    }

    #[test]
    fn a_msgid_is_asked_for_ahead_of_the_timestamp_beside_it() {
        let resume = Resume {
            timestamp: "2026-07-31T09:15:04.123Z",
            msgid: Some("pqpmmxnsetcinv4abh5jmxn3gs"),
        };
        assert_eq!(
            request("#ircx", Some(resume), 200).as_deref(),
            Some("CHATHISTORY AFTER #ircx msgid=pqpmmxnsetcinv4abh5jmxn3gs 200")
        );
    }

    /// Unescaping a tag value turns `\s` into a space, so a msgid can arrive
    /// holding one. Asking on the timestamp instead fetches the same page; a
    /// refusal would abandon the gap.
    #[test]
    fn a_msgid_that_would_not_survive_the_line_falls_back_to_the_timestamp() {
        for id in ["", "two words", "line\r\nbreak"] {
            let resume = Resume {
                timestamp: "2026-07-31T09:15:04.123Z",
                msgid: Some(id),
            };
            assert_eq!(
                request("#ircx", Some(resume), 200).as_deref(),
                Some("CHATHISTORY AFTER #ircx timestamp=2026-07-31T09:15:04.123Z 200"),
                "{id:?} should have been passed over"
            );
        }
    }
}
