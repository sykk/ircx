//! AWS Signature Version 4, enough of it to store one object.
//!
//! Not an SDK. It signs a single request whose body is already in memory, for
//! the one operation this client performs against S3-compatible storage, and it
//! knows nothing about sessions, chunked uploads or temporary credentials.
//!
//! The reason it exists rather than a crate: the whole of it is a hash chain
//! over strings, `ring` is already in the tree for the object name, and the
//! alternative pulls an HTTP stack and an async runtime this crate has decided
//! twice already not to have.
//!
//! `signed()` is checked against the example AWS publishes for a single-chunk
//! `PUT`, which is the same operation with the same shape.

use ring::digest;
use ring::hmac;
use time::OffsetDateTime;

/// What the provider issued. The secret is read at the moment of the upload
/// and never held anywhere it could be shown.
pub struct Credentials<'a> {
    pub access_key_id: &'a str,
    pub secret: &'a str,
    pub region: &'a str,
}

/// The service name in the credential scope. Every S3-compatible provider uses
/// S3's, whatever they call themselves.
const SERVICE: &str = "s3";
const ALGORITHM: &str = "AWS4-HMAC-SHA256";

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sha256_hex(body: &[u8]) -> String {
    hex(digest::digest(&digest::SHA256, body).as_ref())
}

/// The headers to add to the request, in the order they should be sent.
///
/// `host` and `path` come from the transport rather than from parsing the URL
/// again — a signature covering a different host or path than the one sent is
/// rejected with nothing to say why.
///
/// `extra` is every other header that will be sent and should be covered.
/// Anything sent but not listed here is unsigned, which S3 allows for
/// everything except its own `x-amz-` headers.
pub fn signed(
    method: &str,
    host: &str,
    path: &str,
    payload_sha256: &str,
    extra: &[(String, String)],
    credentials: &Credentials,
    at: OffsetDateTime,
) -> Vec<(String, String)> {
    let stamp = timestamp(at);
    let day = &stamp[..8];

    // Everything that will be covered, lowercased and sorted, which is what the
    // canonical form is: the same request written one way whoever sends it.
    let mut headers: Vec<(String, String)> = extra
        .iter()
        .map(|(name, value)| (name.to_lowercase(), value.trim().to_owned()))
        .collect();
    headers.push(("host".into(), host.to_owned()));
    headers.push(("x-amz-content-sha256".into(), payload_sha256.to_owned()));
    headers.push(("x-amz-date".into(), stamp.clone()));
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let signed_headers = headers
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();

    // A query string, when one is sent, is signed too — the bucket-policy PUT
    // in the MinIO walk sends `?policy=`.
    let (path, query) = match path.split_once('?') {
        Some((path, query)) => (path, query),
        None => (path, ""),
    };
    let canonical_request = format!(
        "{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_sha256}"
    );

    let scope = format!("{day}/{}/{SERVICE}/aws4_request", credentials.region);
    let to_sign = format!(
        "{ALGORITHM}\n{stamp}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let signature = hex(hmac::sign(&signing_key(credentials, day), to_sign.as_bytes()).as_ref());
    let authorization = format!(
        "{ALGORITHM} Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
        credentials.access_key_id
    );

    vec![
        ("x-amz-content-sha256".into(), payload_sha256.to_owned()),
        ("x-amz-date".into(), stamp),
        ("Authorization".into(), authorization),
    ]
}

/// `YYYYMMDDTHHMMSSZ`, which is the only format the signature accepts.
fn timestamp(at: OffsetDateTime) -> String {
    let at = at.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
    )
}

/// The key is the secret walked through date, region and service, so a stolen
/// signature is good for one day in one region for one service and nothing else.
fn signing_key(credentials: &Credentials, day: &str) -> hmac::Key {
    let start = hmac::Key::new(
        hmac::HMAC_SHA256,
        format!("AWS4{}", credentials.secret).as_bytes(),
    );
    let date = hmac::sign(&start, day.as_bytes());
    let region = hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, date.as_ref()),
        credentials.region.as_bytes(),
    );
    let service = hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, region.as_ref()),
        SERVICE.as_bytes(),
    );
    let signing = hmac::sign(
        &hmac::Key::new(hmac::HMAC_SHA256, service.as_ref()),
        b"aws4_request",
    );
    hmac::Key::new(hmac::HMAC_SHA256, signing.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Amazon's own worked example for storing an object in a single chunk,
    /// from "Signature Calculations for the Authorization Header". Their
    /// credentials, their bucket, their clock, their answer.
    ///
    /// Worth having as the whole of the conformance evidence: every part of
    /// this is a string transformation with no failure mode short of a wrong
    /// signature, and a wrong signature is a 403 with nothing in it to debug.
    fn aws_example() -> (String, Vec<(String, String)>) {
        let body = b"Welcome to Amazon S3.";
        let payload = sha256_hex(body);
        assert_eq!(
            payload, "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
            "the example's own payload hash, so a failure below is the signature"
        );

        let extra = vec![
            (
                "Date".to_owned(),
                "Fri, 24 May 2013 00:00:00 GMT".to_owned(),
            ),
            (
                "x-amz-storage-class".to_owned(),
                "REDUCED_REDUNDANCY".to_owned(),
            ),
        ];
        let at = OffsetDateTime::from_unix_timestamp(1_369_353_600).expect("2013-05-24T00:00:00Z");

        let headers = signed(
            "PUT",
            "examplebucket.s3.amazonaws.com",
            "/test%24file.text",
            &payload,
            &extra,
            &Credentials {
                access_key_id: "AKIAIOSFODNN7EXAMPLE",
                secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                region: "us-east-1",
            },
            at,
        );
        (payload, headers)
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
        headers
            .iter()
            .find(|(held, _)| held == name)
            .map(|(_, value)| value.as_str())
            .unwrap_or_else(|| panic!("no {name} header"))
    }

    #[test]
    fn matches_the_signature_aws_publishes() {
        let (_, headers) = aws_example();

        assert_eq!(
            header(&headers, "Authorization"),
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, \
             Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    #[test]
    fn sends_the_date_and_the_payload_hash_it_signed() {
        let (payload, headers) = aws_example();

        assert_eq!(header(&headers, "x-amz-date"), "20130524T000000Z");
        assert_eq!(header(&headers, "x-amz-content-sha256"), payload);
    }

    /// Every part of the key is walked in, so a signature is good for one day,
    /// one region and one service. Changing any of them changes the answer.
    #[test]
    fn a_signature_is_bound_to_its_day_and_region() {
        let payload = sha256_hex(b"");
        let sign_at = |region: &str, unix: i64| {
            let headers = signed(
                "PUT",
                "bucket.example.com",
                "/object",
                &payload,
                &[],
                &Credentials {
                    access_key_id: "key",
                    secret: "secret",
                    region,
                },
                OffsetDateTime::from_unix_timestamp(unix).expect("a time"),
            );
            header(&headers, "Authorization").to_owned()
        };

        let first = sign_at("us-east-1", 1_369_353_600);
        assert_ne!(
            first,
            sign_at("eu-west-1", 1_369_353_600),
            "region is in it"
        );
        assert_ne!(first, sign_at("us-east-1", 1_369_440_000), "so is the day");
    }

    /// A provider on a port signs the host it is sent, port and all.
    #[test]
    fn the_host_it_signs_is_the_host_it_is_given() {
        let payload = sha256_hex(b"");
        let creds = Credentials {
            access_key_id: "key",
            secret: "secret",
            region: "us-east-1",
        };
        let at = OffsetDateTime::from_unix_timestamp(1_369_353_600).expect("a time");

        let plain = signed("PUT", "s3.example.com", "/o", &payload, &[], &creds, at);
        let ported = signed(
            "PUT",
            "s3.example.com:9000",
            "/o",
            &payload,
            &[],
            &creds,
            at,
        );

        assert_ne!(
            header(&plain, "Authorization"),
            header(&ported, "Authorization")
        );
    }

    /// The canonical form sorts and lowercases, so the order a caller happens
    /// to build its headers in cannot change the signature.
    #[test]
    fn the_order_headers_arrive_in_does_not_matter() {
        let payload = sha256_hex(b"");
        let creds = Credentials {
            access_key_id: "key",
            secret: "secret",
            region: "us-east-1",
        };
        let at = OffsetDateTime::from_unix_timestamp(1_369_353_600).expect("a time");
        let one = [
            ("Content-Type".to_owned(), "image/png".to_owned()),
            ("Date".to_owned(), "whenever".to_owned()),
        ];
        let other = [
            ("date".to_owned(), "whenever".to_owned()),
            ("content-type".to_owned(), "image/png".to_owned()),
        ];

        assert_eq!(
            header(
                &signed("PUT", "h", "/o", &payload, &one, &creds, at),
                "Authorization"
            ),
            header(
                &signed("PUT", "h", "/o", &payload, &other, &creds, at),
                "Authorization"
            ),
        );
    }
}
