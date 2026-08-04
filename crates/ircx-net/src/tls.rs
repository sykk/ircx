use std::path::Path;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WantsClientCert;
use rustls::crypto::CryptoProvider;
use rustls::{
    ClientConfig, ClientConnection, ConfigBuilder, DigitallySignedStruct, ProtocolVersion,
    RootCertStore, SignatureScheme,
};
use rustls_pemfile::Item;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};

use crate::error::NetError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsInfo {
    pub protocol: String,
    pub cipher_suite: String,
    pub peer_cert_subject: Option<String>,
}

/// What a user should be shown about the connection they got, in one line.
impl std::fmt::Display for TlsInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}, {}", self.protocol, self.cipher_suite)?;
        match &self.peer_cert_subject {
            Some(subject) => write!(f, ", certificate {subject}"),
            None => Ok(()),
        }
    }
}

/// How the server's own certificate is judged, which both configurations settle
/// before they differ over what to present in return.
fn verifying(verify: bool) -> ConfigBuilder<ClientConfig, WantsClientCert> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports TLS 1.2 and 1.3");

    if !verify {
        tracing::warn!("connecting without certificate verification");
        return builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCertificate { provider }));
    }

    let roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    builder.with_root_certificates(roots)
}

pub(crate) fn client_config(verify: bool) -> ClientConfig {
    verifying(verify).with_no_client_auth()
}

/// A connection that presents a certificate of its own.
///
/// This is what SASL EXTERNAL authenticates with: the mechanism says "use the
/// credentials of the layer underneath", and for IRC that layer is TLS. The
/// server matches the certificate's fingerprint against an account somebody
/// registered it to, so what makes it work is the file being the same one the
/// account service was told about — not the file being valid.
///
/// Fails rather than connecting without one. A certificate that was configured
/// and then silently not presented is a login that fails for no stated reason.
pub(crate) fn client_config_with_certificate(
    verify: bool,
    path: &Path,
) -> Result<ClientConfig, NetError> {
    let (chain, key) = read_identity(path)?;
    verifying(verify)
        .with_client_auth_cert(chain, key)
        .map_err(|source| NetError::ClientCertificateRejected {
            path: path.display().to_string(),
            source,
        })
}

/// The certificate chain and the private key that signs for it, from one PEM
/// file.
///
/// One file rather than two: a certfp identity is a thing a user generates in a
/// single `openssl req` and keeps together, and every client that reads one
/// reads it whole.
fn read_identity(
    path: &Path,
) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>), NetError> {
    let pem = std::fs::read(path).map_err(|source| NetError::ClientCertificateUnreadable {
        path: path.display().to_string(),
        source,
    })?;

    let mut chain = Vec::new();
    let mut key = None;
    for item in rustls_pemfile::read_all(&mut pem.as_slice()) {
        let item = item.map_err(|source| NetError::ClientCertificateUnreadable {
            path: path.display().to_string(),
            source,
        })?;
        match item {
            Item::X509Certificate(cert) => chain.push(cert),
            // The first key wins. A file holding two is answering a question
            // nobody asked, and picking the later one would be no better.
            Item::Pkcs1Key(found) => key = key.or(Some(PrivateKeyDer::Pkcs1(found))),
            Item::Pkcs8Key(found) => key = key.or(Some(PrivateKeyDer::Pkcs8(found))),
            Item::Sec1Key(found) => key = key.or(Some(PrivateKeyDer::Sec1(found))),
            _ => {}
        }
    }

    if chain.is_empty() {
        return Err(NetError::ClientCertificateMissing {
            path: path.display().to_string(),
        });
    }
    let Some(key) = key else {
        return Err(NetError::ClientKeyMissing {
            path: path.display().to_string(),
        });
    };
    Ok((chain, key))
}

/// The SHA-256 of the certificate in `path`, lowercase hex.
///
/// What a user has to give their account service — `/msg NickServ CERT ADD
/// <this>` — before a certificate authenticates anything. Read from the file
/// rather than from a live connection so it can be shown while the network is
/// being set up, which is when it is needed.
///
/// The first certificate in the file, which is the one presented. Anything
/// after it is a chain a certfp server never looks at.
pub fn certificate_fingerprint(path: &Path) -> Result<String, NetError> {
    let (chain, _) = read_identity(path)?;
    let first = chain.first().expect("read_identity refuses an empty chain");
    let digest = ring::digest::digest(&ring::digest::SHA256, first.as_ref());
    Ok(digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub(crate) fn tls_info(conn: &ClientConnection) -> TlsInfo {
    let protocol = match conn.protocol_version() {
        Some(ProtocolVersion::TLSv1_3) => "TLS 1.3".to_owned(),
        Some(ProtocolVersion::TLSv1_2) => "TLS 1.2".to_owned(),
        Some(other) => format!("{other:?}"),
        None => "unknown".to_owned(),
    };
    let cipher_suite = match conn.negotiated_cipher_suite() {
        Some(suite) => format!("{:?}", suite.suite()),
        None => "unknown".to_owned(),
    };
    let peer_cert_subject = conn
        .peer_certificates()
        .and_then(|chain| chain.first())
        .and_then(|der| x509_parser::parse_x509_certificate(der).ok())
        .map(|(_, cert)| cert.subject().to_string());

    TlsInfo {
        protocol,
        cipher_suite,
        peer_cert_subject,
    }
}

/// Reachable only through `ConnectionConfig::tls_verify == false`, which no
/// default sets: a failed handshake never falls back to this.
#[derive(Debug)]
struct AcceptAnyCertificate {
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for AcceptAnyCertificate {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A smoke test: building either config must not panic, and the vendored
    /// root store must not be empty. Nothing about the configs is asserted.
    #[test]
    fn both_verification_modes_build_without_panicking() {
        assert!(!webpki_roots::TLS_SERVER_ROOTS.is_empty());
        client_config(true);
        client_config(false);
    }

    /// A self-signed certificate and its key, as PEM. Generated rather than
    /// checked in: a private key in the repository is a private key somebody
    /// has to explain, and every scanner that reads the tree will find it.
    fn identity() -> (String, String) {
        let made = rcgen::generate_simple_self_signed(vec!["ircx.test".to_owned()])
            .expect("rcgen can make a self-signed certificate");
        (made.cert.pem(), made.signing_key.serialize_pem())
    }

    fn written(name: &str, contents: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("ircx-{name}-{}.pem", std::process::id()));
        std::fs::write(&path, contents).expect("the temp directory is writable");
        path
    }

    #[test]
    fn presents_a_certificate_and_key_from_one_file() {
        let (cert, key) = identity();
        let path = written("whole", &format!("{cert}{key}"));

        assert!(client_config_with_certificate(true, &path).is_ok());
        assert!(client_config_with_certificate(false, &path).is_ok());

        std::fs::remove_file(&path).ok();
    }

    /// The order people's files are actually in varies, and a file that works
    /// in one client and not this one would be read as this client's fault.
    #[test]
    fn reads_the_key_before_the_certificate_too() {
        let (cert, key) = identity();
        let path = written("reversed", &format!("{key}{cert}"));

        assert!(client_config_with_certificate(true, &path).is_ok());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn says_which_half_of_the_file_is_missing() {
        let (cert, key) = identity();

        let no_key = written("cert-only", &cert);
        let reason = client_config_with_certificate(true, &no_key)
            .expect_err("a certificate with no key cannot be presented")
            .to_string();
        assert!(reason.contains("no private key"), "{reason}");
        assert!(reason.contains(&no_key.display().to_string()), "{reason}");

        let no_cert = written("key-only", &key);
        let reason = client_config_with_certificate(true, &no_cert)
            .expect_err("a key with no certificate cannot be presented")
            .to_string();
        assert!(reason.contains("no certificate"), "{reason}");

        std::fs::remove_file(&no_key).ok();
        std::fs::remove_file(&no_cert).ok();
    }

    /// Naming the path matters more here than anywhere else: the usual way to
    /// arrive is a typo in a setting nothing else reads.
    #[test]
    fn names_the_file_it_could_not_open() {
        let missing = std::env::temp_dir().join("ircx-no-such-certificate.pem");

        let reason = client_config_with_certificate(true, &missing)
            .expect_err("a file that is not there cannot be read")
            .to_string();

        assert!(reason.contains(&missing.display().to_string()), "{reason}");
    }

    /// The fingerprint is what a user types at NickServ, so it has to be the
    /// digest of the certificate itself rather than of the file, the PEM text
    /// or the key beside it. Checked against the DER `rcgen` hands back, hashed
    /// here independently of the code under test.
    #[test]
    fn the_fingerprint_is_the_sha256_of_the_certificate() {
        let made = rcgen::generate_simple_self_signed(vec!["ircx.test".to_owned()])
            .expect("rcgen can make a self-signed certificate");
        let path = written(
            "fingerprint",
            &format!("{}{}", made.cert.pem(), made.signing_key.serialize_pem()),
        );

        let expected: String = ring::digest::digest(&ring::digest::SHA256, made.cert.der())
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();

        let found = certificate_fingerprint(&path).expect("the file holds a certificate");
        assert_eq!(found, expected);
        assert_eq!(found.len(), 64, "sha256 in hex is 64 characters: {found}");
        assert!(
            found
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
            "lowercase hex is what an account service is given: {found}"
        );

        std::fs::remove_file(&path).ok();
    }

    /// A certificate and a key that were never a pair. Two identities pasted
    /// into one file is the shape of a copy that went half wrong.
    #[test]
    fn refuses_a_key_that_does_not_sign_for_the_certificate() {
        let (cert, _) = identity();
        let (_, other_key) = identity();
        let path = written("mismatched", &format!("{cert}{other_key}"));

        let reason = client_config_with_certificate(true, &path)
            .expect_err("a key that signs for something else is not an identity")
            .to_string();
        assert!(reason.contains("do not go together"), "{reason}");
        assert!(reason.contains(&path.display().to_string()), "{reason}");

        std::fs::remove_file(&path).ok();
    }
}
