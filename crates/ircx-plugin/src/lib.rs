//! Design spike for issue #13. Three isolation mechanisms behind one trait, so
//! the same trivial plugin and the same four failure modes can be run against
//! each and timed.
//!
//! Nothing here is wired into the app. `ircx-plugin` is a workspace member so
//! it is built and linted, but no crate depends on it, so the shipped binary
//! and its startup are untouched. Deleting the directory and its workspace
//! entry abandons the spike.
//!
//! The write-up is `docs/plugin-isolation.md`.

use std::fmt;
use std::time::Duration;

#[cfg(feature = "js")]
pub mod js;
#[cfg(feature = "proc")]
pub mod proc;
#[cfg(feature = "wasm")]
pub mod wasm;

/// The permission set the product spec names, one variant per line of it.
///
/// A permission is only real if the mechanism can refuse the capability when
/// the manifest does not ask for it. `docs/plugin-isolation.md` records which
/// of these each mechanism can actually hold.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Permission {
    ReadMessages,
    SendMessages,
    AddCommands,
    StoreLocalData,
    /// Empty means every channel the user is in; otherwise the named ones.
    AccessChannels(Vec<String>),
    /// Hosts the plugin may reach. Empty means none.
    NetworkRequests(Vec<String>),
    RenderContent,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Manifest {
    pub id: String,
    pub permissions: Vec<Permission>,
    /// Wall clock a single hook call may take before the plugin is terminated.
    #[serde(with = "millis")]
    pub call_timeout: Duration,
    /// Bytes the plugin may hold. Not every mechanism can enforce this.
    pub memory_limit: usize,
}

impl Manifest {
    /// A manifest that grants only what a slash command needs.
    pub fn command_only(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            permissions: vec![Permission::AddCommands, Permission::SendMessages],
            call_timeout: Duration::from_millis(100),
            memory_limit: 8 << 20,
        }
    }

    pub fn grants(&self, wanted: &Permission) -> bool {
        self.permissions.contains(wanted)
    }
}

mod millis {
    use std::time::Duration;

    pub fn serialize<S: serde::Serializer>(d: &Duration, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(d.as_millis() as u64)
    }

    pub fn deserialize<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Duration, D::Error> {
        <u64 as serde::Deserialize>::deserialize(d).map(Duration::from_millis)
    }
}

/// The one extension point this spike implements: a custom slash command.
///
/// The other four the spec names — message renderers, link and attachment
/// providers, notification rules, protocol capability adapters — are the same
/// shape (host hands over a value, plugin returns one, host applies a
/// deadline), so one of them is enough to measure per-call cost.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommandCall {
    pub command: String,
    pub args: String,
    pub channel: String,
}

/// Why a call did not produce an answer. Every variant must leave the host
/// running and the plugin dead; that is the requirement the spike is testing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// The plugin raised: a JS exception, a wasm trap, a child that exited.
    Raised(String),
    /// The deadline passed and the plugin was terminated.
    Timeout,
    /// The plugin asked for more memory than its manifest allows.
    OutOfMemory,
    /// The plugin asked for something its manifest does not grant.
    Denied(String),
    /// The mechanism itself broke — could not load, could not spawn.
    Host(String),
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Raised(m) => write!(f, "plugin raised: {m}"),
            Self::Timeout => write!(f, "plugin exceeded its deadline and was terminated"),
            Self::OutOfMemory => write!(f, "plugin exceeded its memory limit"),
            Self::Denied(p) => write!(f, "plugin asked for {p}, which it was not granted"),
            Self::Host(m) => write!(f, "sandbox failed: {m}"),
        }
    }
}

/// What every mechanism has to be able to do to be a candidate: load a plugin,
/// call one hook, and survive the plugin misbehaving.
pub trait Sandbox: Sized {
    /// Source in whatever the mechanism eats: JS text, wat or wasm bytes, a
    /// path to an executable.
    fn load(manifest: Manifest, source: &[u8]) -> Result<Self, Failure>;

    fn call_command(&mut self, call: &CommandCall) -> Result<String, Failure>;

    /// Messages the plugin asked the host to send. Populated only if the
    /// manifest grants `SendMessages`; the point is to show the host function
    /// is the only way out.
    fn outbox(&self) -> Vec<String>;
}

/// The plugins, compiled in so nothing has to find a file at runtime.
pub mod fixtures {
    macro_rules! js {
        ($name:literal) => {
            include_str!(concat!("../plugins/js/", $name, ".js"))
        };
    }
    macro_rules! wasm {
        ($name:literal) => {
            include_bytes!(concat!("../plugins/wasm/", $name, ".wat"))
        };
    }

    pub const JS_ECHO: &str = js!("echo");
    pub const JS_PANIC: &str = js!("panic");
    pub const JS_LOOP: &str = js!("loop");
    pub const JS_HANG: &str = js!("hang");
    pub const JS_MEMORY: &str = js!("memory");
    pub const JS_REGEX: &str = js!("regex");
    pub const JS_SENDER: &str = js!("sender");

    pub const WASM_ECHO: &[u8] = wasm!("echo");
    pub const WASM_PANIC: &[u8] = wasm!("panic");
    pub const WASM_LOOP: &[u8] = wasm!("loop");
    pub const WASM_MEMORY: &[u8] = wasm!("memory");
    pub const WASM_SENDER: &[u8] = wasm!("sender");

    /// The call every measurement uses.
    pub fn call() -> super::CommandCall {
        super::CommandCall {
            command: "spike".into(),
            args: "hello from the composer".into(),
            channel: "#ircx".into(),
        }
    }
}

/// The four failure modes the requirement names, plus the one that turned out
/// to matter. Each has a per-mechanism plugin under `plugins/`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Misbehaviour {
    /// Uncaught throw, trap, or abort.
    Panic,
    /// A tight loop that never yields.
    InfiniteLoop,
    /// Control returns to the host but no answer ever arrives: an unresolved
    /// promise, a child that reads and never writes.
    Hang,
    /// Allocate until something says no.
    MemoryExhaustion,
    /// A tight loop inside the runtime's own C code rather than in bytecode.
    /// Catastrophic regex backtracking is the classic one; it is here because
    /// an interrupt hook that is only checked between bytecodes does not see it.
    RuntimeLoop,
}

impl Misbehaviour {
    pub const ALL: [Self; 5] = [
        Self::Panic,
        Self::InfiniteLoop,
        Self::Hang,
        Self::MemoryExhaustion,
        Self::RuntimeLoop,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::Panic => "panic",
            Self::InfiniteLoop => "infinite-loop",
            Self::Hang => "hang",
            Self::MemoryExhaustion => "memory-exhaustion",
            Self::RuntimeLoop => "runtime-loop",
        }
    }
}
