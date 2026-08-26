use ircx_ipc::Attachment;

/// Trailing punctuation is far more likely to be the sentence's than the
/// URL's. Closing brackets are handled separately so a link inside parentheses
/// survives.
const TRAILING: &[char] = &['.', ',', ';', ':', '!', '?', '\'', '"', '*', '_'];

pub fn ctcp(text: &str) -> Option<(&str, &str)> {
    let body = text.strip_prefix('\u{1}')?;
    let body = body.strip_suffix('\u{1}').unwrap_or(body);
    Some(match body.split_once(' ') {
        Some((command, rest)) => (command, rest),
        None => (body, ""),
    })
}

/** Wraps a CTCP query or reply for the trailing parameter of PRIVMSG or NOTICE. */
pub fn ctcp_wrap(command: &str, args: &str) -> String {
    if args.is_empty() {
        format!("\u{1}{command}\u{1}")
    } else {
        format!("\u{1}{command} {args}\u{1}")
    }
}

pub fn attachments(text: &str) -> Vec<Attachment> {
    let mut found = Vec::new();
    let bytes = text.as_bytes();
    let mut cursor = 0;

    while let Some(offset) = text[cursor..].find("://") {
        let scheme_end = cursor + offset;
        let start = scheme_start(text, scheme_end);
        let Some(start) = start else {
            cursor = scheme_end + 3;
            continue;
        };
        let mut end = scheme_end + 3;
        while end < bytes.len() && bytes[end] > b' ' {
            end += 1;
        }
        let url = trim_trailing(&text[start..end]);
        cursor = end;

        if url.len() <= scheme_end - start + 3 {
            continue;
        }
        if found.iter().any(|a: &Attachment| a.url == url) {
            continue;
        }
        found.push(Attachment {
            url: url.to_string(),
            filename: filename(url),
            mime: mime(url),
            size_bytes: None,
            preview: None,
        });
    }
    found
}

/// Splits text so each piece fits `budget` bytes on the wire, breaking at the
/// last space where one is close enough to the end to be worth it.
pub fn split_for_wire(text: &str, budget: usize) -> Vec<String> {
    let budget = budget.max(1);
    if text.len() <= budget {
        return vec![text.to_string()];
    }

    let mut pieces = Vec::new();
    let mut rest = text;
    while rest.len() > budget {
        let mut end = budget;
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        // A budget narrower than the first character still takes the whole
        // character: a piece over budget beats a loop that never ends. The
        // budget can genuinely be that small — `wire_budget` subtracts a
        // server-sent hostmask from 510 and floors at one.
        if end == 0 {
            end = rest.chars().next().map_or(rest.len(), char::len_utf8);
        }
        if let Some(space) = rest[..end].rfind(' ') {
            if space * 2 > end {
                end = space;
            }
        }
        pieces.push(rest[..end].trim_end().to_string());
        rest = rest[end..].trim_start();
    }
    if !rest.is_empty() {
        pieces.push(rest.to_string());
    }
    pieces
}

/// What a nickname is made of: `\w`, and the `[]\^{}|-` RFC 2812 allows.
///
/// A match butting up against one of these is part of a longer name rather than
/// this one. `syk|away` is somebody else — the same person, but not the name
/// they are being addressed by, and the badge going loud for it was the client
/// answering a question nobody asked.
///
/// ASCII rather than Unicode alphanumerics, because the same rule is a regular
/// expression on the other side of the app (`mentionPattern` in
/// `src/store/selectors.ts`) and `\w` there is ASCII. Two implementations of one
/// rule is what `fixtures/highlight.json` exists to hold together.
fn nick_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '[' | ']' | '\\' | '^' | '{' | '}' | '|' | '-')
}

/// Whether `nick` is addressed in `text`, rather than merely a substring of a
/// longer name.
pub fn mentions(text: &str, nick: &str) -> bool {
    if nick.is_empty() {
        return false;
    }
    let text = text.to_lowercase();
    let nick = nick.to_lowercase();
    text.match_indices(&nick).any(|(index, _)| {
        let before = text[..index].chars().next_back();
        let after = text[index + nick.len()..].chars().next();
        !before.is_some_and(nick_char) && !after.is_some_and(nick_char)
    })
}

/// Whether this line is worth raising for: the reader's nickname, or one of the
/// words they added beside it.
///
/// A word is matched exactly as the nick is, which is the whole reason this
/// defers to [`mentions`] rather than doing its own search. Adding `deploy`
/// buys you the word-boundary rule and the case folding that a nickname
/// already had, and nothing else — `redeployed` is not a match, for the same
/// reason `sykk` does not mention `syk`.
pub fn raises(text: &str, nick: &str, words: &[String]) -> bool {
    mentions(text, nick) || words.iter().any(|word| mentions(text, word))
}

/// Whether this sender is one whose lines never raise the reader.
///
/// A whole-name comparison rather than [`mentions`]: the reader named somebody,
/// and `NickServ` is not `NickServ_`. Case folded without the network's
/// CASEMAPPING, because `src/store/selectors.ts` answers this same question for
/// the tint and the notification and has no casemapping to fold with — the two
/// disagreeing about who is hushed would be worse than treating `bot[m]` and
/// `bot{m}` as two names, which the reader can write both of.
///
/// Free rather than a method, so `fixtures/highlight.json` can hold both
/// languages to it the way it holds them to `raises`.
pub fn hushes(sender: &str, hushed: &[String]) -> bool {
    hushed.iter().any(|name| name.eq_ignore_ascii_case(sender))
}

fn scheme_start(text: &str, scheme_end: usize) -> Option<usize> {
    let start = text[..scheme_end]
        .char_indices()
        .rev()
        .take_while(|(_, c)| c.is_ascii_alphabetic())
        .last()
        .map(|(index, _)| index)?;
    matches!(&text[start..scheme_end], "http" | "https").then_some(start)
}

fn trim_trailing(url: &str) -> &str {
    let mut url = url.trim_end_matches(TRAILING);
    while url.ends_with(')') && url.matches('(').count() < url.matches(')').count() {
        url = &url[..url.len() - 1];
    }
    for closing in [']', '}', '>'] {
        if url.ends_with(closing) && !url.contains(opening(closing)) {
            url = &url[..url.len() - 1];
        }
    }
    url.trim_end_matches(TRAILING)
}

fn opening(closing: char) -> char {
    match closing {
        ']' => '[',
        '}' => '{',
        _ => '<',
    }
}

fn filename(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let segment = path.rsplit('/').next()?;
    (segment.contains('.') && !segment.starts_with('.')).then(|| segment.to_string())
}

/// Guessed from the extension so the UI knows whether a preview is even worth
/// offering. Nothing is fetched to confirm it.
///
/// Only what `src-tauri/src/preview.rs` can actually render, which is why AVIF
/// and SVG are absent: naming a type here that comes back as "not an image
/// ircx can show" offers the reader an action that cannot work. SVG is excluded
/// on purpose rather than unimplemented: it is a document with scripting, not a
/// bitmap.
fn mime(url: &str) -> Option<String> {
    let name = filename(url)?.to_ascii_lowercase();
    let kind = match name.rsplit('.').next()? {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return None,
    };
    Some(kind.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn urls(text: &str) -> Vec<String> {
        attachments(text).into_iter().map(|a| a.url).collect()
    }

    /// The second rule that file holds, and `isHushed` in
    /// `src/store/selectors.ts` is held to the same cases.
    #[test]
    fn the_shared_hushed_cases_hold() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/highlight.json"))
                .expect("fixtures/highlight.json does not parse");
        let cases = fixture["hushedCases"]
            .as_array()
            .expect("fixtures/highlight.json has no hushed cases");
        assert!(!cases.is_empty(), "the fixture asserts nothing");

        for case in cases {
            let sender = case["sender"].as_str().expect("a case with no sender");
            let hushed: Vec<String> = case["hushed"]
                .as_array()
                .expect("a case with no list")
                .iter()
                .map(|name| {
                    name.as_str()
                        .expect("a name that is not a string")
                        .to_owned()
                })
                .collect();
            let expected = case["hushes"].as_bool().expect("a case with no answer");

            assert_eq!(
                hushes(sender, &hushed),
                expected,
                "{}\n  sender: {sender:?}\n  hushed: {hushed:?}",
                case["why"].as_str().unwrap_or("(no reason given)"),
            );
        }
    }

    /// Every case in `fixtures/highlight.json`, which `raises` in
    /// `src/store/selectors.ts` is held to as well.
    ///
    /// A case that passes here and fails there is the divergence the file
    /// exists to catch: the badge counted a message the timeline drew nothing
    /// in, or the other way round.
    #[test]
    fn the_shared_highlight_cases_hold() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../fixtures/highlight.json"))
                .expect("fixtures/highlight.json does not parse");
        let cases = fixture["cases"]
            .as_array()
            .expect("fixtures/highlight.json has no cases");
        assert!(!cases.is_empty(), "the fixture asserts nothing");

        for case in cases {
            let text = case["text"].as_str().expect("a case with no text");
            let nick = case["nick"].as_str().expect("a case with no nick");
            let words: Vec<String> = case["words"]
                .as_array()
                .expect("a case with no words")
                .iter()
                .map(|word| {
                    word.as_str()
                        .expect("a word that is not a string")
                        .to_owned()
                })
                .collect();
            let expected = case["raises"].as_bool().expect("a case with no answer");

            assert_eq!(
                raises(text, nick, &words),
                expected,
                "{}\n  text:  {text:?}\n  nick:  {nick:?}\n  words: {words:?}",
                case["why"].as_str().unwrap_or("(no reason given)"),
            );
        }
    }

    #[test]
    fn an_action_is_a_ctcp() {
        assert_eq!(ctcp("\u{1}ACTION waves\u{1}"), Some(("ACTION", "waves")));
        assert_eq!(ctcp("\u{1}VERSION\u{1}"), Some(("VERSION", "")));
        assert_eq!(ctcp("plain text"), None);
    }

    #[test]
    fn ctcp_wraps_a_command_and_its_args() {
        assert_eq!(ctcp_wrap("VERSION", ""), "\u{1}VERSION\u{1}");
        assert_eq!(ctcp_wrap("PING", "token"), "\u{1}PING token\u{1}");
    }

    #[test]
    fn urls_are_found_and_trimmed() {
        assert_eq!(
            urls("see https://example.invalid/a.png, and (http://example.invalid/b)"),
            vec!["https://example.invalid/a.png", "http://example.invalid/b"]
        );
    }

    #[test]
    fn a_url_is_only_described_never_fetched() {
        let found = attachments("https://example.invalid/pics/cat.PNG?size=2");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].filename.as_deref(), Some("cat.PNG"));
        assert_eq!(found[0].mime.as_deref(), Some("image/png"));
        assert!(found[0].preview.is_none());
        assert!(found[0].size_bytes.is_none());
    }

    /// `mime` is what the window offers a preview on, so it names only what the
    /// previewer can render. A type it cannot is worse than none: the reader is
    /// offered a fetch whose only possible answer is that it is not an image.
    #[test]
    fn only_what_can_be_shown_is_given_a_type() {
        let typed = |url: &str| attachments(url).remove(0).mime;

        assert_eq!(
            typed("https://e.invalid/a.png").as_deref(),
            Some("image/png")
        );
        assert_eq!(
            typed("https://e.invalid/a.jpeg").as_deref(),
            Some("image/jpeg")
        );
        assert_eq!(
            typed("https://e.invalid/a.gif").as_deref(),
            Some("image/gif")
        );
        assert_eq!(
            typed("https://e.invalid/a.webp").as_deref(),
            Some("image/webp")
        );

        // SVG is a document with scripting rather than a bitmap, and the
        // previewer excludes it on purpose. AVIF is simply not implemented.
        assert_eq!(typed("https://e.invalid/a.svg"), None);
        assert_eq!(typed("https://e.invalid/a.avif"), None);
        assert_eq!(typed("https://e.invalid/an/article"), None);
    }

    #[test]
    fn other_schemes_and_bare_words_are_not_attachments() {
        assert!(urls("ftp://example.invalid/x and mailto://nobody").is_empty());
        assert!(urls("https://").is_empty());
        assert!(urls("no links here").is_empty());
    }

    #[test]
    fn the_same_link_twice_is_one_attachment() {
        assert_eq!(urls("a https://x.invalid/p b https://x.invalid/p").len(), 1);
    }

    #[test]
    fn splitting_breaks_on_a_space_and_never_mid_character() {
        let pieces = split_for_wire("aaa bbb ccc ddd", 8);
        assert_eq!(pieces, vec!["aaa bbb", "ccc ddd"]);

        let wide = "é".repeat(10);
        let pieces = split_for_wire(&wide, 7);
        assert!(pieces.iter().all(|piece| piece.len() <= 7));
        assert_eq!(pieces.concat(), wide);
    }

    #[test]
    fn a_word_longer_than_the_budget_is_cut_rather_than_dropped() {
        let pieces = split_for_wire(&"a".repeat(25), 10);
        assert_eq!(pieces, vec!["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
    }

    /// A budget narrower than the first character used to loop forever: the
    /// boundary walk reached zero, an empty piece was pushed, and `rest`
    /// never shrank. The budget is real — `wire_budget` subtracts a
    /// server-sent hostmask from the line and floors at one — so a hostile
    /// `CHGHOST` plus one multibyte keystroke froze the session for good.
    #[test]
    fn a_budget_narrower_than_a_character_takes_the_character_whole() {
        assert_eq!(split_for_wire("é", 1), vec!["é"]);
        assert_eq!(split_for_wire("éé", 1), vec!["é", "é"]);
        assert_eq!(split_for_wire("日本語", 2), vec!["日", "本", "語"]);
    }

    #[test]
    fn a_mention_needs_a_word_boundary() {
        assert!(mentions("sable: look at this", "sable"));
        assert!(mentions("ping Sable!", "sable"));
        assert!(!mentions("sables are mammals", "sable"));
        assert!(!mentions("unsable", "sable"));
    }
}
