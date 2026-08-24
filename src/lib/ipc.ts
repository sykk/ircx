import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type {
  ArchiveScope,
  ArchiveSummary,
  AppSnapshot,
  Attachment,
  ChatMessage,
  CommandOutcome,
  FileToUpload,
  HistoryRequest,
  IgnoredPerson,
  InstalledPlugin,
  IrcxEvent,
  Member,
  MutedConversation,
  NetworkConfig,
  PageBackOutcome,
  PluginGrants,
  PluginPermissionInfo,
  Query,
  SearchHit,
  SearchRequest,
  ThemeSource,
  UploadProvider,
  UploadedFile,
  WatchedPerson,
} from "@/types";
import { SERVER_TARGET } from "@/types";

/** A file dragged onto the window, with the path the upload needs. */
export interface FileDrop {
  kind: "over" | "drop" | "leave";
  paths: string[];
}

/**
 * Whether this is running inside the app rather than a plain browser or vitest.
 *
 * One definition, because every caller of it is a place that throws when it
 * guesses wrong: the Tauri API modules read globals only the webview injects,
 * and reading them anywhere else throws synchronously.
 */
export function insideTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/**
 * The window's own drop events, not the webview's.
 *
 * Tauri intercepts the drop before the page sees it and hands over real paths.
 * An HTML5 drop inside a webview gives a `File` with no path, which the upload
 * command cannot open.
 *
 * Outside the app there is nothing to subscribe to, and this used to say so by
 * throwing — inside the effect that mounts the drop target, which took the
 * whole React tree with it and left a window that was the right colour and
 * completely empty (#209). A window you cannot drop a file onto is the right
 * answer there: a missing capability changes what the UI offers and never
 * produces an error.
 */
export function onFileDrop(handler: (event: FileDrop) => void): Promise<() => void> {
  if (!insideTauri()) return Promise.resolve(() => {});
  return getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload;
    handler({
      kind: payload.type === "enter" ? "over" : (payload.type as FileDrop["kind"]),
      paths: "paths" in payload ? payload.paths : [],
    });
  });
}

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
  registerLiberaAccount: (network: string, account: string, password: string, email: string) =>
    invoke<void>("register_libera_account", { network, account, password, email }),
  removeNetwork: (network: string) => invoke<void>("remove_network", { network }),

  getUploadProvider: () => invoke<UploadProvider | null>("get_upload_provider"),
  saveUploadProvider: (provider: UploadProvider) =>
    invoke<void>("save_upload_provider", { provider }),
  removeUploadProvider: () => invoke<void>("remove_upload_provider"),
  describeUploads: (paths: string[]) => invoke<FileToUpload[]>("describe_uploads", { paths }),
  uploadFile: (path: string) => invoke<UploadedFile>("upload_file", { path }),

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
  archiveSummary: (network: string | null, target: string | null) =>
    invoke<ArchiveSummary>("archive_summary", { network, target }),
  setRetention: (network: string, target: string | null, days: number | null) =>
    invoke<void>("set_retention", { network, target, days }),
  highlightWords: () => invoke<string[]>("highlight_words"),
  setHighlightWords: (words: string[]) => invoke<void>("set_highlight_words", { words }),
  mutedConversations: () => invoke<MutedConversation[]>("muted_conversations"),
  setMuted: (network: string, target: string | null, muted: boolean) =>
    invoke<void>("set_muted", { network, target, muted }),
  ignoredPeople: () => invoke<IgnoredPerson[]>("ignored_people"),
  setIgnored: (network: string, nick: string, ignored: boolean) =>
    invoke<void>("set_ignored", { network, nick, ignored }),
  watchedPeople: () => invoke<WatchedPerson[]>("watched_people"),
  setWatched: (network: string, nick: string, watched: boolean) =>
    invoke<void>("set_watched", { network, nick, watched }),
  exportArchive: (scope: ArchiveScope, path: string) =>
    invoke<number>("export_archive", { scope, path }),
  exportProfile: (path: string, contents: string) =>
    invoke<number>("export_profile", { path, contents }),
  deleteArchive: (scope: ArchiveScope) => invoke<void>("delete_archive", { scope }),

  loadHistory: (req: HistoryRequest) => invoke<ChatMessage[]>("load_history", { req }),
  loadHistoryAround: (network: string, target: string, messageId: string, limit: number) =>
    invoke<ChatMessage[]>("load_history_around", { network, target, messageId, limit }),
  /** What the server holds behind the archive, asked for once the archive has
   * run out. `from` and `msgid` name the oldest message the window holds, and
   * the msgid is the server's own — a locally minted one names nothing it can
   * resolve, the same rule as `react`. Answers whether another page may be
   * behind this one, or that the server has not said yet; the messages arrive
   * as `messagesAppended`, written to the archive on the way, so nothing is
   * returned here.
   *
   * The console is not a conversation and no server keeps history for it, the
   * same reason `setTyping` is silent there. Its archive is the whole of what
   * it has, so `"end"` is the true answer rather than a refusal to ask. */
  pageBack: (network: string, target: string, from: string, msgid: string | null, ask: string) =>
    isConversation(target)
      ? invoke<PageBackOutcome>("page_back", { network, target, from, msgid, ask })
      : Promise.resolve<PageBackOutcome>("end"),
  searchHistory: (req: SearchRequest) => invoke<SearchHit[]>("search_history", { req }),
  listBookmarks: (network: string | null, target: string | null, limit: number) =>
    invoke<SearchHit[]>("list_bookmarks", { network, target, limit }),
  setBookmark: (network: string, target: string, messageId: string, active: boolean) =>
    invoke<void>("set_bookmark", { network, target, messageId, active }),
  setBookmarkNote: (network: string, target: string, messageId: string, note: string) =>
    invoke<void>("set_bookmark_note", { network, target, messageId, note }),
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
  /** Copies a theme folder in and answers with the id it landed under. The
   * directory watcher is what puts it in the catalogue. */
  installTheme: (source: string) => invoke<string>("install_theme", { source }),
  themesDirectory: () => invoke<string>("themes_directory"),

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

  /** Says `message` to a screen reader, through the window rather than the
   * page: a live region in this webview reaches the accessibility tree
   * correctly and is never announced from it. `src-tauri/src/announce.rs` has
   * the why. Rejects only where there is no backend to ask, which is every
   * browser the frontend is driven in, so callers let it fail. */
  announce: (message: string) => invoke<void>("announce", { message }),

  /** The SHA-256 of a certificate file, lowercase hex, for the user to register
   * with their account service. Rejects with a sentence naming the file when it
   * cannot be read or holds no certificate. */
  certificateFingerprint: (path: string) =>
    invoke<string>("certificate_fingerprint", { path }),

  /** The instrument's lines, appended to the file `IRCX_PROBE` names. Rejects
   * when it names nothing, which is what turns `@/lib/probe` off. */
  probe: (lines: string[]) => invoke<void>("probe", { lines }),
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

/** Shows a directory in the file manager. `openUrl`'s counterpart for a path,
 * and wrapped for the same reason. */
export async function revealFolder(path: string): Promise<void> {
  await openPath(path);
}

/**
 * Scales the whole window, using the webview's own zoom rather than a
 * stylesheet.
 *
 * The app sets its type in px, so a font-size on the root moves nothing, and a
 * CSS `zoom` there would scale boxes without scaling `window.innerWidth` — the
 * two would then disagree, and everything the app places by measurement reads
 * one against the other: the tooltips, the pointer menu, the sidebar's hanging
 * menu. The webview's zoom scales the coordinate space along with the pixels.
 *
 * Resolves either way. A browser has no webview to ask, and a window that
 * opened at the wrong scale is not worth failing over.
 */
export async function setWindowZoom(factor: number): Promise<void> {
  try {
    await getCurrentWebview().setZoom(factor);
  } catch (reason) {
    console.warn("ircx could not set the window scale", reason);
  }
}

/** The native folder picker, or null if it was dismissed. Wrapped here for the
 * reason `invoke` is: a component does not reach for a Tauri plugin itself. */
export async function chooseFolder(title: string): Promise<string | null> {
  const picked = await open({ directory: true, title });
  return typeof picked === "string" ? picked : null;
}

/** The native file picker, or null if it was dismissed. Wrapped as
 * `chooseFolder` is. The filter is a hint rather than a rule — a certificate
 * saved as `.crt` or with no extension is still one. */
export async function chooseFile(
  title: string,
  filters: { name: string; extensions: string[] }[],
): Promise<string | null> {
  const picked = await open({ directory: false, multiple: false, title, filters });
  return typeof picked === "string" ? picked : null;
}

/** The native file picker taking as many files as the user selects, or null if
 * it was dismissed. Wrapped as `chooseFolder` is. Unfiltered, unlike
 * `chooseFile`: an upload host takes whatever it is handed, so there is no
 * extension worth hinting at. */
export async function chooseFiles(title: string): Promise<string[] | null> {
  const picked = await open({ directory: false, multiple: true, title });
  return Array.isArray(picked) ? picked : null;
}

/** The native save dialog, or null if it was dismissed. Wrapped as
 * `chooseFolder` is. Rejects when the dialog could not be asked at all, which
 * callers report rather than fold into the dismissal — #167. */
export async function chooseSavePath(
  defaultPath: string,
  filters: { name: string; extensions: string[] }[],
): Promise<string | null> {
  return await save({ defaultPath, filters });
}

/** Tauri rejects with the handler's user-facing string; anything else is a bug
 * in the bridge and gets the caller's sentence instead. */
export function reasonOr(reason: unknown, fallback: string): string {
  return typeof reason === "string" && reason.trim() !== "" ? reason : fallback;
}

/** The backend delivers a window's worth of events as one message, so the
 * handler takes the batch and the store writes once for it. Resolves to an
 * unsubscribe function. */
export function onIrcxEvent(handler: (events: IrcxEvent[]) => void) {
  return listen<IrcxEvent[]>(EVENT_CHANNEL, (e) => handler(e.payload));
}

/** Fires with the whole themes directory whenever a file in it changes. */
export function onThemesChanged(handler: (themes: ThemeSource[]) => void) {
  return listen<ThemeSource[]>(THEMES_CHANNEL, (e) => handler(e.payload));
}
