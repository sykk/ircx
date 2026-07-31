//! Sending a file to the configured provider and getting a link back.
//!
//! The window reads nothing and sends nothing: it hands over a path the user
//! chose and receives the address the file now has. What goes into the
//! conversation is that address, typed into the composer like any other line —
//! which is what "fall back to a normal link in traditional clients" means when
//! there is no attachment protocol to fall back from.

use std::path::Path;

use ircx_ipc::{UploadMethod, UploadProvider};
use ircx_net::http::{upload, UploadMethod as NetMethod, UploadPolicy};

use crate::state::App;

/// The largest file this will read into memory before sending it.
///
/// The upload is one buffer rather than a stream, which is the simple thing and
/// costs a copy of the file. A cap is what keeps that honest: a user who drags
/// a disc image should be told no, not watched while the client tries.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Random bytes in front of the file's own name.
///
/// Two people uploading `screenshot.png` must not overwrite each other, and a
/// provider addressed by path has no other way to keep them apart.
const PREFIX_BYTES: usize = 8;

/// What the provider is told the file is.
///
/// Short on purpose: these are the types the client itself previews, and
/// claiming a type for anything else would be guessing on the user's behalf
/// about a file it cannot read. Everything else is bytes, which is true.
fn content_type(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

/// The name the file is stored under: a random prefix, then as much of the
/// user's own name as is safe to repeat back.
///
/// Path separators and control characters go, because this is interpolated into
/// a URL the client then requests. `..` would otherwise let a file name choose
/// where on the provider it lands.
pub fn object_name(file_name: &str, random: &[u8]) -> String {
    let prefix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let safe: String = file_name
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' | '_' => c,
            _ => '-',
        })
        .collect();
    // A leading dot would make a hidden file of it on some providers, and a
    // name that was entirely unsafe characters would leave nothing at all.
    let safe = safe.trim_matches(['.', '-']);
    let safe: String = safe.chars().take(64).collect();
    match safe.is_empty() {
        true => prefix,
        false => format!("{prefix}-{safe}"),
    }
}

/// Where the file is sent. An endpoint naming `{name}` addresses the object by
/// path; one that does not is a host that names the object itself.
fn endpoint_for(endpoint: &str, name: &str) -> String {
    endpoint.replace("{name}", name)
}

/// The address the file now has.
///
/// A provider that answered with a URL is believed — that is the whole of what
/// a POST host's reply is for. One that answered with nothing has stored the
/// object where it was put, so the request URL is the answer.
pub fn link_from(reply: &str, request_url: &str) -> String {
    let answer = reply.trim();
    match answer.starts_with("https://") || answer.starts_with("http://") {
        true => answer.to_owned(),
        false => request_url.to_owned(),
    }
}

fn net_method(method: UploadMethod) -> NetMethod {
    match method {
        UploadMethod::Put => NetMethod::Put,
        UploadMethod::Post => NetMethod::Post,
    }
}

/// Reads `path` and sends it, returning the link.
///
/// Every error is a sentence for whoever has to fix it: the file, the provider
/// and the size are all things the user chose and can change.
pub async fn send_file(app: &App, path: &str) -> Result<String, String> {
    let Some(provider) = app.store().upload_provider().map_err(|e| e.to_string())? else {
        return Err(
            "No upload provider is configured. Set one from the command palette, or paste a \
             link you already have."
                .into(),
        );
    };

    let file = Path::new(path);
    let name = file
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("{path} has no file name ircx can read"))?
        .to_owned();

    let size = tokio::fs::metadata(file)
        .await
        .map_err(|error| format!("{name} could not be read: {error}"))?
        .len();
    if size > MAX_BYTES {
        return Err(format!(
            "{name} is {} MB, and ircx uploads files up to {} MB",
            size / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }

    let bytes = tokio::fs::read(file)
        .await
        .map_err(|error| format!("{name} could not be read: {error}"))?;

    let mut random = [0u8; PREFIX_BYTES];
    getrandom(&mut random)?;
    let url = endpoint_for(&provider.endpoint, &object_name(&name, &random));

    let answer = upload(&url, &bytes, &policy(&provider, &name, app)?)
        .await
        .map_err(|error| error.to_string())?;

    Ok(link_from(&answer.body, &url))
}

fn policy(provider: &UploadProvider, name: &str, app: &App) -> Result<UploadPolicy, String> {
    let mut headers = Vec::new();
    if let Some(header) = provider.auth_header.as_deref().filter(|h| !h.is_empty()) {
        // Read at the moment of the upload rather than held anywhere it could
        // be shown, which is the whole reason it is write-only.
        let token = app.store().upload_token().map_err(|e| e.to_string())?;
        match token {
            Some(token) => headers.push((header.to_owned(), token)),
            None => {
                return Err(format!(
                    "The provider expects a {header} header and no token is saved. Set one from \
                     the command palette."
                ))
            }
        }
    }
    Ok(UploadPolicy {
        method: net_method(provider.method),
        content_type: content_type(name).to_owned(),
        headers,
        ..UploadPolicy::default()
    })
}

fn getrandom(into: &mut [u8]) -> Result<(), String> {
    use ring::rand::SecureRandom;
    ring::rand::SystemRandom::new()
        .fill(into)
        .map_err(|_| "This computer would not give ircx random bytes to name the file with".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The name is interpolated into a URL the client then requests, so a file
    /// called `../../etc/passwd` must not choose where on the provider it
    /// lands.
    #[test]
    fn a_name_cannot_climb_out_of_where_it_was_put() {
        let name = object_name("../../etc/passwd", &[0xab, 0xcd]);
        assert!(!name.contains('/'), "{name}");
        assert!(!name.contains(".."), "{name}");
        assert!(name.starts_with("abcd-"), "{name}");
    }

    #[test]
    fn the_users_own_name_survives_where_it_is_safe() {
        assert_eq!(
            object_name("holiday-photo.png", &[0x01]),
            "01-holiday-photo.png"
        );
    }

    /// Two people uploading `screenshot.png` must not overwrite each other.
    #[test]
    fn the_same_name_twice_is_two_objects() {
        assert_ne!(
            object_name("screenshot.png", &[0x01, 0x02]),
            object_name("screenshot.png", &[0x03, 0x04])
        );
    }

    #[test]
    fn a_name_that_was_entirely_unsafe_still_leaves_something() {
        let name = object_name("///", &[0xff]);
        assert_eq!(name, "ff");
    }

    #[test]
    fn a_long_name_is_cut_rather_than_sent_whole() {
        let name = object_name(&"a".repeat(400), &[0x00]);
        assert!(name.len() <= 3 + 64, "{name}");
    }

    #[test]
    fn an_endpoint_naming_the_object_gets_the_name() {
        assert_eq!(
            endpoint_for("https://files.example.com/{name}", "01-a.png"),
            "https://files.example.com/01-a.png"
        );
    }

    /// A host that names the object itself takes the file at a fixed address.
    #[test]
    fn an_endpoint_without_a_name_is_used_as_it_stands() {
        assert_eq!(endpoint_for("https://0x0.st", "01-a.png"), "https://0x0.st");
    }

    #[test]
    fn a_provider_that_answered_with_a_url_is_believed() {
        assert_eq!(
            link_from(
                "  https://files.example.com/x.png\n",
                "https://put.example.com/y"
            ),
            "https://files.example.com/x.png"
        );
    }

    /// A `204` says the object is where it was put, so the request URL is the
    /// answer — which is the ordinary case for storage addressed by path.
    #[test]
    fn a_provider_that_answered_with_nothing_leaves_the_link_where_it_put_it() {
        assert_eq!(
            link_from("", "https://files.example.com/01-a.png"),
            "https://files.example.com/01-a.png"
        );
    }

    /// A body that is not a URL is a message, not an address — an error page,
    /// or a receipt. Treating it as a link would put nonsense in the channel.
    #[test]
    fn a_reply_that_is_not_a_url_is_not_treated_as_one() {
        assert_eq!(
            link_from("stored ok", "https://files.example.com/01-a.png"),
            "https://files.example.com/01-a.png"
        );
    }

    #[test]
    fn the_type_is_claimed_only_for_what_the_client_itself_previews() {
        assert_eq!(content_type("a.PNG"), "image/png");
        assert_eq!(content_type("a.jpeg"), "image/jpeg");
        assert_eq!(content_type("a.tar.gz"), "application/octet-stream");
        assert_eq!(content_type("noextension"), "application/octet-stream");
    }
}
