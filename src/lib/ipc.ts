import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AppSnapshot,
  Attachment,
  ChatMessage,
  CommandOutcome,
  HistoryRequest,
  InstalledPlugin,
  IrcxEvent,
  Member,
  NetworkConfig,
  PluginGrants,
  PluginPermissionInfo,
  Query,
  SearchHit,
  SearchRequest,
  ThemeSource,
} from "@/types";
import { SERVER_TARGET } from "@/types";

const EVENT_CHANNEL = "ircx://event";
const THEMES_CHANNEL = "ircx://themes";

/** A channel or a nick — something the server will accept as a recipient. */
function isConversation(target: string): boolean {
  return target !== "" && target !== SERVER_TARGET;
}

/** Mirrors the Rust handlers in `src-tauri/src/commands.rs`. */
export const ipc = {
  getSnapshot: () => invoke<AppSnapshot>("get_snapshot"),
  listNetworkConfigs: () => invoke<NetworkConfig[]>("list_network_configs"),
  saveNetwork: (config: NetworkConfig) =>
    invoke<string>("save_network", { config }),
  removeNetwork: (network: string) => invoke<void>("remove_network", { network }),

  connectNetwork: (network: string) => invoke<void>("connect_network", { network }),
  disconnectNetwork: (network: string, quitMessage?: string) =>
    invoke<void>("disconnect_network", { network, quitMessage: quitMessage ?? null }),

  joinChannel: (network: string, channel: string, key?: string) =>
    invoke<void>("join_channel", { network, channel, key: key ?? null }),
  openQuery: (network: string, nick: string) =>
    invoke<Query>("open_query", { network, nick }),
  closeTarget: (network: string, target: string) =>
    invoke<void>("close_target", { network, target }),

  /** `replyTo` is the server msgid this message answers, and follows the same
   * rule as `react` below: only a server-given id names something another
   * client can resolve. */
  submitInput: (network: string, target: string, input: string, replyTo?: string) =>
    invoke<CommandOutcome>("submit_input", {
      network,
      target,
      input,
      replyTo: replyTo ?? null,
    }),
  /** Reacting has no command of its own: it is `/react`, spelled here so the
   * timeline does not have to know it. `message` is the server msgid — a
   * locally minted id names nothing anyone else can resolve, so the caller
   * checks `idIsLocal` before offering the control. */
  react: (network: string, target: string, message: string, emoji: string, active: boolean) =>
    invoke<CommandOutcome>("submit_input", {
      network,
      target,
      input: `${active ? "/react" : "/unreact"} ${message} ${emoji}`,
      replyTo: null,
    }),

  listMembers: (network: string, channel: string) =>
    invoke<Member[]>("list_members", { network, channel }),
  loadHistory: (req: HistoryRequest) => invoke<ChatMessage[]>("load_history", { req }),
  searchHistory: (req: SearchRequest) => invoke<SearchHit[]>("search_history", { req }),
  markRead: (network: string, target: string) =>
    invoke<void>("mark_read", { network, target }),
  /** Silent for anything that is not a conversation. A typing notification is a
   * `TAGMSG` addressed to the target, and the server console has no recipient
   * to address: sending one earns a `411` per keystroke. */
  setTyping: (network: string, target: string, active: boolean) =>
    isConversation(target)
      ? invoke<void>("set_typing", { network, target, active })
      : Promise.resolve(),

  loadPreview: (url: string) => invoke<Attachment>("load_preview", { url }),
  getDraft: (network: string, target: string) =>
    invoke<string | null>("get_draft", { network, target }),
  setDraft: (network: string, target: string, text: string) =>
    invoke<void>("set_draft", { network, target, text }),

  listThemes: () => invoke<ThemeSource[]>("list_themes"),

  listPlugins: () => invoke<InstalledPlugin[]>("list_plugins"),
  /** The plain-terms line each permission is shown as. Written in
   * `ircx-plugin`, not here, so the wording has one home. */
  pluginPermissions: () => invoke<PluginPermissionInfo[]>("plugin_permissions"),
  /** `source` is a folder holding a `plugin.json` and its script. Installing
   * grants nothing; the returned plugin says what it asked for. */
  installPlugin: (source: string) => invoke<InstalledPlugin>("install_plugin", { source }),
  /** The whole grant set, not a change to it: revoking is granting less. */
  setPluginGrants: (plugin: string, grants: PluginGrants) =>
    invoke<InstalledPlugin>("set_plugin_grants", { plugin, grants }),
  removePlugin: (plugin: string) => invoke<void>("remove_plugin", { plugin }),
};

/**
 * Hands a URL to the system browser.
 *
 * A link in a message is a link to somewhere else, and the one thing it must
 * never do is navigate this window: the webview is the client, and a page
 * loaded over it has no way back. `target="_blank"` is not that guarantee —
 * what a webview does with it is the webview's business — so the destination
 * leaves through the opener, which is a different process by construction.
 *
 * The opener refuses a URL its capability does not cover, and `openUrl` says so
 * by throwing. Callers report it rather than discarding it: `allow-open-url`
 * without `allow-default-urls` denies every `https://` link, and a swallowed
 * rejection is how that went unnoticed until somebody clicked one.
 */
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}

/** The native folder picker, or null if it was dismissed. Wrapped here for the
 * reason `invoke` is: a component does not reach for a Tauri plugin itself. */
export async function chooseFolder(title: string): Promise<string | null> {
  const picked = await open({ directory: true, title });
  return typeof picked === "string" ? picked : null;
}

/** Resolves to an unsubscribe function. */
/** The backend delivers a window's worth of events as one message, so the
 * handler takes the batch and the store writes once for it. */
export function onIrcxEvent(handler: (events: IrcxEvent[]) => void) {
  return listen<IrcxEvent[]>(EVENT_CHANNEL, (e) => handler(e.payload));
}

/** Fires with the whole themes directory whenever a file in it changes. */
export function onThemesChanged(handler: (themes: ThemeSource[]) => void) {
  return listen<ThemeSource[]>(THEMES_CHANNEL, (e) => handler(e.payload));
}
