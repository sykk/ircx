//! What the transport presents, watched from the other end of a real
//! handshake.
//!
//! `loopback.rs` runs over plaintext and `https_probe.rs` needs somebody else's
//! machines, so until now nothing in the suite had watched this code complete a
//! TLS handshake at all. A certificate fixture is what was missing, and #401
//! brings one: `rcgen` makes both ends' certificates in the test.
//!
//! The listener accepts any client certificate and records it, which is not a
//! lax stand-in for a strict server — it is what a certfp server does. Ergo and
//! Libera do not build a chain to a certificate authority; they take the
//! fingerprint of whatever is presented and look for an account registered to
//! it. So the property under test is that the bytes configured are the bytes
//! that arrive.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use ircx_net::{ConnectionConfig, Transport, TransportEvent};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, ServerConfig, SignatureScheme};
use rustls_pki_types::{CertificateDer, PrivateKeyDer, UnixTime};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

/// The certificate the client presented, as the server saw it.
type Seen = Arc<Mutex<Option<Vec<u8>>>>;

#[derive(Debug)]
struct AcceptAnyClientCertificate {
    seen: Seen,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ClientCertVerifier for AcceptAnyClientCertificate {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    /// Asked for, not required — again what a certfp server does. A client with
    /// no certificate connects and simply does not get an account out of it,
    /// which is the case the second test needs to be able to reach.
    fn client_auth_mandatory(&self) -> bool {
        false
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        *self.seen.lock().expect("no test holds this across a panic") =
            Some(end_entity.as_ref().to_vec());
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
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
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
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

struct Identity {
    pem: String,
    der: Vec<u8>,
}

fn identity(name: &str) -> Identity {
    let made = rcgen::generate_simple_self_signed(vec![name.to_owned()])
        .expect("rcgen makes a certificate");
    Identity {
        pem: format!("{}{}", made.cert.pem(), made.signing_key.serialize_pem()),
        der: made.cert.der().to_vec(),
    }
}

fn written(name: &str, contents: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("ircx-test-{name}-{}.pem", std::process::id()));
    std::fs::write(&path, contents).expect("the temp directory is writable");
    path
}

/// A listener that asks for a certificate and lets the handshake finish either
/// way, so the run says which of the two happened rather than only that it
/// failed.
async fn listening(seen: Seen) -> (TcpListener, TlsAcceptor) {
    let server = rcgen::generate_simple_self_signed(vec!["localhost".to_owned()])
        .expect("rcgen makes a certificate");
    let cert = CertificateDer::from(server.cert.der().to_vec());
    let key = PrivateKeyDer::try_from(server.signing_key.serialize_der())
        .expect("rcgen hands back a PKCS#8 key");

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ServerConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("the ring provider supports TLS 1.2 and 1.3")
        .with_client_cert_verifier(Arc::new(AcceptAnyClientCertificate { seen, provider }))
        .with_single_cert(vec![cert], key)
        .expect("the generated pair goes together");

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    (listener, TlsAcceptor::from(Arc::new(config)))
}

fn dialling(port: u16, certificate: Option<std::path::PathBuf>) -> ConnectionConfig {
    ConnectionConfig {
        host: "localhost".to_owned(),
        port,
        tls: true,
        // The listener's own certificate is self-signed, which is the setting
        // this option exists for. What is under test is the other direction.
        tls_verify: false,
        client_certificate: certificate,
        connect_timeout: Duration::from_secs(5),
    }
}

#[tokio::test]
async fn the_server_receives_the_certificate_that_was_configured() {
    let client = identity("walker");
    let path = written("client", &client.pem);
    let seen: Seen = Arc::new(Mutex::new(None));
    let (listener, acceptor) = listening(Arc::clone(&seen)).await;
    let port = listener.local_addr().expect("local addr").port();

    let serving = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("accept");
        // Held until the client has finished with it: dropping the stream here
        // would close the connection before the transport reports Connected.
        let stream = acceptor.accept(tcp).await.expect("the handshake completes");
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(stream);
    });

    let (_transport, mut events) = Transport::connect(dialling(port, Some(path.clone())))
        .await
        .expect("the connection is made");

    match events.recv().await {
        Some(TransportEvent::Connected { tls_info }) => {
            let info = tls_info.expect("a TLS connection reports what it negotiated");
            assert!(info.protocol.starts_with("TLS 1."), "{info:?}");
        }
        other => panic!("expected Connected, got {other:?}"),
    }
    serving.await.expect("the listener task finishes");

    let presented = seen.lock().expect("the listener is done with it").clone();
    assert_eq!(
        presented.as_deref(),
        Some(client.der.as_slice()),
        "the server saw a different certificate than the one configured",
    );

    std::fs::remove_file(&path).ok();
}

/// The same handshake with nothing configured. Without it, a test that only
/// ever ran the first case could not tell "the certificate arrived" from "the
/// listener records something whatever the client does".
#[tokio::test]
async fn a_connection_without_one_presents_nothing() {
    let seen: Seen = Arc::new(Mutex::new(None));
    let (listener, acceptor) = listening(Arc::clone(&seen)).await;
    let port = listener.local_addr().expect("local addr").port();

    let serving = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.expect("accept");
        let stream = acceptor.accept(tcp).await.expect("the handshake completes");
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(stream);
    });

    let (_transport, mut events) = Transport::connect(dialling(port, None))
        .await
        .expect("the connection is made");
    match events.recv().await {
        Some(TransportEvent::Connected { .. }) => {}
        other => panic!("expected Connected, got {other:?}"),
    }
    serving.await.expect("the listener task finishes");

    assert!(
        seen.lock().expect("the listener is done with it").is_none(),
        "a client with no certificate configured presented one anyway",
    );
}
