//! A separate OS process, one per plugin, speaking JSON lines over pipes.
//!
//! The plugin here is a native executable, which is what this mechanism means
//! in practice — the same shape as an LSP server or a Neovim RPC plugin. That
//! is the whole trade: termination is `SIGKILL` and cannot be evaded, and in
//! exchange the thing being terminated has every privilege the user has.
//!
//! Limits are the kernel's: `RLIMIT_DATA` for the heap, `RLIMIT_CPU` as a
//! backstop for a plugin that ignores its deadline while the parent is busy.
//! Neither needs cooperation from the plugin.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use crate::{CommandCall, Failure, Manifest, Permission, Sandbox};

/// Total CPU seconds a plugin process may burn before the kernel kills it.
const CPU_SECONDS: libc::rlim_t = 10;

/// What the child writes back, one line per call.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Answer {
    Reply(String),
    Send(String),
    Raised(String),
}

pub struct ProcSandbox {
    child: Child,
    stdin: std::process::ChildStdin,
    lines: Receiver<std::io::Result<String>>,
    manifest: Manifest,
    outbox: Vec<String>,
    dead: bool,
}

impl ProcSandbox {
    /// `source` is the path to the executable; `mode` is passed to it as its
    /// one argument, which is how the fixture picks a misbehaviour.
    pub fn spawn(manifest: Manifest, exe: &Path, mode: &str) -> Result<Self, Failure> {
        let heap = manifest.memory_limit as libc::rlim_t;
        let mut command = Command::new(exe);
        command
            .arg(mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            // Nothing in the parent's environment reaches the plugin. Cheap,
            // and it is the only part of the parent's state this mechanism can
            // withhold without help from the kernel.
            .env_clear();
        unsafe {
            command.pre_exec(move || {
                let heap_limit = libc::rlimit {
                    rlim_cur: heap,
                    rlim_max: heap,
                };
                if libc::setrlimit(libc::RLIMIT_DATA, &heap_limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Cumulative, not per call, so it is a backstop against a
                // runaway rather than a deadline: a plugin that behaves for a
                // long session would eventually hit a tight one.
                let cpu_limit = libc::rlimit {
                    rlim_cur: CPU_SECONDS,
                    rlim_max: CPU_SECONDS,
                };
                if libc::setrlimit(libc::RLIMIT_CPU, &cpu_limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // Without this a plugin that aborts holds its pipes open for
                // as long as the system takes to write a core file, which is
                // long enough that the parent's deadline fires first and the
                // host cannot tell a crash from a hang.
                let no_core = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::setrlimit(libc::RLIMIT_CORE, &no_core) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let mut child = command.spawn().map_err(|e| Failure::Host(e.to_string()))?;
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");

        // A pipe read cannot be given a deadline, so it happens on its own
        // thread and the deadline lives on the channel.
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let stop = line.is_err();
                if tx.send(line).is_err() || stop {
                    return;
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            lines,
            manifest,
            outbox: Vec::new(),
            dead: false,
        })
    }

    /// The fixture plugin, which cargo builds into the same directory as
    /// whatever is calling this.
    pub fn child_exe() -> PathBuf {
        let mut path = std::env::current_exe().expect("current exe");
        path.pop();
        if path.ends_with("deps") {
            path.pop();
        }
        path.push("plugin-child");
        path
    }

    fn kill(&mut self) {
        self.dead = true;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Sandbox for ProcSandbox {
    /// `source` is a path to an executable, in the encoding of the platform.
    fn load(manifest: Manifest, source: &[u8]) -> Result<Self, Failure> {
        let path = std::str::from_utf8(source)
            .map_err(|_| Failure::Host("plugin path is not utf-8".into()))?;
        let (exe, mode) = path.split_once('#').unwrap_or((path, "echo"));
        Self::spawn(manifest, Path::new(exe), mode)
    }

    fn call_command(&mut self, call: &CommandCall) -> Result<String, Failure> {
        if self.dead {
            return Err(Failure::Raised("plugin was terminated".into()));
        }
        let mut line = serde_json::to_string(call).map_err(|e| Failure::Host(e.to_string()))?;
        line.push('\n');
        if self.stdin.write_all(line.as_bytes()).is_err() || self.stdin.flush().is_err() {
            self.kill();
            return Err(Failure::Raised("plugin closed its input".into()));
        }

        let deadline = self.manifest.call_timeout;
        loop {
            match self.lines.recv_timeout(deadline) {
                Ok(Ok(text)) => match serde_json::from_str::<Answer>(&text) {
                    Ok(Answer::Reply(reply)) => return Ok(reply),
                    Ok(Answer::Send(msg)) => {
                        // The parent is the only thing standing between the
                        // plugin and the socket, so the grant is checked here.
                        // Contrast the `rogue` fixture, which asks the kernel
                        // instead and never comes past this point at all.
                        if !self.manifest.grants(&Permission::SendMessages) {
                            self.kill();
                            return Err(Failure::Denied("send messages".into()));
                        }
                        self.outbox.push(msg);
                    }
                    Ok(Answer::Raised(err)) => return Err(Failure::Raised(err)),
                    Err(e) => {
                        self.kill();
                        return Err(Failure::Raised(format!("unreadable answer: {e}")));
                    }
                },
                Ok(Err(e)) => {
                    self.kill();
                    return Err(Failure::Raised(format!("plugin pipe broke: {e}")));
                }
                Err(RecvTimeoutError::Timeout) => {
                    self.kill();
                    return Err(Failure::Timeout);
                }
                Err(RecvTimeoutError::Disconnected) => {
                    // The reader thread saw EOF: the child is gone. Whether it
                    // was the allocator aborting or a panic, the parent only
                    // learns that the answer is not coming.
                    let status = self.child.wait().ok();
                    self.dead = true;
                    let how = status
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "unknown".into());
                    return Err(Failure::Raised(format!("plugin exited: {how}")));
                }
            }
        }
    }

    fn outbox(&self) -> Vec<String> {
        self.outbox.clone()
    }
}

impl Drop for ProcSandbox {
    fn drop(&mut self) {
        if !self.dead {
            self.kill();
        }
    }
}

/// Wall clock from `spawn` to the child answering its first call. This is the
/// number that decides whether the mechanism can be lazy: if it is small
/// enough, the process starts when the first command is typed, not at launch.
pub fn first_answer(manifest: Manifest, exe: &Path) -> Result<Duration, Failure> {
    let call = CommandCall {
        command: "spike".into(),
        args: "hello".into(),
        channel: "#ircx".into(),
    };
    let started = std::time::Instant::now();
    let mut sandbox = ProcSandbox::spawn(manifest, exe, "echo")?;
    sandbox.call_command(&call)?;
    Ok(started.elapsed())
}
