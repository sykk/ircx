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
    PluginGrants, SaslStatus, Severity, TargetName,
};
use ircx_store::{OpenTarget, Store, StoreError};
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

fn looks_like_channel(target: &str) -> bool {
    target
        .chars()
        .next()
        .is_some_and(|first| matches!(first, '#' | '&' | '+' | '!'))
}

pub struct App {
    store: Arc<Store>,
    /// How many messages the retention window took on this launch. Held rather
    /// than announced: pruning happens before any network exists, so there is
    /// no console to say it in, and the archive sheet is where somebody who set
    /// a window goes looking for its effect.
    pruned: Mutex<u64>,
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
            pruned: Mutex::new(0),
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
        self.prune_the_archive();
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

    /// Applies whatever retention windows are set, before anything is drawn.
    ///
    /// A window is an instruction and acting on it every launch is what the
    /// setting means. It is said rather than done quietly: the first time an
    /// archive shrinks, somebody should be able to find out why, and a count
    /// nobody reads costs nothing.
    fn prune_the_archive(&self) {
        match self.store.prune() {
            Ok(removed) => {
                if let Ok(mut held) = self.pruned.lock() {
                    *held = removed;
                }
            }
            Err(error) => warn!(%error, "could not apply the archive's retention window"),
        }
    }

    /// How many messages the last launch removed, for the one screen that
    /// asked for the window in the first place.
    pub fn pruned_on_launch(&self) -> u64 {
        self.pruned.lock().map(|held| *held).unwrap_or(0)
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

    /// Stopping something already stopped is not an error. A network that keeps
    /// failing alternates between `Failed` and `Reconnecting`, so a user asking
    /// it to stop may well press at a moment when the handle has already gone —
    /// and answering "not connected" to somebody trying to disconnect reads as
    /// a refusal rather than as the thing they wanted.
    pub async fn disconnect(
        &self,
        network: &NetworkId,
        quit_message: Option<String>,
    ) -> Result<(), String> {
        // Bound first: an `if let` would hold the guard across the shutdown.
        let handle = self.guard().remove(network);
        if let Some(handle) = handle {
            handle
                .shutdown(Some(quit_message.unwrap_or_else(|| DEFAULT_QUIT.into())))
                .await;
        }
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
        // One deadline over the enqueue and the answer together. The inbox
        // holds 64 commands, and a session that has stopped draining it —
        // wedged behind the store mutex during an export, say — left the send
        // itself blocking with no bound: the timeout started only after the
        // enqueue, which was the part that hung.
        let asked = async {
            sender
                .send(command(reply))
                .await
                .map_err(|_| self.not_connected(network))?;
            answer.await.map_err(|_| self.stopped_responding(network))
        };
        match timeout(REPLY_TIMEOUT, asked).await {
            Ok(outcome) => outcome,
            Err(_) => Err(self.stopped_responding(network)),
        }
    }

    pub async fn tell(&self, network: &NetworkId, command: SessionCommand) -> Result<(), String> {
        let sender = self.require(network)?;
        // Bounded for the reason `ask` is: the enqueue is the part that hangs.
        match timeout(REPLY_TIMEOUT, sender.send(command)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err(self.not_connected(network)),
            Err(_) => Err(self.stopped_responding(network)),
        }
    }

    /// Parts a channel or closes a query on the server when connected; when
    /// disconnected, drops it from persistence and tells the UI anyway.
    pub async fn close_target(
        &self,
        network: &NetworkId,
        target: &TargetName,
    ) -> Result<(), String> {
        if self.sender(network).is_some() {
            self.tell_if_connected(
                network,
                SessionCommand::CloseTarget {
                    target: target.clone(),
                },
            )
            .await;
            return Ok(());
        }

        let is_channel = self
            .store
            .open_targets(network)
            .map_err(describe)?
            .into_iter()
            .find(|open| open.name() == target)
            .is_some_and(|open| matches!(open, OpenTarget::Channel(_)))
            || looks_like_channel(target);

        self.store
            .forget_target(network, target)
            .map_err(describe)?;

        if is_channel {
            self.publish(IrcxEvent::ChannelRemoved {
                network: network.clone(),
                name: target.clone(),
            })
            .await;
        } else {
            self.publish(IrcxEvent::QueryRemoved {
                network: network.clone(),
                nick: target.clone(),
            })
            .await;
        }
        Ok(())
    }

    /// For commands whose whole effect is on the server: with no session there
    /// is nobody to tell, and nothing the user could do about it.
    pub async fn tell_if_connected(&self, network: &NetworkId, command: SessionCommand) {
        let Some(sender) = self.sender(network) else {
            return;
        };
        match timeout(REPLY_TIMEOUT, sender.send(command)).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => warn!(network, "a session ended before it could be told"),
            Err(_) => warn!(
                network,
                "a session stopped taking commands before it could be told"
            ),
        }
    }

    fn stopped_responding(&self, network: &NetworkId) -> String {
        format!(
            "{} stopped responding — reconnect it and try again",
            self.network_name(network)
        )
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
    pub async fn install_plugin(&self, source: &Path) -> Result<InstalledPlugin, String> {
        let installed = self
            .plugin_runtime()?
            .install(source)
            .map_err(describe_library)?;
        self.plugin_changed(installed.id()).await;
        Ok(describe_plugin(&installed))
    }

    /// Writes exactly what it is given, so granting less is how a permission is
    /// taken back and granting nothing turns the plugin off.
    pub async fn set_plugin_grants(
        &self,
        plugin: &str,
        grants: PluginGrants,
    ) -> Result<InstalledPlugin, String> {
        let installed = self
            .plugin_runtime()?
            .set_grants(plugin, chosen_grants(grants))
            .map_err(describe_library)?;
        self.plugin_changed(plugin).await;
        Ok(describe_plugin(&installed))
    }

    pub async fn remove_plugin(&self, plugin: &str) -> Result<(), String> {
        self.plugin_runtime()?
            .remove(plugin)
            .map_err(describe_library)?;
        self.plugin_changed(plugin).await;
        Ok(())
    }

    /// Writes the words that raise a conversation, then hands them to every
    /// network that has a session.
    ///
    /// A word is trimmed and an empty one dropped here rather than in the
    /// store: the list arrives from a text field, where a blank line is a
    /// keystroke rather than an intention, and a word of no characters would
    /// match nothing anyway.
    ///
    /// The store is written first. A network too busy to be told picks the list
    /// up the next time it starts, and losing the write to save a send nobody
    /// is waiting for would be the wrong way round.
    pub async fn set_highlight_words(&self, words: Vec<String>) -> Result<(), String> {
        let words: Vec<String> = words
            .into_iter()
            .map(|word| word.trim().to_owned())
            .filter(|word| !word.is_empty())
            .collect();
        self.store.set_highlight_words(&words).map_err(describe)?;

        // Collected before the awaits, because `guard` is a std lock. The same
        // shape as `plugin_changed` below, and for the same reason.
        let senders: Vec<_> = self.guard().values().map(NetworkHandle::commands).collect();
        for sender in senders {
            let changed = SessionCommand::HighlightWordsChanged {
                words: words.clone(),
            };
            match timeout(REPLY_TIMEOUT, sender.send(changed)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => warn!("a network stopped before it could be told the words changed"),
                Err(_) => warn!("a network was too busy to be told the words changed"),
            }
        }
        Ok(())
    }

    /// Writes a mute and hands the network its new list.
    ///
    /// One network rather than all of them, unlike the words: a mute names a
    /// conversation on a network, and the others hold nothing that changed.
    pub async fn set_muted(
        &self,
        network: &NetworkId,
        target: Option<&TargetName>,
        muted: bool,
    ) -> Result<(), String> {
        self.store
            .set_muted(network, target.map(String::as_str), muted)
            .map_err(describe)?;
        let held = self.store.muted_targets(network).map_err(describe)?;
        // Not `tell`, which reports a network that is not connected as an
        // error: muting a conversation on a network you are not on is a setting
        // somebody is allowed to change, and the session reads the list when it
        // next starts.
        self.tell_if_connected(network, SessionCommand::MutedChanged { muted: held })
            .await;
        Ok(())
    }

    /// Tells every running network that this plugin's library entry changed, so
    /// a hook it dropped is asked again.
    ///
    /// The strikes belong to a connection and nothing else clears them, so
    /// without this a plugin repaired and installed again stays switched off
    /// until the client restarts — which is the repair nobody tries first.
    ///
    /// Every network rather than the ones the plugin reaches: which channels it
    /// is granted is part of what may just have changed.
    async fn plugin_changed(&self, plugin: &str) {
        // Collected before the awaits, because `guard` is a std lock and the
        // sends are not instant.
        let senders: Vec<_> = self.guard().values().map(NetworkHandle::commands).collect();
        for sender in senders {
            let changed = SessionCommand::PluginChanged {
                plugin: plugin.to_owned(),
            };
            // Bounded so one wedged network cannot hold the news back from
            // every network after it in the map.
            match timeout(REPLY_TIMEOUT, sender.send(changed)).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    warn!(%plugin, "a network stopped before it could be told the plugin changed");
                }
                Err(_) => {
                    warn!(%plugin, "a network was too busy to be told the plugin changed");
                }
            }
        }
    }

    fn plugin_runtime(&self) -> Result<&PluginRuntime, String> {
        self.plugins.as_deref().ok_or_else(|| {
            "Your plugins folder could not be opened, so plugins are off until ircx is restarted"
                .to_string()
        })
    }

    /// Sends QUIT everywhere, gives the goodbyes a moment, and waits for the
    /// archive however long it needs.
    pub async fn shutdown(&self) {
        let handles: Vec<NetworkHandle> = self.guard().drain().map(|(_, handle)| handle).collect();
        let writes: Vec<_> = handles.iter().map(NetworkHandle::writes).collect();
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
        // The grace bounds the goodbye, not the record. A session that could
        // not finish in time still queued its writes, and the writer threads
        // die with the process — leaving now is how what was said would go
        // quietly missing.
        for writer in writes {
            writer.drained().await;
        }
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
            client_certificate: None,
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
            annotates: false,
            notifies: false,
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

    /// #130: a network that keeps failing alternates between `Failed` and
    /// `Reconnecting`, so somebody asking it to stop may press at a moment when
    /// the handle has already gone. Answering "not connected" to that reads as a
    /// refusal rather than as the thing they asked for.
    #[tokio::test]
    async fn disconnecting_something_already_stopped_is_not_an_error() {
        let app = app();
        let id = app.save_network(dead_config("Libera.Chat")).await.unwrap();

        app.disconnect(&id, None).await.expect("nothing to stop");

        app.connect(&id).await.unwrap();
        app.disconnect(&id, None).await.expect("a session to stop");
        app.disconnect(&id, None).await.expect("stopped twice");
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

    /// The removal, whatever came before it. `save_network` publishes a
    /// `NetworkUpdated` of its own, so the closing is not the first thing on
    /// the channel and reading one event reads that one instead.
    async fn removal(inbox: &mut mpsc::Receiver<IrcxEvent>) -> IrcxEvent {
        let waiting = async {
            loop {
                match inbox.recv().await.expect("the channel is still open") {
                    event @ (IrcxEvent::ChannelRemoved { .. } | IrcxEvent::QueryRemoved { .. }) => {
                        return event
                    }
                    _ => continue,
                }
            }
        };
        timeout(Duration::from_secs(5), waiting)
            .await
            .expect("a removal is published")
    }

    #[tokio::test]
    async fn closing_a_channel_while_disconnected_forgets_it_and_reports_it() {
        let (events, mut inbox) = mpsc::channel(16);
        let app = App::new(store(), events, None);
        let id = app.save_network(dead_config("Libera.Chat")).await.unwrap();
        app.store()
            .remember_target(&id, &OpenTarget::Channel("#ircx".into()))
            .unwrap();

        app.close_target(&id, &"#ircx".into()).await.unwrap();

        assert!(app.store().open_targets(&id).unwrap().is_empty());
        assert!(matches!(
            removal(&mut inbox).await,
            IrcxEvent::ChannelRemoved { network, name }
            if network == id && name == "#ircx"
        ));
    }

    #[tokio::test]
    async fn closing_a_query_while_disconnected_forgets_it_and_reports_it() {
        let (events, mut inbox) = mpsc::channel(16);
        let app = App::new(store(), events, None);
        let id = app.save_network(dead_config("Libera.Chat")).await.unwrap();
        app.store()
            .remember_target(&id, &OpenTarget::Query("sable".into()))
            .unwrap();

        app.close_target(&id, &"sable".into()).await.unwrap();

        assert!(app.store().open_targets(&id).unwrap().is_empty());
        assert!(matches!(
            removal(&mut inbox).await,
            IrcxEvent::QueryRemoved { network, nick }
            if network == id && nick == "sable"
        ));
    }

    /// Installing is not consenting: the plugin arrives with what it asked for
    /// on the record and nothing allowed.
    #[tokio::test]
    async fn an_installed_plugin_is_granted_nothing() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let app = plugin_app(root.path());

        let installed = app
            .install_plugin(&author(root.path(), "greeter"))
            .await
            .unwrap();

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
        app.install_plugin(&author(root.path(), "greeter"))
            .await
            .unwrap();

        let error = app
            .set_plugin_grants(
                "greeter",
                PluginGrants {
                    permissions: vec![PluginPermission::SendMessages],
                    ..PluginGrants::default()
                },
            )
            .await
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
        let installed = app
            .install_plugin(&author(root.path(), "greeter"))
            .await
            .unwrap();
        app.set_plugin_grants("greeter", installed.requests.clone())
            .await
            .unwrap();

        let narrowed = app
            .set_plugin_grants(
                "greeter",
                PluginGrants {
                    permissions: vec![PluginPermission::AddCommands],
                    ..PluginGrants::default()
                },
            )
            .await
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
        app.install_plugin(&author(root.path(), "greeter"))
            .await
            .unwrap();

        app.remove_plugin("greeter").await.unwrap();

        assert!(app.list_plugins().unwrap().is_empty());
        let error = app.remove_plugin("greeter").await.unwrap_err();
        assert!(error.contains("greeter"), "{error}");
    }

    /// Changing the library tells every running network, so three calls that
    /// used to touch nothing but files now await a send per network. A session
    /// whose inbox is full stalls them, which the type system has nothing to
    /// say about — holding the guard across the sends is the failure it does
    /// catch, because the future stops being `Send` and Tauri will not take it.
    ///
    /// Bounded, so a regression hangs this rather than the user's client.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn changing_the_library_answers_with_a_network_running() {
        let root = tempfile::tempdir().expect("a temporary directory");
        let app = plugin_app(root.path());
        let id = app.save_network(dead_config("Libera.Chat")).await.unwrap();
        app.connect(&id).await.unwrap();

        let installed = timeout(
            Duration::from_secs(5),
            app.install_plugin(&author(root.path(), "greeter")),
        )
        .await
        .expect("installing answered")
        .unwrap();

        timeout(
            Duration::from_secs(5),
            app.set_plugin_grants("greeter", installed.requests.clone()),
        )
        .await
        .expect("granting answered")
        .unwrap();

        timeout(Duration::from_secs(5), app.remove_plugin("greeter"))
            .await
            .expect("removing answered")
            .unwrap();
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
