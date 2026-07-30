//! Building plugins the way an author would ship them, so the tests go through
//! the manifest and the install path rather than around them.
//!
//! Each fixture under `plugins/` registers a command named after its file, and
//! is installed under that name, so two plugins in one test never contend for
//! the same command.

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ircx_plugin::{CommandRequest, CommandSpec, Fetched, Fetcher, Grants, Manifest, Permission};

pub const TARGET: &str = "#ircx";

/// Writes a plugin into a directory of its own under `root` and returns it,
/// ready for `PluginRuntime::install`. The plugin's id is also its command.
pub fn author(root: &Path, id: &str, source: &str, requests: Grants) -> PathBuf {
    let manifest = Manifest {
        id: id.to_owned(),
        name: format!("{id} for tests"),
        version: "1.0.0".into(),
        description: String::new(),
        entry: "main.js".into(),
        commands: match requests.holds(Permission::AddCommands) {
            true => vec![CommandSpec {
                name: id.to_owned(),
                summary: format!("what {id} does"),
            }],
            false => Vec::new(),
        },
        requests,
    };
    let directory = root.join(format!("{id}-source"));
    fs::create_dir_all(&directory).expect("a test can write to its own temporary directory");
    let json = serde_json::to_vec_pretty(&manifest).expect("a manifest serialises");
    fs::write(directory.join("plugin.json"), json).expect("write the manifest");
    fs::write(directory.join("main.js"), source).expect("write the code");
    directory
}

/// A grant set, as the install dialogue would hand one over.
pub fn grants(permissions: &[Permission]) -> Grants {
    Grants {
        permissions: permissions.iter().copied().collect(),
        channels: Vec::new(),
        hosts: Vec::new(),
    }
}

pub fn in_channels(mut grants: Grants, channels: &[&str]) -> Grants {
    grants.permissions.insert(Permission::AccessChannels);
    grants.channels = channels.iter().map(|name| (*name).to_owned()).collect();
    grants
}

pub fn on_hosts(mut grants: Grants, hosts: &[&str]) -> Grants {
    grants.permissions.insert(Permission::NetworkRequests);
    grants.hosts = hosts.iter().map(|name| (*name).to_owned()).collect();
    grants
}

/// A host that answers every request the same way and remembers what it was
/// asked for. `ircx-net` owns the real socket; what the sandbox decides before
/// a request gets this far is what these tests are about.
#[derive(Clone, Default)]
pub struct Requests(Arc<Mutex<Vec<(String, Duration)>>>);

impl Requests {
    pub fn seen(&self) -> Vec<(String, Duration)> {
        self.0.lock().map(|seen| seen.clone()).unwrap_or_default()
    }

    pub fn fetcher(&self, body: &str) -> Fetcher {
        let seen = Arc::clone(&self.0);
        let body = body.to_owned();
        Arc::new(move |request| {
            if let Ok(mut seen) = seen.lock() {
                seen.push((request.url.clone(), request.budget));
            }
            Ok(Fetched {
                status: 200,
                body: body.clone(),
            })
        })
    }
}

pub fn call(command: &str, args: &str) -> CommandRequest {
    CommandRequest {
        command: command.to_owned(),
        args: args.to_owned(),
        target: TARGET.into(),
        nick: "sykk".into(),
        messages: Vec::new(),
    }
}
