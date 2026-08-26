//! What this session does about a file moving between it and one other person.
//!
//! The handshake is here and the bytes are not: every decision — whether an
//! offer may be answered, where a resume starts, which of several transfers a
//! line names — is made against session state, and the sockets are opened by
//! the task layer on the [`Action`]s this pushes. That keeps the whole protocol
//! drivable by a script in a test, which is the same bargain the rest of
//! [`SessionState`] makes.
//!
//! The handshake breaks the rule stated over `handle_incoming_ctcp`, that a
//! question is a `PRIVMSG` and an answer is a `NOTICE`. DCC has no such
//! division: `RESUME`, `ACCEPT` and the answer to a passive offer are all
//! `PRIVMSG`s. What keeps two clients from trading lines forever here is state
//! instead — every reply this sends is against a transfer it is already holding
//! and moves that transfer on, so a line with nothing behind it is dropped
//! rather than answered.

use std::net::IpAddr;
use std::path::PathBuf;

use ircx_ipc::{IrcxEvent, MessageKind, Sender, Transfer, TransferDirection, TransferState};
use ircx_proto::Message;
use uuid::Uuid;

use crate::dcc::{self, Request};
use crate::message::now;
use crate::session::{Action, SessionState};
use crate::text;

/// The lowest port an offer may name.
///
/// Below it are the services a machine runs for everybody, and an offer naming
/// one is asking this client to open a connection to something that is not a
/// peer. Every client that has thought about it refuses the same range.
const LOWEST_PORT: u16 = 1024;

/// How many transfers are remembered. Old enough entries have finished, and the
/// list exists so that somebody can see what happened; it is not a record.
const REMEMBERED: usize = 100;

/// Where a transfer's connection comes from. The two cases are the whole of
/// what makes DCC hard: one side has to be reachable, and which one is decided
/// during the handshake rather than by what either client would prefer.
#[derive(Debug, Clone)]
pub enum TransferEndpoint {
    /// Open a port and wait. The number is reported back before anything is
    /// sent, because the number is part of what gets sent.
    Listen {
        ports: Option<(u16, u16)>,
    },
    Dial {
        address: IpAddr,
        port: u16,
    },
}

/// One file to move, as the task layer needs it.
#[derive(Debug, Clone)]
pub struct TransferJob {
    pub id: String,
    pub path: PathBuf,
    pub incoming: bool,
    pub endpoint: TransferEndpoint,
    /// Where the bytes start, which is nonzero only after a resume was agreed.
    pub from: u64,
    pub size: u64,
}

pub(crate) struct TransferRecord {
    pub(crate) transfer: Transfer,
    /// The other side's nick, folded, so that a handshake line is matched to
    /// the person it has to have come from.
    peer: String,
    /// Where to dial. The offer's for an incoming transfer; the answer to a
    /// passive offer for an outgoing one, and unknown until it arrives.
    address: Option<IpAddr>,
    /// The port naming this transfer in the handshake: theirs for a transfer
    /// this client is receiving, ours for one it is sending. Zero while the
    /// offer is passive and the token is the name instead.
    port: u16,
    token: Option<String>,
    /// The address to put in anything this side offers, which is not always an
    /// address this machine holds.
    advertise: Option<IpAddr>,
    ports: Option<(u16, u16)>,
    from: u64,
    /// A `RESUME` was sent and the `ACCEPT` has not come back.
    resuming: bool,
    /// A job was handed to the task layer, so there is something to stop and
    /// something an agreed resume has to reach.
    running: bool,
}

impl SessionState {
    /// A `DCC` CTCP from somebody else.
    ///
    /// Draws its own rows rather than returning one, because an offer's row has
    /// to be named by the transfer it announces and the rest of the handshake
    /// is not worth a row at all.
    pub(crate) fn handle_dcc(
        &mut self,
        message: &Message,
        sender: &Sender,
        target: &str,
        args: &str,
    ) {
        let Some(request) = dcc::parse(args) else {
            // Said rather than dropped: a client that answers nothing and says
            // nothing looks to the other side like one that is not there.
            let text = format!(
                "{} sent a DCC request ircx cannot read: {args}",
                sender.nick
            );
            let note = self.chat_message(message, target, MessageKind::Server, text);
            self.append(note);
            return;
        };

        match request {
            Request::Send {
                file,
                address,
                port,
                size,
                token,
            } => self.dcc_offered(message, sender, target, file, address, port, size, token),
            Request::Resume {
                file,
                port,
                position,
                token,
            } => self.dcc_resume_asked(sender, &file, port, position, token.as_deref()),
            Request::Accept {
                port,
                position,
                token,
                ..
            } => self.dcc_resume_agreed(sender, port, position, token.as_deref()),
            Request::Reject { file } => self.dcc_rejected(sender, &file),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn dcc_offered(
        &mut self,
        message: &Message,
        sender: &Sender,
        target: &str,
        file: String,
        address: IpAddr,
        port: u16,
        size: u64,
        token: Option<String>,
    ) {
        let peer = self.fold(&sender.nick);

        // The answer to a passive offer of ours is itself a `SEND`, carrying
        // the token this client chose. It names a transfer that already exists
        // rather than opening one.
        if let Some(token) = token.as_deref() {
            if let Some(at) = self.outgoing_awaiting(&peer, token) {
                self.transfers[at].address = Some(address);
                self.transfers[at].port = port;
                self.transfers[at].transfer.state = TransferState::Connecting;
                self.start_transfer(at, TransferEndpoint::Dial { address, port });
                return;
            }
        }

        if port != 0 && port < LOWEST_PORT {
            let text = format!(
                "{} offered {file} on port {port}. ircx does not connect to ports below \
                 {LOWEST_PORT}, which belong to services rather than to people.",
                sender.nick
            );
            let note = self.chat_message(message, target, MessageKind::Server, text);
            self.append(note);
            return;
        }

        let text = format!(
            "{} is offering {file} ({}). Accept it to choose where it lands.",
            sender.nick,
            in_bytes(size)
        );
        let note = self.chat_message(message, target, MessageKind::Server, text);
        let row = note.id.clone();
        self.append(note);

        self.remember(TransferRecord {
            transfer: Transfer {
                id: Uuid::new_v4().to_string(),
                network: self.config.network.clone(),
                peer: sender.nick.clone(),
                direction: TransferDirection::Incoming,
                file,
                path: None,
                size,
                at: 0,
                state: TransferState::Offered,
                failure: None,
                started: now(),
                message: Some(row),
            },
            peer,
            address: Some(address),
            port,
            token,
            advertise: None,
            ports: None,
            from: 0,
            resuming: false,
            running: false,
        });
        self.emit_transfer(self.transfers.len() - 1);
    }

    /// The other side wants what this client is sending, from `position` on.
    fn dcc_resume_asked(
        &mut self,
        sender: &Sender,
        file: &str,
        port: u16,
        position: u64,
        token: Option<&str>,
    ) {
        let peer = self.fold(&sender.nick);
        let Some(at) = self.named(&peer, TransferDirection::Outgoing, port, token) else {
            return;
        };
        // Past the end is not a position in the file. Answering with what this
        // client will actually do beats agreeing to something it cannot.
        let position = position.min(self.transfers[at].transfer.size);
        self.transfers[at].from = position;
        self.transfers[at].transfer.at = position;

        let body = dcc::accept_body(file, port, position, token);
        self.send_dcc(&sender.nick.clone(), &body);

        // Where the file is already being offered, the task waiting for the
        // connection has to be told before that connection arrives. It will:
        // the other side dials only after reading the answer just queued.
        if self.transfers[at].running {
            let id = self.transfers[at].transfer.id.clone();
            self.actions
                .push(Action::ResumeTransferAt { id, from: position });
        }
        self.emit_transfer(at);
    }

    /// The other side agreed to the resume this client asked for.
    fn dcc_resume_agreed(
        &mut self,
        sender: &Sender,
        port: u16,
        position: u64,
        token: Option<&str>,
    ) {
        let peer = self.fold(&sender.nick);
        let Some(at) = self.named(&peer, TransferDirection::Incoming, port, token) else {
            return;
        };
        if !self.transfers[at].resuming {
            return;
        }
        // Their position rather than the one asked for: a sender may agree to
        // less, and what arrives then starts where they say it does.
        self.transfers[at].resuming = false;
        self.transfers[at].from = position;
        self.transfers[at].transfer.at = position;
        self.begin_receiving(at);
    }

    fn dcc_rejected(&mut self, sender: &Sender, file: &str) {
        let peer = self.fold(&sender.nick);
        let Some(at) = self.transfers.iter().position(|record| {
            record.peer == peer
                && record.transfer.direction == TransferDirection::Outgoing
                && record.transfer.file == file
                && matches!(
                    record.transfer.state,
                    TransferState::Offered | TransferState::Connecting
                )
        }) else {
            return;
        };
        self.transfers[at].transfer.state = TransferState::Declined;
        self.stop_job(at);
        self.emit_transfer(at);
    }

    /// Offers a file to somebody. `address` is what goes in the offer and
    /// `ports` is the range this client may open; both come from the settings,
    /// because neither is anything the session can work out for itself.
    #[allow(clippy::too_many_arguments)]
    pub fn offer_file(
        &mut self,
        nick: &str,
        path: PathBuf,
        file: String,
        size: u64,
        ports: Option<(u16, u16)>,
        address: IpAddr,
        passive: bool,
    ) -> (Result<Transfer, String>, Vec<Action>) {
        if self.isupport.is_channel(nick) {
            return (
                Err("A file is offered to one person, not to a channel".into()),
                Vec::new(),
            );
        }

        let token = passive.then(|| {
            self.next_transfer_token += 1;
            self.next_transfer_token.to_string()
        });

        // The conversation with them is where the offer is watched and stopped,
        // for the reason an arriving one is drawn there: it is where the reader
        // already is. Opening it is part of offering — a file sent to somebody
        // this client has never spoken to would otherwise have nowhere to say
        // so.
        self.touch_query(nick, None);
        let target = self.canonical(nick);
        let text = format!("Offering {file} ({}) to {nick}", in_bytes(size));
        let note = self.local_message(&target, MessageKind::Server, text);
        let row = note.id.clone();
        self.append(note);

        let record = TransferRecord {
            transfer: Transfer {
                id: Uuid::new_v4().to_string(),
                network: self.config.network.clone(),
                peer: self.canonical_nick(nick),
                direction: TransferDirection::Outgoing,
                file: file.clone(),
                path: Some(path.to_string_lossy().into_owned()),
                size,
                at: 0,
                state: TransferState::Offered,
                failure: None,
                started: now(),
                message: Some(row),
            },
            peer: self.fold(nick),
            address: None,
            port: 0,
            token,
            advertise: Some(address),
            ports,
            from: 0,
            resuming: false,
            running: false,
        };
        let offered = record.transfer.clone();
        self.remember(record);
        let at = self.transfers.len() - 1;

        match self.transfers[at].token.clone() {
            // A passive offer names no port, so there is nothing to open and
            // nothing to wait for until the other side answers with theirs.
            Some(token) => {
                let file = self.transfers[at].transfer.file.clone();
                let body = dcc::send_body(&file, address, 0, size, Some(&token));
                self.send_dcc(nick, &body);
                self.emit_transfer(at);
            }
            None => self.start_transfer(at, TransferEndpoint::Listen { ports }),
        }
        (Ok(offered), self.drain())
    }

    /// Takes an offer. `path` is where the file lands and `resume_from` is what
    /// is already there — both settled above this layer, which is the only one
    /// that can look at a disk.
    pub fn accept_transfer(
        &mut self,
        id: &str,
        path: PathBuf,
        resume_from: u64,
        ports: Option<(u16, u16)>,
        address: IpAddr,
    ) -> (Result<(), String>, Vec<Action>) {
        let Some(at) = self.transfers.iter().position(|record| {
            record.transfer.id == id && record.transfer.state == TransferState::Offered
        }) else {
            return (
                Err("That transfer is no longer waiting to be accepted".into()),
                Vec::new(),
            );
        };
        if self.transfers[at].transfer.direction != TransferDirection::Incoming {
            return (
                Err("That is a file being sent, not one being offered".into()),
                Vec::new(),
            );
        }

        let record = &mut self.transfers[at];
        record.transfer.path = Some(path.to_string_lossy().into_owned());
        record.transfer.state = TransferState::Connecting;
        record.advertise = Some(address);
        record.ports = ports;
        record.from = resume_from;
        record.transfer.at = resume_from;

        if resume_from > 0 {
            let (file, port, token) = (
                record.transfer.file.clone(),
                record.port,
                record.token.clone(),
            );
            record.resuming = true;
            let peer = record.transfer.peer.clone();
            let body = dcc::resume_body(&file, port, resume_from, token.as_deref());
            self.send_dcc(&peer, &body);
            self.emit_transfer(at);
            return (Ok(()), self.drain());
        }

        self.begin_receiving(at);
        (Ok(()), self.drain())
    }

    /// Where an accepted incoming transfer's connection comes from, which the
    /// offer decided: a passive offer left this client the one that has to be
    /// reachable.
    fn begin_receiving(&mut self, at: usize) {
        let endpoint = match self.transfers[at].token.is_some() {
            true => TransferEndpoint::Listen {
                ports: self.transfers[at].ports,
            },
            false => match self.transfers[at].address {
                Some(address) => TransferEndpoint::Dial {
                    address,
                    port: self.transfers[at].port,
                },
                None => {
                    self.fail_transfer(at, "The offer named no address to connect to".into());
                    return;
                }
            },
        };
        self.transfers[at].transfer.state = TransferState::Connecting;
        self.start_transfer(at, endpoint);
    }

    pub fn decline_transfer(&mut self, id: &str) -> Vec<Action> {
        let Some(at) = self.transfers.iter().position(|record| {
            record.transfer.id == id && record.transfer.state == TransferState::Offered
        }) else {
            return Vec::new();
        };
        let (peer, file) = (
            self.transfers[at].transfer.peer.clone(),
            self.transfers[at].transfer.file.clone(),
        );
        // Told rather than left to time out: the other side is holding a port
        // open for this, and two minutes of that is two minutes of a client
        // that looks like it is still deciding.
        let body = dcc::reject_body(&file);
        self.send_dcc(&peer, &body);
        self.transfers[at].transfer.state = TransferState::Declined;
        self.emit_transfer(at);
        self.drain()
    }

    pub fn cancel_transfer(&mut self, id: &str) -> Vec<Action> {
        let Some(at) = self
            .transfers
            .iter()
            .position(|record| record.transfer.id == id)
        else {
            return Vec::new();
        };
        if is_over(self.transfers[at].transfer.state) {
            return Vec::new();
        }
        // An offer nobody has answered is turned down rather than stopped,
        // because there is nothing running yet and the other side is waiting.
        if self.transfers[at].transfer.state == TransferState::Offered
            && self.transfers[at].transfer.direction == TransferDirection::Incoming
        {
            return self.decline_transfer(id);
        }
        self.transfers[at].transfer.state = TransferState::Cancelled;
        self.stop_job(at);
        self.emit_transfer(at);
        self.drain()
    }

    pub fn transfers(&self) -> Vec<Transfer> {
        self.transfers
            .iter()
            .map(|record| record.transfer.clone())
            .collect()
    }

    /// The port a job opened. What is sent now is what the port was opened for:
    /// an offer of this client's own, or the answer to a passive one.
    pub fn transfer_listening(&mut self, id: &str, port: u16) -> Vec<Action> {
        let Some(at) = self
            .transfers
            .iter()
            .position(|record| record.transfer.id == id)
        else {
            return Vec::new();
        };
        let record = &mut self.transfers[at];
        let Some(address) = record.advertise else {
            return Vec::new();
        };
        let (peer, file, size, token) = (
            record.transfer.peer.clone(),
            record.transfer.file.clone(),
            record.transfer.size,
            record.token.clone(),
        );
        if record.transfer.direction == TransferDirection::Outgoing {
            record.port = port;
        }

        let body = dcc::send_body(&file, address, port, size, token.as_deref());
        self.send_dcc(&peer, &body);
        self.emit_transfer(at);
        self.drain()
    }

    pub fn transfer_progress(&mut self, id: &str, at_bytes: u64) -> Vec<Action> {
        let Some(at) = self
            .transfers
            .iter()
            .position(|record| record.transfer.id == id)
        else {
            return Vec::new();
        };
        if is_over(self.transfers[at].transfer.state) {
            return Vec::new();
        }
        self.transfers[at].transfer.state = TransferState::Running;
        self.transfers[at].transfer.at = at_bytes;
        self.emit_transfer(at);
        self.drain()
    }

    /// A job that ended, well or badly.
    ///
    /// A whole file that arrived is `Done` whatever was decided about it in the
    /// meantime, because the file is there under the name the reader chose and
    /// calling that cancelled is a lie about what is on the disk. A cancel and
    /// the last byte can cross — the two reach the session down different
    /// senders — and the loser of that race is the cancel.
    ///
    /// A job that failed keeps a cancel instead: the cancelling is what the
    /// failure is, and it is the more useful of the two things to say.
    pub fn transfer_finished(
        &mut self,
        id: &str,
        at_bytes: u64,
        failure: Option<String>,
    ) -> Vec<Action> {
        let Some(at) = self
            .transfers
            .iter()
            .position(|record| record.transfer.id == id)
        else {
            return Vec::new();
        };
        self.transfers[at].running = false;
        self.transfers[at].transfer.at = at_bytes;
        if failure.is_none() {
            self.transfers[at].transfer.state = TransferState::Done;
            self.transfers[at].transfer.failure = None;
        } else if !is_over(self.transfers[at].transfer.state) {
            match failure {
                Some(reason) => {
                    self.transfers[at].transfer.state = TransferState::Failed;
                    self.transfers[at].transfer.failure = Some(reason);
                }
                None => self.transfers[at].transfer.state = TransferState::Done,
            }
        }
        self.emit_transfer(at);
        self.drain()
    }

    /// The transfer a handshake line names: by port where there is one, and by
    /// token where the offer was passive and left no port to name it by.
    fn named(
        &self,
        peer: &str,
        direction: TransferDirection,
        port: u16,
        token: Option<&str>,
    ) -> Option<usize> {
        self.transfers.iter().position(|record| {
            record.peer == peer
                && record.transfer.direction == direction
                && !is_over(record.transfer.state)
                && match token {
                    Some(token) => record.token.as_deref() == Some(token),
                    None => port != 0 && record.port == port,
                }
        })
    }

    fn outgoing_awaiting(&self, peer: &str, token: &str) -> Option<usize> {
        self.transfers.iter().position(|record| {
            record.peer == peer
                && record.transfer.direction == TransferDirection::Outgoing
                && record.transfer.state == TransferState::Offered
                && record.token.as_deref() == Some(token)
        })
    }

    fn start_transfer(&mut self, at: usize, endpoint: TransferEndpoint) {
        let record = &mut self.transfers[at];
        let Some(path) = record.transfer.path.clone() else {
            self.fail_transfer(at, "The file has nowhere to go".into());
            return;
        };
        record.running = true;
        let job = TransferJob {
            id: record.transfer.id.clone(),
            path: PathBuf::from(path),
            incoming: record.transfer.direction == TransferDirection::Incoming,
            endpoint,
            from: record.from,
            size: record.transfer.size,
        };
        self.actions.push(Action::RunTransfer(Box::new(job)));
        self.emit_transfer(at);
    }

    fn stop_job(&mut self, at: usize) {
        if !self.transfers[at].running {
            return;
        }
        self.transfers[at].running = false;
        let id = self.transfers[at].transfer.id.clone();
        self.actions.push(Action::StopTransfer { id });
    }

    fn fail_transfer(&mut self, at: usize, reason: String) {
        self.transfers[at].transfer.state = TransferState::Failed;
        self.transfers[at].transfer.failure = Some(reason);
        self.emit_transfer(at);
    }

    fn remember(&mut self, record: TransferRecord) {
        self.transfers.push(record);
        while self.transfers.len() > REMEMBERED {
            let Some(at) = self
                .transfers
                .iter()
                .position(|record| is_over(record.transfer.state))
            else {
                break;
            };
            self.transfers.remove(at);
        }
    }

    fn emit_transfer(&mut self, at: usize) {
        let transfer = self.transfers[at].transfer.clone();
        self.emit(IrcxEvent::TransferUpdated {
            transfer: Box::new(transfer),
        });
    }

    /// The handshake travels on a `PRIVMSG`, in both directions and at every
    /// step. See the note at the top of this file for why that is safe here and
    /// is not for the CTCPs beside it.
    fn send_dcc(&mut self, nick: &str, body: &str) {
        let wrapped = text::ctcp_wrap("DCC", body);
        self.send_command("PRIVMSG", &[nick, &wrapped]);
    }
}

fn is_over(state: TransferState) -> bool {
    matches!(
        state,
        TransferState::Done
            | TransferState::Declined
            | TransferState::Cancelled
            | TransferState::Failed
    )
}

/// A size as somebody would say it, for the one line that announces an offer.
/// The frontend says it the same way; this is for the row that is read where no
/// transfer panel is open.
fn in_bytes(size: u64) -> String {
    const UNITS: [&str; 3] = ["KB", "MB", "GB"];
    if size < 1024 {
        return format!("{size} B");
    }
    let mut size = size as f64 / 1024.0;
    let mut unit = 0;
    while size >= 1024.0 && unit < UNITS.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }
    match size < 10.0 {
        true => format!("{size:.1} {}", UNITS[unit]),
        false => format!("{} {}", size.round(), UNITS[unit]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_a_size_the_way_a_person_would() {
        assert_eq!(in_bytes(512), "512 B");
        assert_eq!(in_bytes(2048), "2.0 KB");
        assert_eq!(in_bytes(51_200), "50 KB");
        assert_eq!(in_bytes(5 * 1024 * 1024), "5.0 MB");
    }
}
