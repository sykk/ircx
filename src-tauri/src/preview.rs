//! Turning a URL the user clicked into an `Attachment` carrying a data URI.
//!
//! Nothing here runs unless the user asked for it. The bytes are held in
//! memory, handed to the webview, and never written to disk.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ircx_ipc::{Attachment, AttachmentPreview};
use ircx_net::http::{fetch, FetchPolicy};

/// What the client can measure, which is also what it will show. SVG is absent
/// deliberately: it is a document with scripting, not a bitmap, and it has no
/// dimensions to read out of a header.
const ACCEPT: &str = "image/png, image/jpeg, image/gif, image/webp";

pub async fn load(url: &str) -> Result<Attachment, String> {
    let policy = FetchPolicy {
        accept: ACCEPT.to_owned(),
        ..FetchPolicy::default()
    };
    let fetched = fetch(url, &policy)
        .await
        .map_err(|error| error.to_string())?;
    build(&fetched.url, fetched.content_type.as_deref(), &fetched.body)
}

/// The declared content type only gets a reply rejected early; what goes into
/// the data URI is the type the bytes actually are. A server that labels HTML
/// as a PNG does not get to put HTML in an `<img>`, and the size cap in
/// `FetchPolicy` is what bounds a server that lies the other way.
fn build(url: &str, declared: Option<&str>, body: &[u8]) -> Result<Attachment, String> {
    if let Some(declared) = declared {
        let kind = declared.split(';').next().unwrap_or(declared).trim();
        if !kind.eq_ignore_ascii_case("application/octet-stream")
            && !kind.to_ascii_lowercase().starts_with("image/")
        {
            return Err(format!(
                "{url} is {kind}, not an image — open it in your browser"
            ));
        }
    }

    let format = Format::sniff(body).ok_or_else(|| {
        format!("{url} is not an image ircx can show — it previews PNG, JPEG, GIF and WebP")
    })?;
    let (width, height) = format.dimensions(body).ok_or_else(|| {
        format!(
            "{url} is a {} ircx could not measure — it may be truncated",
            format.mime()
        )
    })?;

    Ok(Attachment {
        url: url.to_owned(),
        filename: filename_of(url),
        mime: Some(format.mime().to_owned()),
        size_bytes: Some(body.len() as u64),
        preview: Some(AttachmentPreview {
            data_uri: format!("data:{};base64,{}", format.mime(), STANDARD.encode(body)),
            width,
            height,
        }),
    })
}

fn filename_of(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let name = path.rsplit('/').next().unwrap_or_default();
    (!name.is_empty()).then(|| name.to_owned())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Png,
    Jpeg,
    Gif,
    WebP,
}

impl Format {
    fn sniff(body: &[u8]) -> Option<Self> {
        if body.starts_with(b"\x89PNG\r\n\x1a\n") {
            Some(Self::Png)
        } else if body.starts_with(&[0xff, 0xd8, 0xff]) {
            Some(Self::Jpeg)
        } else if body.starts_with(b"GIF87a") || body.starts_with(b"GIF89a") {
            Some(Self::Gif)
        } else if body.starts_with(b"RIFF") && body.get(8..12) == Some(b"WEBP") {
            Some(Self::WebP)
        } else {
            None
        }
    }

    fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::WebP => "image/webp",
        }
    }

    fn dimensions(self, body: &[u8]) -> Option<(u32, u32)> {
        match self {
            Self::Png => png_dimensions(body),
            Self::Jpeg => jpeg_dimensions(body),
            Self::Gif => gif_dimensions(body),
            Self::WebP => webp_dimensions(body),
        }
    }
}

fn be16(bytes: &[u8], at: usize) -> Option<u32> {
    let pair: [u8; 2] = bytes.get(at..at + 2)?.try_into().ok()?;
    Some(u16::from_be_bytes(pair) as u32)
}

fn le16(bytes: &[u8], at: usize) -> Option<u32> {
    let pair: [u8; 2] = bytes.get(at..at + 2)?.try_into().ok()?;
    Some(u16::from_le_bytes(pair) as u32)
}

fn be32(bytes: &[u8], at: usize) -> Option<u32> {
    let quad: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_be_bytes(quad))
}

fn le32(bytes: &[u8], at: usize) -> Option<u32> {
    let quad: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(quad))
}

/// IHDR is required to be the first chunk, so width and height sit at fixed
/// offsets past the signature.
fn png_dimensions(body: &[u8]) -> Option<(u32, u32)> {
    if body.get(12..16)? != b"IHDR" {
        return None;
    }
    Some((be32(body, 16)?, be32(body, 20)?))
}

fn gif_dimensions(body: &[u8]) -> Option<(u32, u32)> {
    Some((le16(body, 6)?, le16(body, 8)?))
}

/// Walks the marker segments to the first frame header. The dimensions are not
/// in the JFIF header, only in whichever SOF the encoder chose.
fn jpeg_dimensions(body: &[u8]) -> Option<(u32, u32)> {
    let mut at = 2;
    loop {
        // Segments may be padded with any number of 0xff fill bytes.
        while body.get(at) == Some(&0xff) && body.get(at + 1) == Some(&0xff) {
            at += 1;
        }
        if *body.get(at)? != 0xff {
            return None;
        }
        let marker = *body.get(at + 1)?;
        match marker {
            // Standalone markers: TEM, RSTn, SOI, and the padding-only 0x00.
            0x00 | 0x01 | 0xd0..=0xd8 => at += 2,
            // SOF0 through SOF15, minus DHT, JPG and DAC which share the range.
            0xc0..=0xcf if !matches!(marker, 0xc4 | 0xc8 | 0xcc) => {
                return Some((be16(body, at + 7)?, be16(body, at + 5)?));
            }
            // Start of scan: entropy-coded data follows and no SOF is coming.
            0xda | 0xd9 => return None,
            _ => at += 2 + be16(body, at + 2)? as usize,
        }
    }
}

fn webp_dimensions(body: &[u8]) -> Option<(u32, u32)> {
    match body.get(12..16)? {
        b"VP8 " => {
            // The keyframe start code sits between the frame tag and the size.
            if body.get(23..26)? != [0x9d, 0x01, 0x2a] {
                return None;
            }
            Some((le16(body, 26)? & 0x3fff, le16(body, 28)? & 0x3fff))
        }
        b"VP8L" => {
            if *body.get(20)? != 0x2f {
                return None;
            }
            let bits = le32(body, 21)?;
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        // The extended header stores canvas size as two 24-bit little-endian
        // values, each one less than the real dimension.
        b"VP8X" => {
            let width = le16(body, 24)? | (*body.get(26)? as u32) << 16;
            let height = le16(body, 27)? | (*body.get(29)? as u32) << 16;
            Some((width + 1, height + 1))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut body = b"\x89PNG\r\n\x1a\n".to_vec();
        body.extend_from_slice(&13u32.to_be_bytes());
        body.extend_from_slice(b"IHDR");
        body.extend_from_slice(&width.to_be_bytes());
        body.extend_from_slice(&height.to_be_bytes());
        body.extend_from_slice(&[8, 6, 0, 0, 0]);
        body
    }

    fn jpeg(width: u16, height: u16, with_app0: bool) -> Vec<u8> {
        let mut body = vec![0xff, 0xd8];
        if with_app0 {
            body.extend_from_slice(&[0xff, 0xe0, 0x00, 0x10]);
            body.extend_from_slice(b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0");
        }
        body.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        body.extend_from_slice(&height.to_be_bytes());
        body.extend_from_slice(&width.to_be_bytes());
        body.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        body
    }

    fn gif(width: u16, height: u16) -> Vec<u8> {
        let mut body = b"GIF89a".to_vec();
        body.extend_from_slice(&width.to_le_bytes());
        body.extend_from_slice(&height.to_le_bytes());
        body.extend_from_slice(&[0, 0, 0]);
        body
    }

    fn webp(chunk: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut body = b"RIFF".to_vec();
        body.extend_from_slice(&((payload.len() + 12) as u32).to_le_bytes());
        body.extend_from_slice(b"WEBP");
        body.extend_from_slice(chunk);
        body.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        body.extend_from_slice(payload);
        body
    }

    #[test]
    fn sniffs_the_four_formats_and_nothing_else() {
        assert_eq!(Format::sniff(&png(1, 1)), Some(Format::Png));
        assert_eq!(Format::sniff(&jpeg(1, 1, false)), Some(Format::Jpeg));
        assert_eq!(Format::sniff(&gif(1, 1)), Some(Format::Gif));
        assert_eq!(Format::sniff(&webp(b"VP8L", &[])), Some(Format::WebP));
        assert_eq!(Format::sniff(b"<!doctype html>"), None);
        assert_eq!(
            Format::sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
            None
        );
        assert_eq!(Format::sniff(b""), None);
    }

    #[test]
    fn reads_png_dimensions() {
        assert_eq!(png_dimensions(&png(1920, 1080)), Some((1920, 1080)));
    }

    #[test]
    fn reads_gif_dimensions() {
        assert_eq!(gif_dimensions(&gif(320, 240)), Some((320, 240)));
    }

    #[test]
    fn reads_jpeg_dimensions_past_a_leading_segment() {
        assert_eq!(jpeg_dimensions(&jpeg(800, 600, false)), Some((800, 600)));
        assert_eq!(jpeg_dimensions(&jpeg(800, 600, true)), Some((800, 600)));
    }

    #[test]
    fn gives_up_on_a_jpeg_whose_scan_starts_before_any_frame_header() {
        let body = vec![0xff, 0xd8, 0xff, 0xda, 0x00, 0x02];
        assert_eq!(jpeg_dimensions(&body), None);
    }

    #[test]
    fn reads_the_three_webp_layouts() {
        let mut lossy = vec![0u8; 10];
        lossy[3..6].copy_from_slice(&[0x9d, 0x01, 0x2a]);
        lossy[6..8].copy_from_slice(&640u16.to_le_bytes());
        lossy[8..10].copy_from_slice(&480u16.to_le_bytes());
        assert_eq!(webp_dimensions(&webp(b"VP8 ", &lossy)), Some((640, 480)));

        let bits: u32 = (639) | (479 << 14);
        let mut lossless = vec![0x2f];
        lossless.extend_from_slice(&bits.to_le_bytes());
        assert_eq!(webp_dimensions(&webp(b"VP8L", &lossless)), Some((640, 480)));

        let mut extended = vec![0u8; 10];
        extended[4..7].copy_from_slice(&639u32.to_le_bytes()[..3]);
        extended[7..10].copy_from_slice(&479u32.to_le_bytes()[..3]);
        assert_eq!(webp_dimensions(&webp(b"VP8X", &extended)), Some((640, 480)));
    }

    #[test]
    fn refuses_a_truncated_header_without_panicking() {
        for format in [
            png(4, 4),
            jpeg(4, 4, true),
            gif(4, 4),
            webp(b"VP8L", &[0x2f, 0, 0, 0, 0]),
        ] {
            for cut in 0..format.len() {
                let short = &format[..cut];
                if let Some(sniffed) = Format::sniff(short) {
                    let _ = sniffed.dimensions(short);
                }
            }
        }
    }

    #[test]
    fn builds_a_data_uri_from_the_sniffed_type() {
        let attachment = build("https://files.example/a.png", Some("image/png"), &png(4, 2))
            .expect("a png builds");
        let preview = attachment.preview.expect("preview");
        assert_eq!((preview.width, preview.height), (4, 2));
        assert!(preview
            .data_uri
            .starts_with("data:image/png;base64,iVBORw0KGgo"));
        assert_eq!(attachment.mime.as_deref(), Some("image/png"));
        assert_eq!(attachment.filename.as_deref(), Some("a.png"));
        assert_eq!(attachment.size_bytes, Some(png(4, 2).len() as u64));
    }

    #[test]
    fn trusts_the_bytes_over_a_wrong_content_type() {
        let attachment = build("https://files.example/a.png", Some("image/gif"), &png(4, 2))
            .expect("a png labelled as a gif is still a png");
        assert_eq!(attachment.mime.as_deref(), Some("image/png"));
    }

    #[test]
    fn refuses_a_reply_that_is_not_an_image() {
        let error = build("https://files.example/a.png", Some("image/png"), b"<html>")
            .expect_err("html is not an image");
        assert!(error.contains("PNG, JPEG, GIF and WebP"), "{error}");

        let error = build(
            "https://files.example/a",
            Some("text/html; charset=utf-8"),
            &png(4, 2),
        )
        .expect_err("a declared document is refused before sniffing");
        assert!(error.contains("text/html"), "{error}");
    }

    #[test]
    fn takes_a_filename_from_the_path_only() {
        assert_eq!(
            filename_of("https://files.example/a/b.png?v=2#x").as_deref(),
            Some("b.png")
        );
        assert_eq!(filename_of("https://files.example/"), None);
    }
}
