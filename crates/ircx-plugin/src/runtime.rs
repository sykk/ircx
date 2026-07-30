//! The part of the plugin system the application talks to: what is installed,
//! what it was granted, which slash command belongs to which plugin, and one
//! call into a plugin that always comes back.
//!
//! Each plugin runs on its own thread and is spoken to over a channel, so the
//! caller never holds a QuickJS runtime and a plugin that will not come back
//! cannot take a caller's thread with it. Threads are spawned on a plugin's
//! first call, so installing a plugin and never using it costs a directory
//! entry, and having none costs nothing at all.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::library::{Installed, Library, LibraryError};
use crate::manifest::{Grants, Permission};
use crate::net::Fetcher;
use crate::sandbox::Sandbox;
use crate::{CommandReply, CommandRequest, Failure, Limits, PluginFailure};

/// Which plugin owns a slash command, and what it was granted at the moment
/// the command was typed. Cheap to hand out: routing must not start a runtime.
#[derive(Debug, Clone)]
pub struct Route {
    pub plugin: String,
    pub command: String,
    grants: Grants,
}

impl Route {
    /// Whether this plugin should be handed the recent messages of `target`.
    /// The caller reads the archive only when this says so, so an ungranted
    /// plugin costs no query.
    pub fn reads_messages(&self, target: &str) -> bool {
        self.grants.holds(Permission::ReadMessages) && self.grants.reaches(target)
    }
}

pub struct PluginRuntime {
    library: Mutex<Library>,
    routes: Mutex<HashMap<String, Route>>,
    workers: Mutex<HashMap<String, Arc<Mutex<Worker>>>>,
    limits: Limits,
    /// How a plugin granted `network-requests` reaches the network. Handed in,
    /// because `ircx-net` owns every outbound socket. `net::refuses` is the one
    /// for a host that makes no requests.
    fetch: Fetcher,
}

impl PluginRuntime {
    /// Reads what is installed under `root`. A missing directory is the
    /// ordinary case and is not an error.
    pub fn open(root: PathBuf, limits: Limits, fetch: Fetcher) -> Result<Self, LibraryError> {
        let library = Library::open(root)?;
        let routes = routes_of(&library);
        Ok(Self {
            library: Mutex::new(library),
            routes: Mutex::new(routes),
            workers: Mutex::new(HashMap::new()),
            limits,
            fetch,
        })
    }

    pub fn installed(&self) -> Vec<Installed> {
        hold(&self.library).installed()
    }

    /// Copies a plugin into the library. It is granted nothing until
    /// [`PluginRuntime::set_grants`] is called with what the user allowed.
    pub fn install(&self, source: &Path) -> Result<Installed, LibraryError> {
        let mut library = hold(&self.library);
        let installed = library.install(source)?;
        self.stop(installed.id());
        *hold(&self.routes) = routes_of(&library);
        Ok(installed)
    }

    /// Grants exactly what it is given, so revoking is granting less. The
    /// plugin's runtime is thrown away, because a running one holds the
    /// surface it was loaded with.
    pub fn set_grants(&self, id: &str, grants: Grants) -> Result<Installed, LibraryError> {
        let mut library = hold(&self.library);
        let installed = library.set_grants(id, grants)?;
        self.stop(id);
        *hold(&self.routes) = routes_of(&library);
        Ok(installed)
    }

    pub fn remove(&self, id: &str) -> Result<(), LibraryError> {
        let mut library = hold(&self.library);
        library.remove(id)?;
        self.stop(id);
        *hold(&self.routes) = routes_of(&library);
        Ok(())
    }

    /// The plugin that owns `/command`, if one does. A command belongs to a
    /// plugin only while that plugin holds `add-commands`: withdrawing the
    /// grant takes the command out of the client.
    pub fn route(&self, command: &str) -> Option<Route> {
        hold(&self.routes)
            .get(&command.to_ascii_lowercase())
            .cloned()
    }

    /// Runs one command in the plugin that owns it. Blocking, and bounded: it
    /// returns within the call deadline plus the grace the limits allow,
    /// whatever the plugin does.
    pub fn run(
        &self,
        route: &Route,
        request: CommandRequest,
    ) -> Result<CommandReply, PluginFailure> {
        let named = |failure| PluginFailure {
            plugin: route.plugin.clone(),
            failure,
        };
        let worker = self.worker(&route.plugin).map_err(named)?;
        let (reply, answer) = mpsc::channel();
        let job = Job { request, reply };

        let outcome = {
            let worker = hold(&worker);
            match worker.jobs.send(job) {
                Ok(()) => answer.recv_timeout(self.limits.call + self.limits.grace),
                Err(_) => Err(RecvTimeoutError::Disconnected),
            }
        };

        match outcome {
            Ok(result) => result.map_err(named),
            // Nothing the interpreter can see is still running, so the thread
            // is parked somewhere the deadline could not reach — a host
            // function that did not come back. Quarantine it: the plugin is
            // dropped, its thread is left to finish on its own, and the next
            // call gets a new one.
            Err(RecvTimeoutError::Timeout) => {
                self.stop(&route.plugin);
                Err(named(Failure::Unresponsive))
            }
            Err(RecvTimeoutError::Disconnected) => {
                self.stop(&route.plugin);
                Err(named(Failure::Host("its runtime stopped".into())))
            }
        }
    }

    /// The library lock is taken before the worker map's and never the other
    /// way round, so installing while a command runs cannot deadlock the two.
    ///
    /// It is held across the insert as well: reading what a plugin was allowed
    /// and spawning the thread that enforces it are one step. A `set_grants`
    /// landing between them would leave a worker holding withdrawn grants for
    /// every later call to reuse.
    fn worker(&self, id: &str) -> Result<Arc<Mutex<Worker>>, Failure> {
        if let Some(worker) = hold(&self.workers).get(id) {
            return Ok(Arc::clone(worker));
        }
        let library = hold(&self.library);
        let installed = library
            .get(id)
            .cloned()
            .ok_or_else(|| Failure::Host("it is not installed".into()))?;

        let mut workers = hold(&self.workers);
        let worker = workers.entry(id.to_owned()).or_insert_with(|| {
            let worker = Worker::spawn(installed, self.limits, Arc::clone(&self.fetch));
            Arc::new(Mutex::new(worker))
        });
        Ok(Arc::clone(worker))
    }

    /// Drops the plugin's worker. The thread ends when it next looks for work,
    /// or never, if it is wedged — either way nothing waits for it here.
    fn stop(&self, id: &str) {
        hold(&self.workers).remove(id);
    }
}

fn routes_of(library: &Library) -> HashMap<String, Route> {
    let mut routes = HashMap::new();
    for installed in library.installed() {
        if !installed.grants.holds(Permission::AddCommands) {
            continue;
        }
        for command in &installed.manifest.commands {
            routes.insert(
                command.name.to_ascii_lowercase(),
                Route {
                    plugin: installed.id().to_owned(),
                    command: command.name.to_ascii_lowercase(),
                    grants: installed.grants.clone(),
                },
            );
        }
    }
    routes
}

/// A lock this crate holds is only ever held around a map or a channel send,
/// and nothing under one can panic, so a poisoned lock means some other thread
/// died holding it and the data behind it is still whole.
fn hold<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Job {
    request: CommandRequest,
    reply: Sender<Result<CommandReply, Failure>>,
}

struct Worker {
    jobs: Sender<Job>,
}

impl Worker {
    fn spawn(installed: Installed, limits: Limits, fetch: Fetcher) -> Self {
        let (jobs, inbox) = mpsc::channel();
        let name = format!("ircx-plugin-{}", installed.id());
        // A thread that cannot be spawned shows up as a send failure on the
        // first job, which is the same path as a plugin whose thread died.
        let _ = std::thread::Builder::new()
            .name(name)
            .stack_size(2 * 1024 * 1024)
            .spawn(move || work(installed, limits, fetch, inbox));
        Self { jobs }
    }
}

/// The plugin's whole life. The runtime is built here, on this thread, and
/// never leaves it.
fn work(installed: Installed, limits: Limits, fetch: Fetcher, jobs: Receiver<Job>) {
    let mut sandbox: Option<Sandbox> = None;

    while let Ok(job) = jobs.recv() {
        let loaded = match sandbox.take() {
            Some(ready) => Ok(ready),
            None => load(&installed, limits, Arc::clone(&fetch)),
        };
        let outcome = match loaded {
            Ok(mut ready) => {
                let outcome = ready.call(&job.request);
                // A terminated runtime is not asked for more work. Dropping it
                // here is what makes the next use of the command a fresh
                // plugin rather than a dead one.
                match &outcome {
                    Err(Failure::Timeout | Failure::OutOfMemory) => {}
                    _ => sandbox = Some(ready),
                }
                outcome
            }
            Err(failure) => Err(failure),
        };
        if job.reply.send(outcome).is_err() {
            // The caller gave up on this plugin, so it has been quarantined
            // and nothing will read another answer from it.
            return;
        }
    }
}

fn load(installed: &Installed, limits: Limits, fetch: Fetcher) -> Result<Sandbox, Failure> {
    let source = std::fs::read_to_string(installed.entry())
        .map_err(|error| Failure::Host(format!("its code could not be read: {error}")))?;
    Sandbox::load(
        &installed.grants,
        limits,
        fetch,
        &source,
        installed.data_file(),
    )
}
