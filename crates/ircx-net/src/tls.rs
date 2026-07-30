use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::{
    ClientConfig, ClientConnection, DigitallySignedStruct, ProtocolVersion, RootCertStore,
    SignatureScheme,
};
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};

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

pub(crate) fn client_config(verify: bool) -> ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports TLS 1.2 and 1.3");

    if !verify {
        tracing::warn!("connecting without certificate verification");
        return builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCertificate { provider }))
            .with_no_client_auth();
    }

    let roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    builder.with_root_certificates(roots).with_no_client_auth()
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

    #[test]
    fn both_verification_modes_build() {
        assert!(!webpki_roots::TLS_SERVER_ROOTS.is_empty());
        client_config(true);
        client_config(false);
    }
}
