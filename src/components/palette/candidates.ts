import { prepare, type Haystack } from "@/lib/fuzzy";
import { targetKey, type TargetKey } from "@/store/keys";
import type { AppState } from "@/store/types";

export type CandidateKind = "channel" | "query" | "network" | "command" | "action";

/** What Enter does. Kept as data so a result row is comparable and testable
 * without a React tree. */
export type CandidateAction =
  | { type: "activate"; network: string; target: string }
  | { type: "insertCommand"; text: string }
  | { type: "toggleDrawer" }
  | { type: "search" }
  | { type: "connect"; network: string }
  | { type: "disconnect"; network: string };

export interface Candidate {
  id: string;
  kind: CandidateKind;
  label: string;
  detail: string;
  /** Matched against the query. Only the label, so highlight offsets index it. */
  hay: Haystack;
  /** Set for channels and queries, so `recent` can break score ties. */
  key: TargetKey | null;
  action: CandidateAction;
  unread: number;
}

/** The network's own view, used by the sidebar's server row. Any target string
 * that cannot be an IRC target works; this one is the empty string. */
export const NETWORK_CONSOLE = "";

export const KIND_LABELS: Record<CandidateKind, string> = {
  channel: "Channels",
  query: "Queries",
  network: "Networks",
  command: "Commands",
  action: "Actions",
};

/** Group order when two groups tie on their best result. */
export const KIND_ORDER: Record<CandidateKind, number> = {
  channel: 0,
  query: 1,
  network: 2,
  command: 3,
  action: 4,
};

interface SlashCommand {
  name: string;
  args: string;
  detail: string;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "join", args: "<channel> [key]", detail: "Join a channel" },
  { name: "part", args: "[channel] [reason]", detail: "Leave a channel" },
  { name: "query", args: "<nick>", detail: "Open a private conversation" },
  { name: "msg", args: "<target> <message>", detail: "Send without opening a tab" },
  { name: "notice", args: "<target> <message>", detail: "Send a notice" },
  { name: "me", args: "<action>", detail: "Send an action" },
  { name: "nick", args: "<nick>", detail: "Change your nickname" },
  { name: "topic", args: "[topic]", detail: "Show or set the channel topic" },
  { name: "mode", args: "<target> <modes>", detail: "Set modes" },
  { name: "kick", args: "<nick> [reason]", detail: "Kick someone from the channel" },
  { name: "invite", args: "<nick> [channel]", detail: "Invite someone" },
  { name: "whois", args: "<nick>", detail: "Look up a user" },
  { name: "away", args: "[reason]", detail: "Set or clear away status" },
  { name: "connect", args: "[network]", detail: "Connect a network" },
  { name: "disconnect", args: "[reason]", detail: "Disconnect this network" },
  { name: "quit", args: "[reason]", detail: "Quit every network" },
  { name: "raw", args: "<line>", detail: "Send a raw protocol line" },
  { name: "close", args: "", detail: "Close the current target" },
];

/** The slices of the store the list is built from. Narrower than `AppState` so
 * the palette can memoise on exactly these and nothing else. */
export type CandidateSources = Pick<
  AppState,
  "channels" | "queries" | "networks" | "networkOrder"
>;

/** Rebuilt when the store's channel, query, or network maps change — not per
 * keystroke. `prepare` is the expensive part and runs exactly once per label. */
export function buildCandidates(state: CandidateSources): Candidate[] {
  const candidates: Candidate[] = [];

  for (const channel of Object.values(state.channels)) {
    const network = state.networks[channel.network];
    candidates.push({
      id: `channel:${channel.network}:${channel.name}`,
      kind: "channel",
      label: channel.name,
      detail: network?.name ?? channel.network,
      hay: prepare(channel.name),
      key: targetKey(channel.network, channel.name),
      action: { type: "activate", network: channel.network, target: channel.name },
      unread: channel.unread,
    });
  }

  for (const query of Object.values(state.queries)) {
    const network = state.networks[query.network];
    candidates.push({
      id: `query:${query.network}:${query.nick}`,
      kind: "query",
      label: query.nick,
      detail: network?.name ?? query.network,
      hay: prepare(query.nick),
      key: targetKey(query.network, query.nick),
      action: { type: "activate", network: query.network, target: query.nick },
      unread: query.unread,
    });
  }

  for (const id of state.networkOrder) {
    const network = state.networks[id];
    if (!network) continue;
    candidates.push({
      id: `network:${id}`,
      kind: "network",
      label: network.name,
      detail: `${network.host}:${network.port}`,
      hay: prepare(network.name),
      key: targetKey(id, NETWORK_CONSOLE),
      action: { type: "activate", network: id, target: NETWORK_CONSOLE },
      unread: 0,
    });

    const connected = network.status.state !== "disconnected" && network.status.state !== "failed";
    candidates.push({
      id: `${connected ? "disconnect" : "connect"}:${id}`,
      kind: "action",
      label: `${connected ? "Disconnect" : "Connect"} ${network.name}`,
      detail: network.host,
      hay: prepare(`${connected ? "Disconnect" : "Connect"} ${network.name}`),
      key: null,
      action: connected ? { type: "disconnect", network: id } : { type: "connect", network: id },
      unread: 0,
    });
  }

  for (const command of SLASH_COMMANDS) {
    candidates.push({
      id: `command:${command.name}`,
      kind: "command",
      label: `/${command.name}`,
      detail: command.args ? `${command.args} — ${command.detail}` : command.detail,
      hay: prepare(`/${command.name}`),
      key: null,
      action: { type: "insertCommand", text: `/${command.name} ` },
      unread: 0,
    });
  }

  for (const action of STATIC_ACTIONS) {
    candidates.push({
      id: `action:${action.label}`,
      kind: "action",
      label: action.label,
      detail: action.detail,
      hay: prepare(action.label),
      key: null,
      action: action.action,
      unread: 0,
    });
  }

  return candidates;
}

const STATIC_ACTIONS: readonly { label: string; detail: string; action: CandidateAction }[] = [
  {
    label: "Toggle member drawer",
    detail: "Show or hide the member list",
    action: { type: "toggleDrawer" },
  },
  {
    label: "Search this conversation",
    detail: "Search the current target's history",
    action: { type: "search" },
  },
];
