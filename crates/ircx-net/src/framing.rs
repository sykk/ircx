/// Longest inbound line kept. Anything past this is dropped up to the next
/// terminator, so a server that never sends one cannot grow the buffer.
pub const MAX_LINE_BYTES: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Framed {
    Line(String),
    Overlong { bytes: usize },
}

pub(crate) struct Framer {
    buf: Vec<u8>,
    skipping: bool,
    skipped: usize,
}

impl Framer {
    pub(crate) fn new() -> Self {
        Self {
            buf: Vec::with_capacity(4096),
            skipping: false,
            skipped: 0,
        }
    }

    pub(crate) fn push(&mut self, chunk: &[u8]) {
        self.buf.extend_from_slice(chunk);
    }

    pub(crate) fn next_line(&mut self) -> Option<Framed> {
        loop {
            let Some(end) = self.buf.iter().position(|b| *b == b'\n') else {
                if self.buf.len() > MAX_LINE_BYTES {
                    self.skipping = true;
                    self.skipped += self.buf.len();
                    self.buf.clear();
                }
                return None;
            };

            let mut line: Vec<u8> = self.buf.drain(..=end).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }

            if self.skipping {
                self.skipping = false;
                let bytes = self.skipped + line.len();
                self.skipped = 0;
                return Some(Framed::Overlong { bytes });
            }
            if line.is_empty() {
                continue;
            }
            // Reuses the Vec's allocation for valid UTF-8, which is nearly
            // every line; `from_utf8_lossy` would copy even then.
            return Some(Framed::Line(String::from_utf8(line).unwrap_or_else(
                |invalid| String::from_utf8_lossy(invalid.as_bytes()).into_owned(),
            )));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(framer: &mut Framer) -> Vec<Framed> {
        let mut out = Vec::new();
        while let Some(framed) = framer.next_line() {
            out.push(framed);
        }
        out
    }

    fn line(text: &str) -> Framed {
        Framed::Line(text.to_owned())
    }

    #[test]
    fn holds_a_partial_line_until_its_terminator() {
        let mut framer = Framer::new();
        framer.push(b"PING :serv");
        assert!(drain(&mut framer).is_empty());
        framer.push(b"er\r\n");
        assert_eq!(drain(&mut framer), vec![line("PING :server")]);
    }

    #[test]
    fn accepts_a_bare_line_feed() {
        let mut framer = Framer::new();
        framer.push(b"PING :one\nPING :two\r\n");
        assert_eq!(
            drain(&mut framer),
            vec![line("PING :one"), line("PING :two")]
        );
    }

    #[test]
    fn joins_a_crlf_split_across_reads() {
        let mut framer = Framer::new();
        framer.push(b"PING :server\r");
        assert!(drain(&mut framer).is_empty());
        framer.push(b"\nPONG :server\r\n");
        assert_eq!(
            drain(&mut framer),
            vec![line("PING :server"), line("PONG :server")]
        );
    }

    #[test]
    fn keeps_a_lone_carriage_return_inside_a_line() {
        let mut framer = Framer::new();
        framer.push(b"PRIVMSG #a :x\ry\r\n");
        assert_eq!(drain(&mut framer), vec![line("PRIVMSG #a :x\ry")]);
    }

    #[test]
    fn skips_empty_lines() {
        let mut framer = Framer::new();
        framer.push(b"\r\n\nPING :server\r\n");
        assert_eq!(drain(&mut framer), vec![line("PING :server")]);
    }

    #[test]
    fn replaces_invalid_utf8() {
        let mut framer = Framer::new();
        framer.push(b"PRIVMSG #a :caf\xe9\r\n");
        assert_eq!(drain(&mut framer), vec![line("PRIVMSG #a :caf\u{fffd}")]);
    }

    #[test]
    fn reports_an_overlong_line_and_recovers() {
        let mut framer = Framer::new();
        let huge = vec![b'x'; MAX_LINE_BYTES + 1];
        framer.push(&huge);
        assert!(drain(&mut framer).is_empty());
        framer.push(b"tail\r\nPING :server\r\n");
        assert_eq!(
            drain(&mut framer),
            vec![
                Framed::Overlong {
                    bytes: huge.len() + 4
                },
                line("PING :server"),
            ]
        );
    }

    #[test]
    fn keeps_a_line_of_exactly_the_maximum() {
        let mut framer = Framer::new();
        let mut chunk = vec![b'x'; MAX_LINE_BYTES];
        chunk.extend_from_slice(b"\r\n");
        framer.push(&chunk);
        assert_eq!(drain(&mut framer), vec![line(&"x".repeat(MAX_LINE_BYTES))]);
    }

    #[test]
    fn drops_only_the_overlong_line_when_it_arrives_in_pieces() {
        let mut framer = Framer::new();
        for _ in 0..3 {
            framer.push(&vec![b'x'; MAX_LINE_BYTES]);
            assert!(drain(&mut framer).is_empty());
        }
        framer.push(b"\r\nPING :server\r\n");
        let framed = drain(&mut framer);
        assert!(matches!(framed[0], Framed::Overlong { .. }));
        assert_eq!(framed[1], line("PING :server"));
    }
}
