import { prepare, type Haystack } from "@/lib/fuzzy";
import type { SectionId } from "@/components/settings/sections";
import { DEFAULT_BINDINGS, displayChord, type ActionId } from "@/lib/keybindings";
import { COMMANDS } from "@/components/composer/commands";
import { DENSITIES, type DensityId, type Theme } from "@/lib/theme";
import { targetKey, type TargetKey } from "@/store/keys";
import type { AppState, SplitDirection } from "@/store/types";
import { SERVER_TARGET } from "@/types";

export type CandidateKind =
  | "run"
  | "channel"
  | "query"
  | "network"
  | "command"
  | "action"
  | "theme";

/** What Enter does. Kept as data so a result row is comparable and testable
 * without a React tree. */
export type CandidateAction =
  | { type: "activate"; network: string; target: string }
  /** Puts the command in the palette's own input so its arguments can be typed
   * there. Nothing else in the app owns an input the palette can reach. */
  | { type: "refine"; text: string }
  | { type: "run"; network: string; target: string; input: string }
  | { type: "toggleRoster" }
  | { type: "filterMembers" }
  | { type: "split"; direction: SplitDirection }
  | { type: "closePane" }
  | { type: "search" }
  | { type: "unread"; direction: 1 | -1 }
  | { type: "connect"; network: string }
  | { type: "disconnect"; network: string }
  | { type: "openSetup"; network: string }
  | { type: "settings"; section?: SectionId }
  | { type: "theme"; id: string }
  | { type: "density"; id: DensityId }
  /** Carries what it will leave the setting at rather than reading the store
   * when it runs, so the row and what running it does cannot disagree. */
  | { type: "nickEveryLine"; on: boolean }
  /** A theme that failed to load. Running it prints why, which is the only
   * place the reasons can reach the person holding the file. */
  | { type: "themeProblem"; id: string; problems: string[] };

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

export const KIND_LABELS: Record<CandidateKind, string> = {
  run: "Run",
  channel: "Channels",
  query: "Queries",
  network: "Networks",
  command: "Commands",
  action: "Actions",
  theme: "Themes",
};

/** Group order when two groups tie on their best result. */
export const KIND_ORDER: Record<CandidateKind, number> = {
  run: -1,
  channel: 0,
  query: 1,
  network: 2,
  command: 3,
  action: 4,
  theme: 5,
};


/** Where a command line typed into the palette is dispatched. */
export interface CommandContext {
  network: string;
  networkName: string;
  /** The conversation in focus, or the server console when none is open. */
  target: string;
}

/**
 * The command the query already is, ready to run.
 *
 * Before the first channel is joined the palette's input is the only one the
 * app has, so `/join #x` typed there has to go somewhere. Null when the query
 * is not a command, or is a command still short of a required argument — that
 * case belongs to the `command` candidate, which fills the name in and waits.
 */
export function commandLineCandidate(
  query: string,
  where: CommandContext | null,
): Candidate | null {
  const input = query.trim();
  if (!where || !input.startsWith("/") || input.length < 2) return null;

  const [name = "", ...rest] = input.slice(1).split(" ");
  const known = COMMANDS.find((command) => command.name === name.toLowerCase());
  if (known?.args.includes("<") && rest.join("").trim() === "") return null;

  const inConversation = where.target !== SERVER_TARGET;
  return {
    id: "run",
    kind: "run",
    label: input,
    detail: inConversation
      ? `In ${where.target} on ${where.networkName}`
      : `On ${where.networkName}`,
    hay: prepare(input),
    key: null,
    action: { type: "run", network: where.network, target: where.target, input },
    unread: 0,
  };
}

/** The slices of the store the list is built from. Narrower than `AppState` so
 * the palette can memoise on exactly these and nothing else. */
export type CandidateSources = Pick<
  AppState,
  | "channels"
  | "queries"
  | "networks"
  | "networkOrder"
  | "themes"
  | "brokenThemes"
  | "themeId"
  | "density"
  | "presentation"
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
      detail: `Server messages · ${network.host}:${network.port}`,
      hay: prepare(network.name),
      key: targetKey(id, SERVER_TARGET),
      action: { type: "activate", network: id, target: SERVER_TARGET },
      unread: 0,
    });

    candidates.push({
      id: `settings:${id}`,
      kind: "action",
      label: `${network.name} settings`,
      detail: "Server, nick, and the saved SASL credentials",
      hay: prepare(`${network.name} settings`),
      key: null,
      action: { type: "openSetup", network: id },
      unread: 0,
    });

    // A failed network is still retrying — `failed` and `reconnecting` alternate
    // — so treating failed as "not connected" hid Disconnect at exactly the
    // moment somebody wanted to stop the loop. What they want to stop is the
    // session, and there is one until the state says otherwise.
    const connected = network.status.state !== "disconnected";
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

  for (const command of COMMANDS) {
    candidates.push({
      id: `command:${command.name}`,
      kind: "command",
      label: `/${command.name}`,
      detail: command.args ? `${command.args} — ${command.summary}` : command.summary,
      hay: prepare(`/${command.name}`),
      key: null,
      action: { type: "refine", text: `/${command.name} ` },
      unread: 0,
    });
  }

  for (const theme of state.themes) {
    candidates.push({
      id: `theme:${theme.id}`,
      kind: "theme",
      label: `Theme: ${theme.manifest.name}`,
      detail: describeTheme(theme, theme.id === state.themeId),
      hay: prepare(`Theme: ${theme.manifest.name}`),
      key: null,
      action: { type: "theme", id: theme.id },
      unread: 0,
    });
  }

  for (const density of DENSITIES) {
    const label = `Density: ${density.name}`;
    candidates.push({
      id: `density:${density.id}`,
      kind: "action",
      label,
      detail:
        density.id === state.density ? `${density.detail} · in use` : density.detail,
      hay: prepare(label),
      key: null,
      action: { type: "density", id: density.id },
      unread: 0,
    });
  }

  // The one timeline setting with a row of its own. It changes how much of the
  // window a conversation takes, so it is the one somebody turns on to read a
  // busy channel and off again afterwards — the appearance sheet is a long way
  // to go for that. Named for what running it leaves behind, the way Connect
  // and Disconnect are.
  const everyLine = state.presentation.nickEveryLine;
  const nickLabel = everyLine ? "Nickname once above a run" : "Nickname on every line";
  candidates.push({
    id: "presentation:nickEveryLine",
    kind: "action",
    label: nickLabel,
    detail: withChord(
      everyLine
        ? "State who said it and when once, above the run"
        : "State who said it and when in front of each line",
      "timeline.nickEveryLine",
    ),
    hay: prepare(nickLabel),
    key: null,
    action: { type: "nickEveryLine", on: !everyLine },
    unread: 0,
  });

  for (const broken of state.brokenThemes) {
    candidates.push({
      id: `theme:${broken.id}`,
      kind: "theme",
      label: `Theme: ${broken.id} will not load`,
      detail: `${broken.problems.length === 1 ? "One problem" : `${broken.problems.length} problems`} — press Enter to read them`,
      hay: prepare(`Theme: ${broken.id} will not load`),
      key: null,
      action: { type: "themeProblem", id: broken.id, problems: broken.problems },
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

function describeTheme(theme: Theme, inUse: boolean): string {
  const { author, version, appearance } = theme.manifest;
  return `${appearance} · ${author} · ${version}${inUse ? " · in use" : ""}`;
}

/**
 * The chord that does the same thing, named in the row that teaches it.
 *
 * Splitting had no way in but its shortcut, which is a feature nobody finds
 * (#224). A palette entry that does not also say the key trades one problem for
 * a slower one: the reader learns the command and reaches it through the
 * palette every time.
 */
function withChord(detail: string, action: ActionId): string {
  const binding = DEFAULT_BINDINGS.find((candidate) => candidate.action === action);
  return binding ? `${detail} · ${displayChord(binding.chord)}` : detail;
}

const STATIC_ACTIONS: readonly { label: string; detail: string; action: CandidateAction }[] = [
  {
    label: "Next unread conversation",
    detail: withChord("Highlights first, then other unread conversations", "target.nextUnread"),
    action: { type: "unread", direction: 1 },
  },
  {
    label: "Previous unread conversation",
    detail: withChord("Highlights first, then other unread conversations", "target.previousUnread"),
    action: { type: "unread", direction: -1 },
  },
  {
    label: "Split pane side by side",
    detail: withChord("A second pane on this conversation, beside this one", "pane.splitVertical"),
    action: { type: "split", direction: "row" },
  },
  {
    label: "Split pane top and bottom",
    detail: withChord(
      "A second pane on this conversation, above and below",
      "pane.splitHorizontal",
    ),
    action: { type: "split", direction: "column" },
  },
  {
    label: "Close pane",
    detail: withChord("Close the focused pane; the window always keeps one", "pane.close"),
    action: { type: "closePane" },
  },
  {
    label: "Toggle member list",
    detail: "Show or hide this pane's member list",
    action: { type: "toggleRoster" },
  },
  // The only thing that advertises the filter. Typing into the roster opens it,
  // and nothing on screen says so while the band above the list is empty.
  {
    label: "Filter members",
    detail: "Narrow this pane's member list to a name",
    action: { type: "filterMembers" },
  },
  {
    label: "Search this conversation",
    detail: "Search the current target's history",
    action: { type: "search" },
  },
  {
    label: "Plugins",
    detail: "Install a plugin, or change what one is allowed to do",
    action: { type: "settings", section: "plugins" },
  },
  {
    label: "Uploads",
    detail: "Where files go before their link is sent",
    action: { type: "settings", section: "uploads" },
  },
  {
    label: "Privacy",
    detail: "How long messages are kept, and how to export or delete them",
    action: { type: "settings", section: "privacy" },
  },
  {
    label: "Settings",
    detail: withChord("Themes and presets, the density, the timeline, the faces", "settings.open"),
    action: { type: "settings" },
  },
];
