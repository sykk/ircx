//! QuickJS, via `rquickjs`. One runtime and one context per plugin.
//!
//! Termination rests on `JS_SetInterruptHandler`, which QuickJS calls every so
//! many bytecodes. That covers a loop written in JS. Whether it covers a loop
//! inside QuickJS's own C — the regex engine — is what `Misbehaviour::RuntimeLoop`
//! is for, and the answer is in `docs/plugin-isolation.md`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rquickjs::{CatchResultExt, Context, Function, Runtime};

use crate::{CommandCall, Failure, Manifest, Permission, Sandbox};

/// What `host.send` throws when the manifest does not grant it. The host
/// recognises it coming back out; a plugin that catches it sees a legible
/// string rather than a QuickJS internal.
const DENIED_SEND: &str = "ircx: this plugin was not granted permission to send messages";

/// The interrupt handler runs on the interpreter's own thread and gets no
/// arguments, so the deadline has to live somewhere it can read cheaply.
/// Nanoseconds since `epoch`, zero meaning "no call in flight".
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
}

pub struct JsSandbox {
    // Field order is the drop order: the context has to go before the runtime.
    context: Context,
    _runtime: Runtime,
    manifest: Manifest,
    deadline: Arc<Deadline>,
    outbox: Arc<Mutex<Vec<String>>>,
    /// Once a call is interrupted or runs out of memory the runtime may be in
    /// a state QuickJS does not promise anything about, so the sandbox refuses
    /// further calls rather than pretending it recovered.
    poisoned: Option<Failure>,
}

impl JsSandbox {
    /// Everything that has to happen before the first call: create the runtime,
    /// create the context, install the host functions. Reported separately from
    /// `eval` because this is the part a plugin-less launch would pay if the
    /// runtime were built eagerly.
    pub fn new(manifest: Manifest) -> Result<Self, Failure> {
        let runtime = Runtime::new().map_err(|e| Failure::Host(e.to_string()))?;
        runtime.set_memory_limit(manifest.memory_limit);
        runtime.set_max_stack_size(256 * 1024);

        let deadline = Arc::new(Deadline {
            epoch: Instant::now(),
            at: AtomicU64::new(0),
        });
        let watch = Arc::clone(&deadline);
        runtime.set_interrupt_handler(Some(Box::new(move || watch.passed())));

        let context = Context::full(&runtime).map_err(|e| Failure::Host(e.to_string()))?;
        let outbox = Arc::new(Mutex::new(Vec::new()));

        let may_send = manifest.grants(&Permission::SendMessages);
        let sink = Arc::clone(&outbox);
        context
            .with(|ctx| {
                let send = Function::new(
                    ctx.clone(),
                    move |ctx: rquickjs::Ctx<'_>, line: String| -> rquickjs::Result<()> {
                        if !may_send {
                            // Thrown, not returned: the plugin can catch it and
                            // degrade, which is the behaviour the spec asks for
                            // when a capability is missing.
                            let message =
                                rquickjs::String::from_str(ctx.clone(), DENIED_SEND)?.into_value();
                            return Err(ctx.throw(message));
                        }
                        sink.lock().expect("outbox mutex").push(line);
                        Ok(())
                    },
                )?;
                let host = rquickjs::Object::new(ctx.clone())?;
                host.set("send", send)?;
                ctx.globals().set("host", host)?;
                Ok::<_, rquickjs::Error>(())
            })
            .map_err(|e| Failure::Host(e.to_string()))?;

        Ok(Self {
            context,
            _runtime: runtime,
            manifest,
            deadline,
            outbox,
            poisoned: None,
        })
    }

    /// QuickJS reports both termination causes as ordinary `InternalError`s, so
    /// the text is all there is to go on.
    fn classify(message: String) -> Failure {
        if message.contains(DENIED_SEND) {
            Failure::Denied("send messages".into())
        } else if message.contains("out of memory") {
            Failure::OutOfMemory
        } else if message.contains("interrupted") {
            Failure::Timeout
        } else {
            Failure::Raised(message)
        }
    }
}

impl Sandbox for JsSandbox {
    fn load(manifest: Manifest, source: &[u8]) -> Result<Self, Failure> {
        let src = String::from_utf8(source.to_vec())
            .map_err(|_| Failure::Host("plugin source is not utf-8".into()))?;
        let me = Self::new(manifest)?;
        // A plugin can loop in its own top level, so loading is on the clock too.
        me.deadline.arm(me.manifest.call_timeout);
        let out = me.context.with(|ctx| {
            ctx.eval::<(), _>(src)
                .catch(&ctx)
                .map_err(|e| e.to_string())
        });
        me.deadline.disarm();
        match out {
            Ok(()) => Ok(me),
            Err(message) => Err(Self::classify(message)),
        }
    }

    fn call_command(&mut self, call: &CommandCall) -> Result<String, Failure> {
        if let Some(dead) = &self.poisoned {
            return Err(dead.clone());
        }
        let arg = serde_json::to_string(call).map_err(|e| Failure::Host(e.to_string()))?;

        self.deadline.arm(self.manifest.call_timeout);
        let out = self.context.with(|ctx| {
            let hook: Function = ctx
                .globals()
                .get("onCommand")
                .map_err(|_| "plugin exports no onCommand".to_string())?;
            hook.call::<_, String>((arg,))
                .catch(&ctx)
                .map_err(|e| e.to_string())
        });
        self.deadline.disarm();

        match out {
            Ok(reply) => Ok(reply),
            Err(message) => {
                let failure = Self::classify(message);
                if matches!(failure, Failure::Timeout | Failure::OutOfMemory) {
                    self.poisoned = Some(failure.clone());
                }
                Err(failure)
            }
        }
    }

    fn outbox(&self) -> Vec<String> {
        self.outbox.lock().expect("outbox mutex").clone()
    }
}
