//! The fixture plugin for the separate-process mechanism: a native executable
//! that reads one JSON line per call and writes one back. Its single argument
//! picks how it behaves.
//!
//! `rogue` is the interesting one. Its manifest grants it nothing beyond
//! adding a command, and it reads the filesystem and opens a socket anyway,
//! because nothing on this side of the pipe can stop it.

use std::io::{BufRead, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

use ircx_plugin::proc::Answer;

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "echo".into());
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { return };
        let answers = match mode.as_str() {
            "echo" => vec![Answer::Reply(format!("pong:{line}"))],
            "panic" => panic!("boom"),
            "loop" => loop {
                std::hint::spin_loop()
            },
            "hang" => {
                // Reads and never answers. The only mode that is a hang rather
                // than a loop: it burns no CPU, so a CPU limit never sees it.
                std::thread::sleep(Duration::from_secs(3600));
                unreachable!()
            }
            "memory" => {
                let mut held: Vec<Vec<u8>> = Vec::new();
                loop {
                    held.push(vec![7u8; 1 << 20]);
                }
            }
            "sender" => vec![
                Answer::Send("PRIVMSG from plugin".into()),
                Answer::Reply("sent".into()),
            ],
            "rogue" => vec![Answer::Reply(trespass())],
            other => vec![Answer::Raised(format!("unknown mode {other}"))],
        };
        for answer in &answers {
            let text = serde_json::to_string(answer).expect("answer serialises");
            if writeln!(out, "{text}").is_err() {
                return;
            }
        }
        if out.flush().is_err() {
            return;
        }
    }
}

/// Two capabilities the manifest never granted: read any file the user can
/// read, and open a socket. The socket goes to a port nothing listens on, so
/// "connection refused" is the interesting answer — it means `socket()` and
/// `connect()` were allowed and only the far end said no.
fn trespass() -> String {
    let passwd = std::fs::read("/etc/passwd")
        .map(|b| format!("read /etc/passwd, {} bytes", b.len()))
        .unwrap_or_else(|e| format!("could not read /etc/passwd: {e}"));
    let addr: SocketAddr = "127.0.0.1:9".parse().expect("literal address");
    let socket = match TcpStream::connect_timeout(&addr, Duration::from_millis(200)) {
        Ok(_) => "connected to 127.0.0.1:9".to_owned(),
        Err(e) => format!("socket to 127.0.0.1:9 said {}", e.kind()),
    };
    format!("{passwd}; {socket}")
}
