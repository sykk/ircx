//! One plugin inside one QuickJS runtime.
//!
//! Termination rests on `JS_SetInterruptHandler`, which QuickJS calls between
//! bytecodes and — in this build, asserted by the tests — from inside the regex
//! engine too. Everything the host hands the plugin goes through the functions
//! installed here, so the permission checks in this file are the whole of what
//! a grant means.
//!
//! The runtime is built on the thread that will use it and never moves.

use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rquickjs::{CatchResultExt, Context, Ctx, Function, Runtime};

use crate::data::LocalData;
use crate::manifest::{Grants, Permission};
use crate::net::{FetchRequest, Fetcher};
use crate::{CommandReply, CommandRequest, Failure, Limits, Outgoing};

/// Deep enough for the recursion a plugin has any business doing, shallow
/// enough that QuickJS unwinds rather than the host thread overflowing.
const STACK_BYTES: usize = 256 * 1024;
/// What a command may put into the conversation. A plugin that returns more
/// than this is truncated rather than terminated: the output is the part the
/// user asked for.
const MAX_OUTPUT_BYTES: usize = 8 * 1024;
const MAX_OUTPUT_LINES: usize = 40;
/// Messages one command may send. A slash command is one user action, and a
/// plugin turning it into a flood is the failure mode the spec names.
const MAX_SENDS: usize = 8;

/// The bootstrap. Everything the plugin sees is built here on top of the
/// functions the host installed, so the ergonomic surface is JavaScript and
/// the enforced surface is Rust.
const BOOTSTRAP: &str = r#"
globalThis.__ircx_commands = Object.create(null);
globalThis.ircx = {
  command(name, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("ircx.command needs a function");
    }
    __ircx_commands[String(name).toLowerCase()] = handler;
  },
  send(target, text) {
    __ircx_send(String(target), String(text));
  },
  fetch(url) {
    return JSON.parse(__ircx_fetch(String(url)));
  },
  store: {
    get(key) {
      return JSON.parse(__ircx_store_get(String(key)));
    },
    set(key, value) {
      __ircx_store_set(String(key), String(value));
    },
    remove(key) {
      __ircx_store_remove(String(key));
    },
    keys() {
      return JSON.parse(__ircx_store_keys());
    },
  },
};
globalThis.__ircx_dispatch = function (name, json) {
  const handler = __ircx_commands[name];
  if (!handler) {
    throw new Error("this plugin registered no handler for /" + name);
  }
  const answer = handler(JSON.parse(json));
  if (answer === undefined || answer === null) {
    return "";
  }
  // Hooks are synchronous on purpose. A promise would be answered by the job
  // queue rather than by anything the deadline can interrupt, so it is refused
  // here rather than turned into the text "[object Promise]".
  const kind = typeof answer;
  if (kind !== "string" && kind !== "number" && kind !== "boolean") {
    throw new TypeError("a command must answer with text now, not with a " + kind);
  }
  return String(answer);
};
"#;

/// The interrupt handler runs on the interpreter's own thread and takes no
/// arguments, so the deadline lives where it can read it cheaply: nanoseconds
/// since `epoch`, zero meaning no call is in flight.
struct Deadline {
    epoch: Instant,
    at: AtomicU64,
}

impl Deadline {
    fn arm(&self, budget: Duration) {
        let at = self.epoch.elapsed() + budget;
        self.at.store(at.as_nanos() as u64, Ordering::Relaxed);
    }

    fn disarm(&self) {
        self.at.store(0, Ordering::Relaxed);
    }

    fn passed(&self) -> bool {
        let at = self.at.load(Ordering::Relaxed);
        at != 0 && self.epoch.elapsed().as_nanos() as u64 > at
    }

    /// What is left of the current call's budget. A host function that has to
    /// wait for anything waits for at most this, which is what keeps a
    /// blocking call inside the deadline the manifest was granted.
    fn remaining(&self) -> Duration {
        let at = Duration::from_nanos(self.at.load(Ordering::Relaxed));
        at.checked_sub(self.epoch.elapsed()).unwrap_or_default()
    }
}

/// Why a host function refused. Recorded on the Rust side rather than read
/// back out of the exception, so a plugin cannot fake a denial by throwing a
/// string that looks like one.
#[derive(Debug, Clone, Copy)]
enum Refusal {
    Denied(Permission),
    Flooded,
}

/// Everything the host functions share. One plugin, one thread, so a `Cell`
/// is all the sharing that is needed.
struct Host {
    grants: Grants,
    outbox: RefCell<Vec<Outgoing>>,
    refusal: Cell<Option<Refusal>>,
    data: RefCell<LocalData>,
    fetch: Fetcher,
    deadline: Arc<Deadline>,
}

impl Host {
    fn deny(&self, ctx: &Ctx<'_>, permission: Permission) -> rquickjs::Error {
        self.refusal.set(Some(Refusal::Denied(permission)));
        // Thrown rather than returned, so a plugin can catch it and degrade
        // instead of dying — the same shape as a missing IRCv3 capability.
        throw(ctx, &format!("ircx: {} was not granted", permission.name()))
    }

    fn refuse(&self, ctx: &Ctx<'_>, refusal: Refusal, message: &str) -> rquickjs::Error {
        self.refusal.set(Some(refusal));
        throw(ctx, message)
    }
}

/// Every refusal a plugin can catch, thrown as an `Error`. A bare string would
/// also be catchable, but `refused.message` is what a JavaScript author writes,
/// and on a string that is `undefined` — a plugin that degrades correctly could
/// not say why.
fn throw(ctx: &Ctx<'_>, message: &str) -> rquickjs::Error {
    rquickjs::Exception::throw_message(ctx, message)
}

pub struct Sandbox {
    // Field order is drop order: the context has to go before the runtime.
    context: Context,
    _runtime: Runtime,
    limits: Limits,
    deadline: Arc<Deadline>,
    host: Rc<Host>,
    /// A runtime interrupted mid-call or out of memory is in a state QuickJS
    /// promises nothing about, so the sandbox refuses further calls rather
    /// than pretending it recovered. The runtime above it loads a fresh one.
    poisoned: Option<Failure>,
}

impl Sandbox {
    /// Builds the runtime, installs the host functions the grants allow, and
    /// runs the plugin's top level under the same deadline a call gets.
    pub fn load(
        grants: &Grants,
        limits: Limits,
        fetch: Fetcher,
        source: &str,
        data_file: PathBuf,
    ) -> Result<Self, Failure> {
        let runtime = Runtime::new().map_err(|error| Failure::Host(error.to_string()))?;
        runtime.set_memory_limit(limits.memory);
        runtime.set_max_stack_size(STACK_BYTES);

        let deadline = Arc::new(Deadline {
            epoch: Instant::now(),
            at: AtomicU64::new(0),
        });
        let watch = Arc::clone(&deadline);
        runtime.set_interrupt_handler(Some(Box::new(move || watch.passed())));

        let context = Context::full(&runtime).map_err(|error| Failure::Host(error.to_string()))?;
        let host = Rc::new(Host {
            grants: grants.clone(),
            outbox: RefCell::new(Vec::new()),
            refusal: Cell::new(None),
            data: RefCell::new(LocalData::open(data_file)),
            fetch,
            deadline: Arc::clone(&deadline),
        });

        let mut me = Self {
            context,
            _runtime: runtime,
            limits,
            deadline,
            host,
            poisoned: None,
        };
        me.install()?;

        // A plugin can loop in its own top level, so loading is on the clock.
        let source = source.to_owned();
        me.under_deadline(|ctx| ctx.eval::<(), _>(source))?;
        Ok(me)
    }

    fn install(&mut self) -> Result<(), Failure> {
        let host = Rc::clone(&self.host);
        self.context
            .with(|ctx| {
                let globals = ctx.globals();

                let send = Rc::clone(&host);
                globals.set(
                    "__ircx_send",
                    Function::new(
                        ctx.clone(),
                        move |ctx: Ctx<'_>, target: String, text: String| -> rquickjs::Result<()> {
                            if !send.grants.holds(Permission::SendMessages) {
                                return Err(send.deny(&ctx, Permission::SendMessages));
                            }
                            if !send.grants.reaches(&target) {
                                return Err(send.deny(&ctx, Permission::AccessChannels));
                            }
                            let mut outbox = send.outbox.borrow_mut();
                            if outbox.len() >= MAX_SENDS {
                                drop(outbox);
                                return Err(send.refuse(
                                    &ctx,
                                    Refusal::Flooded,
                                    "ircx: one command may not send this many messages",
                                ));
                            }
                            outbox.push(Outgoing { target, text });
                            Ok(())
                        },
                    )?,
                )?;

                let get = Rc::clone(&host);
                globals.set(
                    "__ircx_store_get",
                    Function::new(
                        ctx.clone(),
                        move |ctx: Ctx<'_>, key: String| -> rquickjs::Result<String> {
                            if !get.grants.holds(Permission::StoreLocalData) {
                                return Err(get.deny(&ctx, Permission::StoreLocalData));
                            }
                            let value = get.data.borrow().get(&key);
                            Ok(json(&value))
                        },
                    )?,
                )?;

                let set = Rc::clone(&host);
                globals.set(
                    "__ircx_store_set",
                    Function::new(
                        ctx.clone(),
                        move |ctx: Ctx<'_>, key: String, value: String| -> rquickjs::Result<()> {
                            if !set.grants.holds(Permission::StoreLocalData) {
                                return Err(set.deny(&ctx, Permission::StoreLocalData));
                            }
                            set.data
                                .borrow_mut()
                                .set(key, value)
                                .map_err(|error| throw(&ctx, &format!("ircx: {error}")))
                        },
                    )?,
                )?;

                let remove = Rc::clone(&host);
                globals.set(
                    "__ircx_store_remove",
                    Function::new(
                        ctx.clone(),
                        move |ctx: Ctx<'_>, key: String| -> rquickjs::Result<()> {
                            if !remove.grants.holds(Permission::StoreLocalData) {
                                return Err(remove.deny(&ctx, Permission::StoreLocalData));
                            }
                            remove
                                .data
                                .borrow_mut()
                                .remove(&key)
                                .map_err(|error| throw(&ctx, &format!("ircx: {error}")))
                        },
                    )?,
                )?;

                let keys = Rc::clone(&host);
                globals.set(
                    "__ircx_store_keys",
                    Function::new(
                        ctx.clone(),
                        move |ctx: Ctx<'_>| -> rquickjs::Result<String> {
                            if !keys.grants.holds(Permission::StoreLocalData) {
                                return Err(keys.deny(&ctx, Permission::StoreLocalData));
                            }
                            Ok(json(&keys.data.borrow().keys()))
                        },
                    )?,
                )?;

                let fetch = Rc::clone(&host);
                globals.set(
                    "__ircx_fetch",
                    Function::new(
                        ctx.clone(),
                        move |ctx: Ctx<'_>, url: String| -> rquickjs::Result<String> {
                            if !fetch.grants.holds(Permission::NetworkRequests) {
                                return Err(fetch.deny(&ctx, Permission::NetworkRequests));
                            }
                            let host_name = crate::net::host_of(&url)
                                .ok_or_else(|| throw(&ctx, "ircx: that is not a URL"))?;
                            if !fetch.grants.reaches_host(&host_name) {
                                return Err(fetch.deny(&ctx, Permission::NetworkRequests));
                            }
                            // The remaining budget, so a request cannot carry
                            // the call past the deadline it was granted.
                            let request = FetchRequest {
                                url,
                                budget: fetch.deadline.remaining(),
                            };
                            match (fetch.fetch)(request) {
                                Ok(response) => Ok(json(&response)),
                                Err(error) => Err(throw(&ctx, &format!("ircx: {error}"))),
                            }
                        },
                    )?,
                )?;

                ctx.eval::<(), _>(BOOTSTRAP)
            })
            .map_err(|error| Failure::Host(error.to_string()))
    }

    /// Runs one command hook. The reply carries only what the plugin was
    /// granted: messages it asked to send are already checked, and content is
    /// checked here because the plugin returns it rather than asking for it.
    pub fn call(&mut self, request: &CommandRequest) -> Result<CommandReply, Failure> {
        if let Some(dead) = &self.poisoned {
            return Err(dead.clone());
        }
        self.host.refusal.set(None);
        self.host.outbox.borrow_mut().clear();

        // Defence in depth: the runtime above already withholds the history
        // from a plugin that was not granted it.
        let mut request = request.clone();
        let grants = &self.host.grants;
        if !grants.holds(Permission::ReadMessages) || !grants.reaches(&request.target) {
            request.messages.clear();
        }
        let argument =
            serde_json::to_string(&request).map_err(|error| Failure::Host(error.to_string()))?;
        let command = request.command.clone();

        let answer = self.under_deadline(move |ctx| {
            let dispatch: Function = ctx.globals().get("__ircx_dispatch")?;
            dispatch.call::<_, String>((command, argument))
        });

        let sends = std::mem::take(&mut *self.host.outbox.borrow_mut());
        match answer {
            Ok(text) => {
                let content = self.content(text)?;
                Ok(CommandReply { content, sends })
            }
            Err(failure) => {
                if matches!(failure, Failure::Timeout | Failure::OutOfMemory) {
                    self.poisoned = Some(failure.clone());
                }
                Err(failure)
            }
        }
    }

    /// Whatever the plugin returned, made safe to put in the timeline. The
    /// sandbox does not make this safe — the host has to, whatever the
    /// mechanism — so it happens here rather than in the frontend.
    fn content(&self, text: String) -> Result<Option<String>, Failure> {
        if text.trim().is_empty() {
            return Ok(None);
        }
        if !self.host.grants.holds(Permission::RenderContent) {
            return Err(Failure::Denied(Permission::RenderContent));
        }
        let mut content = String::new();
        for line in text.lines().take(MAX_OUTPUT_LINES) {
            if content.len() >= MAX_OUTPUT_BYTES {
                break;
            }
            if !content.is_empty() {
                content.push('\n');
            }
            content.extend(line.chars().filter(|c| !c.is_control()));
        }
        while !content.is_char_boundary(content.len().min(MAX_OUTPUT_BYTES)) {
            content.pop();
        }
        content.truncate(MAX_OUTPUT_BYTES);
        Ok((!content.trim().is_empty()).then_some(content))
    }

    fn under_deadline<T, F>(&self, body: F) -> Result<T, Failure>
    where
        F: FnOnce(Ctx<'_>) -> rquickjs::Result<T>,
    {
        self.deadline.arm(self.limits.call);
        let out = self.context.with(|ctx| {
            body(ctx.clone())
                .catch(&ctx)
                .map_err(|error| error.to_string())
        });
        self.deadline.disarm();
        out.map_err(|message| self.classify(message))
    }

    /// QuickJS reports both termination causes as ordinary `InternalError`s,
    /// so the text is all there is to go on for those two. A refusal is read
    /// from what the host recorded, not from the message.
    fn classify(&self, message: String) -> Failure {
        match self.host.refusal.take() {
            Some(Refusal::Denied(permission)) => return Failure::Denied(permission),
            Some(Refusal::Flooded) => return Failure::Flooded,
            None => {}
        }
        if message.contains("out of memory") {
            Failure::OutOfMemory
        } else if message.contains("interrupted") {
            Failure::Timeout
        } else {
            Failure::Raised(message)
        }
    }
}

fn json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}
