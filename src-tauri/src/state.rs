use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use ircx_core::{
    chosen_grants, describe_plugin, spawn_network_with_plugins, LibraryError, NetworkHandle,
    PluginRuntime, SessionCommand, SessionConfig,
};
use ircx_ipc::{
    AppSnapshot, ConnectionStatus, InstalledPlugin, IrcxEvent, Network, NetworkConfig, NetworkId,
    PluginGrants, SaslStatus, Severity,
};
use ircx_store::{Store, StoreError};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tracing::warn;

/// How long a command waits for its network task before reporting the network
/// as unresponsive. Long enough to cover a busy archive write, short enough
/// that the UI does not appear to hang.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);
/// Ceiling on how long closing the app waits for QUIT to reach the servers.
const SHUTDOWN_GRACE: Duration = Duration::from_millis(1_500);
const DEFAULT_QUIT: &str = "ircx";

pub struct App {
    store: Arc<Store>,
    events: mpsc::Sender<IrcxEvent>,
    /// `None` when the plugin library could not be opened. The client runs
    /// without it: an unreadable folder is not a reason to lose the client.
    plugins: Option<Arc<PluginRuntime>>,
    /// The lock is held only long enough to clone a command sender out or to
    /// swap a handle. Every `.await` in this file happens after the guard has
    /// been dropped: Tauri runs commands concurrently, so a guard living
    /// across a send would let one blocked network stall every other command.
    networks: Mutex<HashMap<NetworkId, NetworkHandle>>,
}

impl App {
    pub fn new(
        store: Arc<Store>,
        events: mpsc::Sender<IrcxEvent>,
        plugins: Option<Arc<PluginRuntime>>,
    ) -> Self {
        Self {
            store,
            events,
            plugins,
            networks: Mutex::new(HashMap::new()),
        }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Loads every configured network into the frontend and dials the ones the
    /// user asked to start with.
    pub async fn start(&self) {
        let configs = match self.store.list_networks() {
            Ok(configs) => configs,
            Err(error) => {
                warn!(%error, "could not read the network list");
                self.publish(IrcxEvent::Notice {
                    network: None,
                    severity: Severity::Error,
                    text: "Your saved networks could not be read".into(),
                    detail: Some(error.to_string()),
                })
                .await;
                return;
            }
        };

        for config in configs {
            let Some(id) = config.id.clone() else {
                continue;
            };
            self.publish(IrcxEvent::NetworkUpdated {
                network: offline(&id, &config),
            })
            .await;

            if config.auto_connect {
                if let Err(text) = self.connect(&id).await {
                    self.publish(IrcxEvent::Notice {
                        network: Some(id),
                        severity: Severity::Error,
                        text,
                        detail: None,
                    })
                    .await;
                }
            }
        }
    }

    /// Every configured network, live state where there is a session and a
    /// disconnected placeholder where there is not.
    pub async fn snapshot(&self) -> Result<AppSnapshot, String> {
        let configs = self.store.list_networks().map_err(describe)?;
        let mut snapshot = AppSnapshot {
            networks: Vec::new(),
            channels: Vec::new(),
            queries: Vec::new(),
        };

        for config in configs {
            let Some(id) = config.id.clone() else {
                continue;
            };
            match self
                .ask(&id, |reply| SessionCommand::Snapshot { reply })
                .await
            {
                Ok((network, mut channels, mut queries)) => {
                    snapshot.networks.push(network);
                    snapshot.channels.append(&mut channels);
                    snapshot.queries.append(&mut queries);
                }
                Err(_) => snapshot.networks.push(offline(&id, &config)),
            }
        }

        Ok(snapshot)
    }

    pub async fn connect(&self, network: &NetworkId) -> Result<(), String> {
        let config = self.config(network)?;
        let password = match config.sasl {
            Some(_) => self.store.sasl_password(network).map_err(describe)?,
            None => None,
        };
        let session = SessionConfig::from_network(network.clone(), &config, password);

        // Spawning under the guard keeps two concurrent connects from leaving
        // an orphaned connection task behind. `spawn_network` does not await.
        let mut networks = self.guard();
        if networks
            .get(network)
            .is_some_and(|handle| !handle.commands().is_closed())
        {
            return Err(format!(
                "Already connected to {} — disconnect it before connecting again",
                config.name
            ));
        }
        networks.insert(
            network.clone(),
            spawn_network_with_plugins(
                session,
                self.store.clone(),
                self.events.clone(),
                self.plugins.clone(),
            ),
        );
        Ok(())
    }

    pub async fn disconnect(
        &self,
        network: &NetworkId,
        quit_message: Option<String>,
    ) -> Result<(), String> {
        let handle = self
            .guard()
            .remove(network)
            .ok_or_else(|| self.not_connected(network))?;

        handle
            .shutdown(Some(quit_message.unwrap_or_else(|| DEFAULT_QUIT.into())))
            .await;
        self.publish(IrcxEvent::ConnectionChanged {
            network: network.clone(),
            status: ConnectionStatus::Disconnected,
        })
        .await;
        Ok(())
    }

    pub async fn save_network(&self, config: NetworkConfig) -> Result<NetworkId, String> {
        let id = self.store.save_network(&config).map_err(describe)?;
        // A running session keeps the settings it connected with, so its own
        // events stay authoritative until the user reconnects it.
        if self.sender(&id).is_none() {
            self.publish(IrcxEvent::NetworkUpdated {
                network: offline(&id, &config),
            })
            .await;
        }
        Ok(id)
    }

    pub async fn remove_network(&self, network: &NetworkId) -> Result<(), String> {
        // Bound first: an `if let` would hold the guard across the shutdown.
        let handle = self.guard().remove(network);
        if let Some(handle) = handle {
            handle.shutdown(Some(DEFAULT_QUIT.into())).await;
        }
        self.store.remove_network(network).map_err(describe)?;
        self.publish(IrcxEvent::NetworkRemoved {
            network: network.clone(),
        })
        .await;
        Ok(())
    }

    pub async fn ask<T, F>(&self, network: &NetworkId, command: F) -> Result<T, String>
    where
        F: FnOnce(oneshot::Sender<T>) -> SessionCommand,
    {
        let sender = self.require(network)?;
        let (reply, answer) = oneshot::channel();
        sender
            .send(command(reply))
            .await
            .map_err(|_| self.not_connected(network))?;

        match timeout(REPLY_TIMEOUT, answer).await {
            Ok(Ok(value)) => Ok(value),
            _ => Err(format!(
                "{} stopped responding — reconnect it and try again",
                self.network_name(network)
            )),
        }
    }

    pub async fn tell(&self, network: &NetworkId, command: SessionCommand) -> Result<(), String> {
        let sender = self.require(network)?;
        sender
            .send(command)
            .await
            .map_err(|_| self.not_connected(network))
    }

    /// For commands whose whole effect is on the server: with no session there
    /// is nobody to tell, and nothing the user could do about it.
    pub async fn tell_if_connected(&self, network: &NetworkId, command: SessionCommand) {
        let Some(sender) = self.sender(network) else {
            return;
        };
        if sender.send(command).await.is_err() {
            warn!(network, "a session ended before it could be told");
        }
    }

    /// Every installed plugin, with what it asks for beside what it was given.
    pub fn list_plugins(&self) -> Result<Vec<InstalledPlugin>, String> {
        Ok(self
            .plugin_runtime()?
            .installed()
            .iter()
            .map(describe_plugin)
            .collect())
    }

    /// Copies a plugin folder into the library. It arrives granted nothing;
    /// what the user allows is a separate decision and a separate call.
    pub fn install_plugin(&self, source: &Path) -> Result<InstalledPlugin, String> {
        let installed = self
            .plugin_runtime()?
            .install(source)
            .map_err(describe_library)?;
        Ok(describe_plugin(&installed))
    }

    /// Writes exactly what it is given, so granting less is how a permission is
    /// taken back and granting nothing turns the plugin off.
    pub fn set_plugin_grants(
        &self,
        plugin: &str,
        grants: PluginGrants,
    ) -> Result<InstalledPlugin, String> {
        let installed = self
            .plugin_runtime()?
            .set_grants(plugin, chosen_grants(grants))
            .map_err(describe_library)?;
        Ok(describe_plugin(&installed))
    }

    pub fn remove_plugin(&self, plugin: &str) -> Result<(), String> {
        self.plugin_runtime()?
            .remove(plugin)
            .map_err(describe_library)
    }

    fn plugin_runtime(&self) -> Result<&PluginRuntime, String> {
        self.plugins.as_deref().ok_or_else(|| {
            "Your plugins folder could not be opened, so plugins are off until ircx is restarted"
                .to_string()
        })
    }

    /// Sends QUIT everywhere and gives the writes a moment to land.
    pub async fn shutdown(&self) {
        let handles: Vec<NetworkHandle> = self.guard().drain().map(|(_, handle)| handle).collect();
        let closing: Vec<_> = handles
            .into_iter()
            .map(|handle| tokio::spawn(handle.shutdown(Some(DEFAULT_QUIT.into()))))
            .collect();

        let _ = timeout(SHUTDOWN_GRACE, async {
            for task in closing {
                let _ = task.await;
            }
        })
        .await;
    }

    async fn publish(&self, event: IrcxEvent) {
        if self.events.send(event).await.is_err() {
            warn!("the event pump stopped before the event could be sent");
        }
    }

    fn guard(&self) -> MutexGuard<'_, HashMap<NetworkId, NetworkHandle>> {
        self.networks.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn sender(&self, network: &NetworkId) -> Option<mpsc::Sender<SessionCommand>> {
        self.guard().get(network).map(NetworkHandle::commands)
    }

    fn require(&self, network: &NetworkId) -> Result<mpsc::Sender<SessionCommand>, String> {
        self.sender(network)
            .ok_or_else(|| self.not_connected(network))
    }

    fn config(&self, network: &NetworkId) -> Result<NetworkConfig, String> {
        self.store
            .list_networks()
            .map_err(describe)?
            .into_iter()
            .find(|config| config.id.as_ref() == Some(network))
            .ok_or_else(|| "That network is no longer configured — add it again".to_string())
    }

    /// The name the user gave the network, falling back to its id if the
    /// config has since been deleted.
    fn network_name(&self, network: &NetworkId) -> String {
        self.config(network)
            .map(|config| config.name)
            .unwrap_or_else(|_| network.clone())
    }

    fn not_connected(&self, network: &NetworkId) -> String {
        format!(
            "Not connected to {} — connect first",
            self.network_name(network)
        )
    }
}

fn offline(id: &NetworkId, config: &NetworkConfig) -> Network {
    Network {
        id: id.clone(),
        name: config.name.clone(),
        host: config.host.clone(),
        port: config.port,
        tls: config.tls,
        status: ConnectionStatus::Disconnected,
        current_nick: None,
        sasl: SaslStatus::NotConfigured,
        caps_enabled: Vec::new(),
        lag_ms: None,
    }
}

/// `StoreError`'s messages are already written as sentences for a person.
pub fn describe(error: StoreError) -> String {
    error.to_string()
}

/// So are `LibraryError`'s.
pub fn describe_library(error: LibraryError) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ircx_core::{network_for_plugins, CommandSpec, Grants, Manifest, PluginLimits};
    use ircx_ipc::{HistoryRequest, PluginPermission, TargetName};
    use std::path::PathBuf;

    /// A network that will never answer: the port refuses immediately, so the
    /// session task is alive and idle in its reconnect wait.
    fn dead_config(name: &str) -> NetworkConfig {
        NetworkConfig {
            id: None,
            name: name.into(),
            host: "127.0.0.1".into(),
            port: 1,
            tls: false,
            tls_verify: false,
            nick: "ircx".into(),
            alt_nicks: vec![],
            username: "ircx".into(),
            realname: "ircx".into(),
            sasl: None,
            connect_commands: vec![],
            autojoin: vec![],
            auto_connect: false,
        }
    }

    /// The event channel has to keep draining: a full one stops every session.
    fn app() -> App {
        App::new(store(), events(), None)
    }

    /// The same, with a plugin library under `root`. The directory does not
    /// exist yet, which is the state a first launch is in.
    fn plugin_app(root: &Path) -> App {
        let runtime = PluginRuntime::open(
            root.join("plugins"),
            PluginLimits::default(),
            network_for_plugins(tokio::runtime::Handle::current()),
        )
        .expect("open the plugin library");
        App::new(store(), events(), Some(Arc::new(runtime)))
    }

    fn store() -> Arc<Store> {
        Arc::new(Store::open_in_memory().expect("in-memory store"))
    }

    fn events() -> mpsc::Sender<IrcxEvent> {
        let (events, mut inbox) = mpsc::channel(256);
        tokio::spawn(async move { while inbox.recv().await.is_some() {} });
        events
    }

    /// A plugin as an author would ship it: a manifest asking for what it needs
    /// and one file of code, in the folder the user would pick. It asks for
    /// `add-commands` and `render-content` and for nothing else, so a grant of
    /// anything else is one the manifest never made.
    fn author(root: &Path, id: &str) -> PathBuf {
        let manifest = Manifest {
            id: id.into(),
            name: format!("{id} for tests"),
            version: "1.0.0".into(),
            description: String::new(),
            entry: "main.js".into(),
            commands: vec![CommandSpec {
                name: id.into(),
                summary: format!("what {id} does"),
            }],
            requests: Grants::command_only(),
        };
        let directory = root.join(format!("{id}-source"));
        std::fs::create_dir_all(&directory).expect("write a plugin");
        let json = serde_json::to_vec(&manifest).expect("a manifest serialises");
        std::fs::write(directory.join("plugin.json"), json).expect("write the manifest");
        std::fs::write(
            directory.join("main.js"),
            format!(r#"ircx.command("{id}", () => "hello");"#),
        )
        .expect("write the code");
        directory
    }

    #[tokio::test]
    async fn a_command_for_an_unconnected_network_names_it() {
        let app = app();
        let id = app.save_network(dead_config("Libera.Chat")).await.unwrap();

        let error = app
            .tell(
                &id,
                SessionCommand::Join {
                    channel: "#ircx".into(),
                    key: None,
                },
            )
            .await
            .unwrap_err();

        assert_eq!(error, "Not connected to Libera.Chat — connect first");
    }

    #[tokio::test]
    async fn the_snapshot_lists_a_configured_network_as_disconnected() {
        let app = app();
        let id = app.save_network(dead_config("Libera.Chat")).await.unwrap();

        let snapshot = app.snapshot().await.unwrap();

        assert_eq!(snapshot.networks.len(), 1);
        let network = &snapshot.networks[0];
        assert_eq!(network.id, id);
        assert_eq!(network.status, ConnectionStatus::Disconnected);
    }

    #[tokio::test]
    async fn connecting_twice_is_refused_rather_than_doubled() {
        let app = app();
        let id = app.save_network(dead_config("Libera.Chat")).await.unwrap();

        app.connect(&id).await.unwrap();
        let error = app.connect(&id).await.unwrap_err();

        assert!(
            error.contains("Already connected to Libera.Chat"),
            "{error}"
        );
        app.shutdown().await;
    }

    #[tokio::test]
    async fn removing_a_network_forgets_its_config() {
        let app = app();
        let id = app.save_network(dead_config("Libera.Chat")).await.unwrap();
        app.connect(&id).await.unwrap();

        app.remove_network(&id).await.unwrap();

        assert!(app.store().list_networks().unwrap().is_empty());
        assert!(app.snapshot().await.unwrap().networks.is_empty());
    }

    /// Installing is not consenting: the plugin arrives with what it asked for
    /// on the record and nothing allowed.
    #[tokio::test]
    async fn an_installed_plugin_is_granted_nothing() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let app = plugin_app(root.path());

        let installed = app.install_plugin(&author(root.path(), "greeter")).unwrap();

        assert_eq!(installed.id, "greeter");
        assert_eq!(
            installed.requests.permissions,
            vec![
                PluginPermission::AddCommands,
                PluginPermission::RenderContent
            ]
        );
        assert_eq!(installed.grants, PluginGrants::default());
        assert_eq!(app.list_plugins().unwrap().len(), 1);
    }

    /// The manifest is the ceiling. A dialogue that offered more than the
    /// plugin asked for would be granting on the user's behalf.
    #[tokio::test]
    async fn granting_what_a_plugin_never_asked_for_is_refused_by_name() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let app = plugin_app(root.path());
        app.install_plugin(&author(root.path(), "greeter")).unwrap();

        let error = app
            .set_plugin_grants(
                "greeter",
                PluginGrants {
                    permissions: vec![PluginPermission::SendMessages],
                    ..PluginGrants::default()
                },
            )
            .unwrap_err();

        assert!(error.contains("greeter"), "{error}");
        assert!(error.contains("send-messages"), "{error}");
        assert_eq!(
            app.list_plugins().unwrap()[0].grants,
            PluginGrants::default(),
            "a refused grant changes nothing"
        );
    }

    /// Revoking is granting less, so it goes through the same call.
    #[tokio::test]
    async fn granting_less_takes_a_permission_back() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let app = plugin_app(root.path());
        let installed = app.install_plugin(&author(root.path(), "greeter")).unwrap();
        app.set_plugin_grants("greeter", installed.requests.clone())
            .unwrap();

        let narrowed = app
            .set_plugin_grants(
                "greeter",
                PluginGrants {
                    permissions: vec![PluginPermission::AddCommands],
                    ..PluginGrants::default()
                },
            )
            .unwrap();

        assert_eq!(
            narrowed.grants.permissions,
            vec![PluginPermission::AddCommands]
        );
        assert_eq!(
            app.list_plugins().unwrap()[0].grants.permissions,
            vec![PluginPermission::AddCommands]
        );
    }

    #[tokio::test]
    async fn a_removed_plugin_is_gone_from_the_list() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let app = plugin_app(root.path());
        app.install_plugin(&author(root.path(), "greeter")).unwrap();

        app.remove_plugin("greeter").unwrap();

        assert!(app.list_plugins().unwrap().is_empty());
        let error = app.remove_plugin("greeter").unwrap_err();
        assert!(error.contains("greeter"), "{error}");
    }

    /// A client whose plugin library could not be opened is still a client.
    #[tokio::test]
    async fn without_a_library_listing_plugins_says_so() {
        let app = app();

        let error = app.list_plugins().unwrap_err();

        assert!(error.contains("plugins folder"), "{error}");
    }

    /// Every handler that touches the network map or the archive, run at once
    /// against a live session. A guard held across a send would hang here.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_commands_do_not_deadlock() {
        let app = Arc::new(app());
        let id = app.save_network(dead_config("Libera.Chat")).await.unwrap();
        app.connect(&id).await.unwrap();

        let mut tasks = Vec::new();
        for n in 0..32 {
            let app = app.clone();
            let id = id.clone();
            tasks.push(tokio::spawn(async move {
                let target: TargetName = format!("#room{}", n % 4);
                app.store().set_draft(&id, &target, "typing").unwrap();
                app.store()
                    .load_history(&HistoryRequest {
                        network: id.clone(),
                        target: target.clone(),
                        before: None,
                        limit: 50,
                    })
                    .unwrap();
                app.tell_if_connected(
                    &id,
                    SessionCommand::MarkRead {
                        target: target.clone(),
                    },
                )
                .await;
                let _: Vec<ircx_ipc::Member> = app
                    .ask(&id, |reply| SessionCommand::Members {
                        channel: target,
                        reply,
                    })
                    .await
                    .unwrap();
                app.snapshot().await.unwrap();
            }));
        }

        let finished = timeout(Duration::from_secs(20), async {
            for task in tasks {
                task.await.expect("a command task panicked");
            }
        })
        .await;

        assert!(finished.is_ok(), "commands did not all finish");
        app.shutdown().await;
    }
}
