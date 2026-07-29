import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AppSnapshot,
  Attachment,
  ChatMessage,
  CommandOutcome,
  HistoryRequest,
  IrcxEvent,
  Member,
  NetworkConfig,
  Query,
  SearchHit,
  SearchRequest,
} from "@/types";

const EVENT_CHANNEL = "ircx://event";

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
  partChannel: (network: string, channel: string, reason?: string) =>
    invoke<void>("part_channel", { network, channel, reason: reason ?? null }),
  openQuery: (network: string, nick: string) =>
    invoke<Query>("open_query", { network, nick }),
  closeTarget: (network: string, target: string) =>
    invoke<void>("close_target", { network, target }),

  submitInput: (network: string, target: string, input: string) =>
    invoke<CommandOutcome>("submit_input", { network, target, input }),
  sendRaw: (network: string, line: string) => invoke<void>("send_raw", { network, line }),

  listMembers: (network: string, channel: string) =>
    invoke<Member[]>("list_members", { network, channel }),
  loadHistory: (req: HistoryRequest) => invoke<ChatMessage[]>("load_history", { req }),
  searchHistory: (req: SearchRequest) => invoke<SearchHit[]>("search_history", { req }),
  markRead: (network: string, target: string) =>
    invoke<void>("mark_read", { network, target }),
  setTyping: (network: string, target: string, active: boolean) =>
    invoke<void>("set_typing", { network, target, active }),

  loadPreview: (url: string) => invoke<Attachment>("load_preview", { url }),
  getDraft: (network: string, target: string) =>
    invoke<string | null>("get_draft", { network, target }),
  setDraft: (network: string, target: string, text: string) =>
    invoke<void>("set_draft", { network, target, text }),
};

/** Resolves to an unsubscribe function. */
export function onIrcxEvent(handler: (event: IrcxEvent) => void) {
  return listen<IrcxEvent>(EVENT_CHANNEL, (e) => handler(e.payload));
}
