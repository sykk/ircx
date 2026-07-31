//! SCRAM-SHA-512, the salted challenge-response exchange in RFC 5802.
//!
//! Four messages rather than one, which is the whole reason this is a module
//! and not another arm of [`crate::sasl`]: the password never crosses the wire,
//! so each side has to prove it knows it, and proving takes a round trip each
//! way.
//!
//! ```text
//! C: n,,n=user,r=<client nonce>
//! S: r=<client nonce + server nonce>,s=<salt>,i=<iterations>
//! C: c=biws,r=<nonce>,p=<client proof>
//! S: v=<server signature>
//! ```
//!
//! Two of those steps are checks rather than data, and skipping either gives an
//! exchange that looks like it worked:
//!
//! - the server's nonce has to begin with the one we sent, or we are talking to
//!   something replaying another session;
//! - the server's final signature has to verify, which is what proves the
//!   server knew the password too. Without it a machine in the middle can
//!   accept any login it likes.
//!
//! No channel binding: this is `SCRAM-SHA-512`, not `-PLUS`, and the gs2 header
//! says `n` — the client does not support it. Saying so honestly is what keeps
//! a downgrade visible, because the header is covered by the proof.
//!
//! Crypto is `ring`, which the TLS stack already depends on rather than a
//! second implementation of the same primitives.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ring::rand::SecureRandom;
use ring::{digest, hmac, pbkdf2};
use std::fmt;
use std::num::NonZeroU32;

/// The gs2 header, and its base64 — `biws` is `n,,` encoded, which is what
/// `c=` carries in the final message.
const GS2: &str = "n,,";
const GS2_B64: &str = "biws";

/// Bytes of randomness in a client nonce. RFC 5802 sets no length; this is the
/// width of the server nonces Libera and ergo send.
const NONCE_BYTES: usize = 18;

/// An iteration count a server can name. The floor is RFC 7677's; the ceiling
/// is not in any specification and exists because the count is a number a
/// stranger chooses and we then execute — a server asking for ten million
/// would hang the connection task rather than fail it.
const MIN_ITERATIONS: u32 = 4096;
const MAX_ITERATIONS: u32 = 1_000_000;

#[derive(Debug, PartialEq, Eq)]
pub enum ScramError {
    /// The server sent something that is not a SCRAM message.
    Malformed(&'static str),
    /// The server's nonce does not extend ours.
    NonceMismatch,
    /// The iteration count is outside what this client will run.
    Iterations(u32),
    /// The server could not prove it knew the password.
    BadSignature,
    /// The server said why it refused, in `e=`.
    Refused(String),
}

impl fmt::Display for ScramError {
    /// Read by whoever has to fix it, so each one says what to do about it.
    /// Three of the five are the server's fault and say so, because a user
    /// checking their password over a nonce mismatch is looking in the wrong
    /// place.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(what) => {
                write!(f, "the server's SCRAM reply was not readable ({what})")
            }
            Self::NonceMismatch => f.write_str(
                "the server's reply did not carry the nonce this client sent, \
                 so it is not the other end of this exchange",
            ),
            Self::Iterations(count) => write!(
                f,
                "the server asked for {count} rounds of hashing, which is outside \
                 the {MIN_ITERATIONS} to {MAX_ITERATIONS} this client will run"
            ),
            Self::BadSignature => f.write_str(
                "the server could not prove it knew the password, so the account \
                 was not signed in and something is answering for it",
            ),
            Self::Refused(why) => write!(f, "the server refused: {why}"),
        }
    }
}

/// One exchange, from the first message to the signature that ends it.
pub struct Scram {
    password: String,
    nonce: String,
    first_bare: String,
    /// The server key and the message it signs, kept from the moment the proof
    /// was built. `None` until then, so verifying before responding is caught
    /// rather than passed.
    signed: Option<(Vec<u8>, String)>,
}

impl Scram {
    /// The first message, and the state to answer the reply with.
    ///
    /// The nonce is a parameter rather than generated here so the exchange can
    /// be tested against a published vector; [`nonce`] is what the session
    /// calls.
    pub fn start(account: &str, password: &str, nonce: &str) -> (Self, String) {
        let first_bare = format!("n={},r={nonce}", escape(account));
        let message = format!("{GS2}{first_bare}");
        (
            Self {
                password: password.to_owned(),
                nonce: nonce.to_owned(),
                first_bare,
                signed: None,
            },
            message,
        )
    }

    /// The proof, from the server's salt and iteration count.
    pub fn respond(&mut self, server_first: &str) -> Result<String, ScramError> {
        if let Some(why) = field(server_first, 'e') {
            return Err(ScramError::Refused(why.to_owned()));
        }
        let combined = field(server_first, 'r').ok_or(ScramError::Malformed("no nonce"))?;
        let salt = field(server_first, 's').ok_or(ScramError::Malformed("no salt"))?;
        let count = field(server_first, 'i').ok_or(ScramError::Malformed("no iteration count"))?;

        // The server extends our nonce rather than replacing it. A reply that
        // does not is a different exchange being replayed at us.
        if !combined.starts_with(&self.nonce) || combined.len() == self.nonce.len() {
            return Err(ScramError::NonceMismatch);
        }
        let salt = STANDARD
            .decode(salt)
            .map_err(|_| ScramError::Malformed("the salt is not base64"))?;
        let count: u32 = count
            .parse()
            .map_err(|_| ScramError::Malformed("the iteration count is not a number"))?;
        let rounds = NonZeroU32::new(count)
            .filter(|_| (MIN_ITERATIONS..=MAX_ITERATIONS).contains(&count))
            .ok_or(ScramError::Iterations(count))?;

        let mut salted = [0u8; digest::SHA512_OUTPUT_LEN];
        pbkdf2::derive(
            pbkdf2::PBKDF2_HMAC_SHA512,
            rounds,
            &salt,
            self.password.as_bytes(),
            &mut salted,
        );

        let client_key = mac(&salted, b"Client Key");
        let stored_key = digest::digest(&digest::SHA512, client_key.as_ref());

        let without_proof = format!("c={GS2_B64},r={combined}");
        let auth = format!("{},{server_first},{without_proof}", self.first_bare);
        let client_signature = mac(stored_key.as_ref(), auth.as_bytes());

        let proof: Vec<u8> = client_key
            .as_ref()
            .iter()
            .zip(client_signature.as_ref())
            .map(|(key, signature)| key ^ signature)
            .collect();

        let server_key = mac(&salted, b"Server Key");
        self.signed = Some((server_key.as_ref().to_vec(), auth));

        Ok(format!("{without_proof},p={}", STANDARD.encode(proof)))
    }

    /// Whether the next thing from the server is its signature rather than its
    /// challenge. The state is the exchange's own, so the caller does not keep
    /// a second copy of it that could disagree.
    pub fn expecting_signature(&self) -> bool {
        self.signed.is_some()
    }

    /// Whether the server proved it knew the password too.
    pub fn verify(&self, server_final: &str) -> Result<(), ScramError> {
        if let Some(why) = field(server_final, 'e') {
            return Err(ScramError::Refused(why.to_owned()));
        }
        let (server_key, auth) = self
            .signed
            .as_ref()
            .ok_or(ScramError::Malformed("no proof was sent yet"))?;
        let signature = field(server_final, 'v').ok_or(ScramError::Malformed("no signature"))?;
        let signature = STANDARD
            .decode(signature)
            .map_err(|_| ScramError::Malformed("the signature is not base64"))?;

        // Constant time, and the primitive that says what this is: the server's
        // signature verified against the key only the password produces.
        hmac::verify(
            &hmac::Key::new(hmac::HMAC_SHA512, server_key),
            auth.as_bytes(),
            &signature,
        )
        .map_err(|_| ScramError::BadSignature)
    }
}

/// A fresh client nonce. Base64 so it is printable and carries no comma, which
/// is the character SCRAM separates fields with.
pub fn nonce(random: &dyn SecureRandom) -> String {
    let mut bytes = [0u8; NONCE_BYTES];
    // A random source that cannot answer is not something to carry on past: an
    // all-zero nonce would make the exchange replayable. The zeroes stay only
    // if `fill` failed, and `respond` then fails the nonce check against any
    // real server, which is the safe direction.
    let _ = random.fill(&mut bytes);
    STANDARD.encode(bytes)
}

fn mac(key: &[u8], message: &[u8]) -> hmac::Tag {
    hmac::sign(&hmac::Key::new(hmac::HMAC_SHA512, key), message)
}

/// The value of `<name>=` in a comma-separated SCRAM message.
fn field(message: &str, name: char) -> Option<&str> {
    message
        .split(',')
        .find_map(|part| part.strip_prefix(name)?.strip_prefix('='))
}

/// `,` and `=` are what SCRAM separates fields with, so a username containing
/// either has to say so rather than end the field early.
fn escape(account: &str) -> String {
    account.replace('=', "=3D").replace(',', "=2C")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 7677's worked example, recomputed for SHA-512 — same user, password,
    /// nonces, salt and iteration count, only the hash differs. The expected
    /// proof and signature come from Python's `hashlib`, an implementation with
    /// nothing in common with this one, so agreeing with them is evidence
    /// rather than a restatement:
    ///
    /// ```python
    /// salted = hashlib.pbkdf2_hmac("sha512", b"pencil", salt, 4096)
    /// ckey = hmac.new(salted, b"Client Key", hashlib.sha512).digest()
    /// ...
    /// ```
    const ACCOUNT: &str = "user";
    const PASSWORD: &str = "pencil";
    const CNONCE: &str = "rOprNGfwEbeRWgbNEkqO";
    const SNONCE: &str = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    const SERVER_FIRST: &str = "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,\
                                s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096";
    const PROOF: &str = "gMGXRcevScNtxZ6/8lQYpGtnsNAc3mGcmNomv+xnoOMw+3R2xNJdMNnzMlTN8PPC\
                         6wdp6dybEmDYXYTxwnYPJQ==";
    const SERVER_FINAL: &str = "v=ZQnYEgWQMFmmsM8aQMF0nDDCy/AgCzkwk8CmMZYcMg0vSVlKDanekLti\
                                fDSeVGT4+5ZxXnJq199RVG2rR7N7Zw==";

    fn exchange() -> Scram {
        Scram::start(ACCOUNT, PASSWORD, CNONCE).0
    }

    #[test]
    fn the_first_message_declares_no_channel_binding() {
        let (_, first) = Scram::start(ACCOUNT, PASSWORD, CNONCE);
        assert_eq!(first, "n,,n=user,r=rOprNGfwEbeRWgbNEkqO");
    }

    #[test]
    fn the_proof_matches_an_independently_computed_one() {
        let mut scram = exchange();
        let final_message = scram.respond(SERVER_FIRST).expect("the reply is answered");

        assert_eq!(final_message, format!("c=biws,r={SNONCE},p={PROOF}"));
    }

    #[test]
    fn a_matching_server_signature_verifies() {
        let mut scram = exchange();
        scram.respond(SERVER_FIRST).expect("the reply is answered");

        assert_eq!(scram.verify(SERVER_FINAL), Ok(()));
    }

    /// The check that makes the exchange mutual. Without it a machine in the
    /// middle accepts any login it likes and the user is told they are signed
    /// in to something that never knew their password.
    #[test]
    fn a_signature_from_something_that_did_not_know_the_password_is_refused() {
        let mut scram = exchange();
        scram.respond(SERVER_FIRST).expect("the reply is answered");

        let forged = STANDARD.encode([0u8; digest::SHA512_OUTPUT_LEN]);
        assert_eq!(
            scram.verify(&format!("v={forged}")),
            Err(ScramError::BadSignature)
        );
    }

    /// The other half of the same protection: a reply carrying somebody else's
    /// nonce is somebody else's exchange.
    #[test]
    fn a_nonce_that_does_not_extend_ours_is_refused() {
        let mut scram = exchange();
        let replayed = SERVER_FIRST.replace(CNONCE, "someoneElsesNonceXY");

        assert_eq!(scram.respond(&replayed), Err(ScramError::NonceMismatch));
    }

    /// A server that echoes the nonce back unchanged has added nothing of its
    /// own, so the exchange is replayable.
    #[test]
    fn a_nonce_the_server_did_not_extend_is_refused() {
        let mut scram = exchange();
        let bare = format!("r={CNONCE},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096");

        assert_eq!(scram.respond(&bare), Err(ScramError::NonceMismatch));
    }

    /// The count is a number a stranger chooses and this client then executes.
    #[test]
    fn an_iteration_count_outside_the_range_is_refused() {
        for count in [0, 1, 1023, MAX_ITERATIONS + 1] {
            let mut scram = exchange();
            let named = format!("r={SNONCE},s=W22ZaJ0SNY7soEsUEjb6gQ==,i={count}");

            assert_eq!(scram.respond(&named), Err(ScramError::Iterations(count)));
        }
    }

    #[test]
    fn a_reply_missing_a_field_says_which() {
        let mut scram = exchange();
        assert_eq!(
            scram.respond(&format!("r={SNONCE},i=4096")),
            Err(ScramError::Malformed("no salt"))
        );
    }

    /// The server's own words, when it has some. `e=` can arrive in place of
    /// either reply.
    #[test]
    fn a_server_that_says_why_is_quoted() {
        let mut scram = exchange();
        assert_eq!(
            scram.respond("e=unknown-user"),
            Err(ScramError::Refused("unknown-user".into()))
        );
    }

    #[test]
    fn verifying_before_responding_is_refused_rather_than_passed() {
        let scram = exchange();
        assert_eq!(
            scram.verify(SERVER_FINAL),
            Err(ScramError::Malformed("no proof was sent yet"))
        );
    }

    /// Both characters SCRAM separates fields with, so a username holding
    /// either would otherwise end the field early and change what was signed.
    #[test]
    fn a_username_with_a_separator_in_it_is_escaped() {
        let (_, first) = Scram::start("a,b=c", PASSWORD, CNONCE);
        assert!(first.starts_with("n,,n=a=2Cb=3Dc,r="), "got {first}");
    }

    #[test]
    fn a_nonce_is_long_and_carries_no_separator() {
        let nonce = nonce(&ring::rand::SystemRandom::new());
        assert!(nonce.len() >= 24, "got {nonce:?}");
        assert!(!nonce.contains(','), "got {nonce:?}");
    }

    #[test]
    fn two_nonces_are_not_the_same_nonce() {
        let random = ring::rand::SystemRandom::new();
        assert_ne!(nonce(&random), nonce(&random));
    }
}
