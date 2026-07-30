//! WebAssembly, via wasmtime with the Cranelift compiler.
//!
//! Termination rests on epoch interruption. Wasmtime does not watch a clock
//! itself: someone has to call `Engine::increment_epoch`, and a store whose
//! deadline has passed traps at the next loop back-edge or function entry. The
//! ticker here only runs while a call is in flight, so an idle client does no
//! wakeups — a background thread ticking every 10 ms forever would be a real
//! cost on a laptop and is not necessary.
//!
//! Memory is capped by `StoreLimits`. A guest over the cap does not trap; its
//! `memory.grow` returns -1 and it carries on with what it has, which is a
//! different shape of answer from the other two mechanisms.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use wasmtime::{Caller, Config, Engine, Instance, Linker, Memory, Module, Store, StoreLimits};

use crate::{CommandCall, Failure, Manifest, Permission, Sandbox};

const ARG_PTR: i32 = 2048;
const REPLY_PTR: usize = 1024;

struct State {
    limits: StoreLimits,
    outbox: Vec<String>,
}

/// What the ticker thread is waiting for. It sleeps on the condvar until a
/// call arms a deadline, and exits when the sandbox it belongs to is dropped.
#[derive(Clone, Copy)]
enum Watch {
    Idle,
    Until(Instant),
    Stop,
}

type Clock = Arc<(Mutex<Watch>, Condvar)>;

pub struct WasmSandbox {
    store: Store<State>,
    instance: Instance,
    memory: Memory,
    manifest: Manifest,
    clock: Clock,
}

impl WasmSandbox {
    /// The engine and its compiler. Separated from `load` because this is the
    /// part that is per-process rather than per-plugin, and so the part a
    /// lazily built runtime would defer.
    pub fn engine() -> Result<Engine, Failure> {
        let mut config = Config::new();
        config.epoch_interruption(true);
        Engine::new(&config).map_err(|e| Failure::Host(e.to_string()))
    }

    fn ticker(engine: Engine) -> Clock {
        let clock: Clock = Arc::new((Mutex::new(Watch::Idle), Condvar::new()));
        let watched = Arc::clone(&clock);
        std::thread::spawn(move || {
            let (lock, cv) = &*watched;
            let mut state = lock.lock().expect("deadline mutex");
            loop {
                match *state {
                    Watch::Stop => return,
                    Watch::Idle => state = cv.wait(state).expect("deadline mutex"),
                    Watch::Until(at) => {
                        let left = at.saturating_duration_since(Instant::now());
                        if left.is_zero() {
                            engine.increment_epoch();
                            *state = Watch::Idle;
                        } else {
                            state = cv.wait_timeout(state, left).expect("deadline mutex").0;
                        }
                    }
                }
            }
        });
        clock
    }

    fn set_watch(&self, to: Watch) {
        let (lock, cv) = &*self.clock;
        *lock.lock().expect("deadline mutex") = to;
        cv.notify_one();
    }

    /// Bytes of linear memory the guest actually holds. The point of the
    /// memory-exhaustion case: the number stays under the manifest's limit.
    pub fn memory_bytes(&self) -> usize {
        self.memory.data_size(&self.store)
    }

    fn classify(err: &wasmtime::Error) -> Failure {
        match err.downcast_ref::<wasmtime::Trap>() {
            Some(wasmtime::Trap::Interrupt) => Failure::Timeout,
            Some(other) => Failure::Raised(other.to_string()),
            None => Failure::Raised(err.to_string()),
        }
    }
}

impl WasmSandbox {
    /// Cranelift output for a module, as it would be cached at install time.
    /// The point of measuring this separately: compiling is the expensive part
    /// of loading a wasm plugin, and it does not have to happen at launch.
    pub fn precompile(source: &[u8]) -> Result<Vec<u8>, Failure> {
        Self::engine()?
            .precompile_module(source)
            .map_err(|e| Failure::Host(e.to_string()))
    }

    /// Load from `precompile` output rather than from wasm.
    ///
    /// # Safety
    ///
    /// Wasmtime trusts these bytes the way it trusts its own compiler output;
    /// they have to come from the same wasmtime on the same machine, which
    /// means a cache the app controls, never a file a plugin ships.
    pub unsafe fn load_precompiled(manifest: Manifest, cwasm: &[u8]) -> Result<Self, Failure> {
        let engine = Self::engine()?;
        let module = unsafe { Module::deserialize(&engine, cwasm) }
            .map_err(|e| Failure::Host(e.to_string()))?;
        Self::from_module(manifest, engine, module)
    }

    fn from_module(manifest: Manifest, engine: Engine, module: Module) -> Result<Self, Failure> {
        let limits = wasmtime::StoreLimitsBuilder::new()
            .memory_size(manifest.memory_limit)
            .instances(1)
            .build();
        let mut store = Store::new(
            &engine,
            State {
                limits,
                outbox: Vec::new(),
            },
        );
        store.limiter(|s| &mut s.limits);
        store.set_epoch_deadline(1);

        let mut linker = Linker::new(&engine);
        // The import exists only if the manifest asked for it. A plugin that
        // wants to send without the grant fails to instantiate: there is no
        // check to get past, the function is not there.
        if manifest.grants(&Permission::SendMessages) {
            linker
                .func_wrap(
                    "host",
                    "send",
                    |mut caller: Caller<'_, State>, ptr: i32, len: i32| {
                        let mem = match caller.get_export("memory").and_then(|e| e.into_memory()) {
                            Some(m) => m,
                            None => return,
                        };
                        let mut buf = vec![0u8; len.max(0) as usize];
                        if mem.read(&mut caller, ptr.max(0) as usize, &mut buf).is_ok() {
                            let line = String::from_utf8_lossy(&buf).into_owned();
                            caller.data_mut().outbox.push(line);
                        }
                    },
                )
                .map_err(|e| Failure::Host(e.to_string()))?;
        }

        let clock = Self::ticker(engine);
        let instance = linker.instantiate(&mut store, &module).map_err(|e| {
            let text = e.to_string();
            if text.contains("unknown import") {
                Failure::Denied(text)
            } else {
                Failure::Host(text)
            }
        })?;
        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| Failure::Host("plugin exports no memory".into()))?;

        Ok(Self {
            store,
            instance,
            memory,
            manifest,
            clock,
        })
    }
}

impl Sandbox for WasmSandbox {
    fn load(manifest: Manifest, source: &[u8]) -> Result<Self, Failure> {
        let engine = Self::engine()?;
        let module = Module::new(&engine, source).map_err(|e| Failure::Host(e.to_string()))?;
        Self::from_module(manifest, engine, module)
    }

    fn call_command(&mut self, call: &CommandCall) -> Result<String, Failure> {
        let arg = serde_json::to_string(call).map_err(|e| Failure::Host(e.to_string()))?;
        self.memory
            .write(&mut self.store, ARG_PTR as usize, arg.as_bytes())
            .map_err(|e| Failure::Host(e.to_string()))?;

        let hook = self
            .instance
            .get_typed_func::<(i32, i32), i32>(&mut self.store, "on_command")
            .map_err(|e| Failure::Host(e.to_string()))?;

        self.store.set_epoch_deadline(1);
        self.set_watch(Watch::Until(Instant::now() + self.manifest.call_timeout));
        let out = hook.call(&mut self.store, (ARG_PTR, arg.len() as i32));
        self.set_watch(Watch::Idle);

        let len = out.map_err(|e| Self::classify(&e))? as usize;
        let mut buf = vec![0u8; len];
        self.memory
            .read(&self.store, REPLY_PTR, &mut buf)
            .map_err(|e| Failure::Host(e.to_string()))?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    fn outbox(&self) -> Vec<String> {
        self.store.data().outbox.clone()
    }
}

impl Drop for WasmSandbox {
    fn drop(&mut self) {
        self.set_watch(Watch::Stop);
    }
}
