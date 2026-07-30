import { create } from "zustand";
import { FALLBACK_THEME_ID, type Catalogue } from "@/lib/theme";
import type { ChatMessage, IrcxEvent, Reaction } from "@/types";
import { targetKey, type TargetKey } from "./keys";
import { paneOrder, removeLeaf, splitLeaf } from "./layout";
import type {
  ActiveTarget,
  AppState,
  ChatView,
  ContextMode,
  SplitDirection,
  TimelineState,
  ViewId,
} from "./types";

/** Older messages stay in SQLite; the window is what the timeline can scroll. */
const TIMELINE_CAP = 10_000;
const RAW_LOG_CAP = 2_000;
const RECENT_CAP = 50;

const EMPTY_TIMELINE: TimelineState = {
  messages: [],
  unreadFrom: null,
  hasMore: true,
  loadingOlder: false,
};

/** Sequential rather than random so a test can name the view it just opened. */
let nextViewId = 0;
function mintViewId(): ViewId {
  nextViewId += 1;
  return `view-${nextViewId}`;
}

export interface AppActions {
  applyEvent: (event: IrcxEvent) => void;

  /** Points the focused view at a target, opening a view if none exists. */
  setActive: (target: ActiveTarget | null) => void;
  prependHistory: (key: TargetKey, older: ChatMessage[], hasMore: boolean) => void;
  setLoadingOlder: (key: TargetKey, loading: boolean) => void;
  clearUnreadMarker: (key: TargetKey) => void;

  setViewScroll: (view: ViewId, position: number) => void;
  setViewSelectedUser: (view: ViewId, nick: string | null) => void;

  /** Opens a second pane on the focused view's target and focuses it. */
  splitActiveView: (direction: SplitDirection) => void;
  /** Refused for the last pane; the window always holds at least one. */
  closeView: (view: ViewId) => void;
  focusView: (view: ViewId) => void;

  toggleDrawer: (open?: boolean) => void;
  /** Moves the panel between the three modes, attaching it to whichever pane it
   * is already showing. */
  setContextMode: (mode: ContextMode) => void;
  togglePalette: (open?: boolean) => void;
  toggleSearch: (open?: boolean) => void;
  /** Opens the network setup form on an existing network, or on a new one for
   * a null id. */
  openSetup: (network: string | null) => void;
  closeSetup: () => void;
  toggleNetworkCollapsed: (network: string) => void;
  setSidebarWidth: (px: number) => void;

  setThemeCatalogue: (catalogue: Catalogue) => void;
  setThemeId: (id: string) => void;
}

const initialState: AppState = {
  networks: {},
  networkOrder: [],
  channels: {},
  queries: {},
  members: {},
  timelines: {},
  typing: {},
  rawLog: {},
  views: {},
  viewOrder: [],
  activeViewId: null,
  layout: null,
  recent: [],
  drawerOpen: false,
  contextMode: "follow",
  contextPane: null,
  paletteOpen: false,
  searchOpen: false,
  setup: null,
  collapsedNetworks: {},
  sidebarWidth: 240,
  themes: [],
  brokenThemes: [],
  themeId: FALLBACK_THEME_ID,
};

export const useAppStore = create<AppState & AppActions>((set) => ({
  ...initialState,

  applyEvent: (event) => set((s) => reduce(s, event)),

  setActive: (target) =>
    set((s) => {
      const id = s.activeViewId;
      if (!target) {
        if (!id) return {};
        return { views: retarget(s.views, id, "", "") };
      }

      const key = targetKey(target.network, target.target);
      const timeline = s.timelines[key];
      // The unread rule is placed on switch, not on scroll, so it holds still
      // while the user reads. It lives beside the target rather than the view:
      // having read a channel in one pane means having read it.
      const timelines = timeline
        ? { ...s.timelines, [key]: { ...timeline, unreadFrom: null } }
        : s.timelines;
      const recent = [key, ...s.recent.filter((k) => k !== key)].slice(0, RECENT_CAP);

      if (!id) {
        const view = newView(target.network, target.target);
        return {
          views: { [view.id]: view },
          viewOrder: [view.id],
          activeViewId: view.id,
          layout: { type: "view", id: view.id },
          recent,
          timelines,
        };
      }
      return { views: retarget(s.views, id, target.network, target.target), recent, timelines };
    }),

  setViewScroll: (view, position) =>
    set((s) => {
      const current = s.views[view];
      if (!current || current.scrollPosition === position) return {};
      return { views: { ...s.views, [view]: { ...current, scrollPosition: position } } };
    }),

  setViewSelectedUser: (view, nick) =>
    set((s) => {
      const current = s.views[view];
      if (!current || current.selectedUser === nick) return {};
      return { views: { ...s.views, [view]: { ...current, selectedUser: nick } } };
    }),

  splitActiveView: (direction) =>
    set((s) => {
      const active = s.activeViewId ? s.views[s.activeViewId] : undefined;
      if (!active || !s.layout) return {};

      const opened = newView(active.network, active.target);
      const layout = splitLeaf(s.layout, active.id, direction, opened.id);
      return {
        layout,
        views: { ...s.views, [opened.id]: opened },
        viewOrder: paneOrder(layout),
        activeViewId: opened.id,
      };
    }),

  closeView: (view) =>
    set((s) => {
      if (!s.layout || !s.views[view] || s.viewOrder.length < 2) return {};
      const layout = removeLeaf(s.layout, view);
      if (!layout) return {};

      const { [view]: _closed, ...views } = s.views;
      const at = s.viewOrder.indexOf(view);
      // A panel pinned to the pane that just closed would have nothing to point
      // at and no header left to switch modes from, so it goes back to
      // following focus.
      const stranded = s.contextPane === view;
      return {
        layout,
        views,
        viewOrder: paneOrder(layout),
        activeViewId:
          s.activeViewId === view
            ? (s.viewOrder[at + 1] ?? s.viewOrder[at - 1] ?? null)
            : s.activeViewId,
        contextMode: stranded ? "follow" : s.contextMode,
        contextPane: stranded ? null : s.contextPane,
      };
    }),

  focusView: (view) =>
    set((s) => (s.views[view] && s.activeViewId !== view ? { activeViewId: view } : {})),

  prependHistory: (key, older, hasMore) =>
    set((s) => {
      const timeline = s.timelines[key] ?? EMPTY_TIMELINE;
      const known = new Set(timeline.messages.map((m) => m.id));
      const fresh = older.filter((m) => !known.has(m.id));
      return {
        timelines: {
          ...s.timelines,
          [key]: {
            ...timeline,
            messages: [...fresh, ...timeline.messages],
            hasMore,
            loadingOlder: false,
          },
        },
      };
    }),

  setLoadingOlder: (key, loading) =>
    set((s) => ({
      timelines: {
        ...s.timelines,
        [key]: { ...(s.timelines[key] ?? EMPTY_TIMELINE), loadingOlder: loading },
      },
    })),

  clearUnreadMarker: (key) =>
    set((s) => {
      const timeline = s.timelines[key];
      if (!timeline) return {};
      return { timelines: { ...s.timelines, [key]: { ...timeline, unreadFrom: null } } };
    }),

  toggleDrawer: (open) => set((s) => ({ drawerOpen: open ?? !s.drawerOpen })),

  setContextMode: (mode) =>
    set((s) => ({
      contextMode: mode,
      contextPane:
        mode === "follow"
          ? null
          : s.contextMode === "follow"
            ? s.activeViewId
            : s.contextPane,
    })),

  togglePalette: (open) => set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
  toggleSearch: (open) => set((s) => ({ searchOpen: open ?? !s.searchOpen })),

  openSetup: (network) => set({ setup: { network } }),
  closeSetup: () => set({ setup: null }),

  toggleNetworkCollapsed: (network) =>
    set((s) => ({
      collapsedNetworks: {
        ...s.collapsedNetworks,
        [network]: !s.collapsedNetworks[network],
      },
    })),

  setSidebarWidth: (px) => set({ sidebarWidth: Math.min(400, Math.max(180, px)) }),

  setThemeCatalogue: ({ themes, broken }) => set({ themes, brokenThemes: broken }),
  setThemeId: (id) => set({ themeId: id }),
}));

function newView(network: string, target: string): ChatView {
  return { id: mintViewId(), network, target, scrollPosition: 0, selectedUser: null };
}

/** Retargeting resets the view's own position — the scroll and the inspector
 * belonged to the conversation it was showing, not to the pane. */
function retarget(
  views: Record<ViewId, ChatView>,
  id: ViewId,
  network: string,
  target: string,
): Record<ViewId, ChatView> {
  const view = views[id];
  if (!view) return views;
  if (view.network === network && view.target === target) return views;
  return { ...views, [id]: { ...view, network, target, scrollPosition: 0, selectedUser: null } };
}

function reduce(s: AppState, event: IrcxEvent): Partial<AppState> {
  switch (event.type) {
    case "networkUpdated": {
      const id = event.network.id;
      return {
        networks: { ...s.networks, [id]: event.network },
        networkOrder: s.networkOrder.includes(id)
          ? s.networkOrder
          : [...s.networkOrder, id],
      };
    }

    case "networkRemoved": {
      const { [event.network]: _dropped, ...networks } = s.networks;
      // A view left pointing at a deleted network would render an empty pane
      // with a live-looking header, so blank it instead of dropping the view —
      // closing the last pane is not a thing the layout can express.
      const stale = Object.values(s.views).filter((v) => v.network === event.network);
      const views = stale.length
        ? {
            ...s.views,
            ...Object.fromEntries(
              stale.map((v) => [
                v.id,
                { ...v, network: "", target: "", scrollPosition: 0, selectedUser: null },
              ]),
            ),
          }
        : s.views;

      return {
        networks,
        networkOrder: s.networkOrder.filter((n) => n !== event.network),
        channels: dropByNetwork(s.channels, event.network),
        queries: dropByNetwork(s.queries, event.network),
        timelines: dropByNetwork(s.timelines, event.network),
        members: dropByNetwork(s.members, event.network),
        views,
      };
    }

    case "connectionChanged":
      return patchNetwork(s, event.network, { status: event.status });

    case "saslChanged":
      return patchNetwork(s, event.network, { sasl: event.status });

    case "capsChanged":
      return patchNetwork(s, event.network, { capsEnabled: event.enabled });

    case "lagChanged":
      return patchNetwork(s, event.network, { lagMs: event.lagMs });

    case "messagesAppended": {
      const key = targetKey(event.network, event.target);
      const timeline = s.timelines[key] ?? EMPTY_TIMELINE;
      const known = new Set(timeline.messages.map((m) => m.id));
      const fresh = event.messages.filter((m) => !known.has(m.id));
      if (fresh.length === 0) return {};

      const merged = [...timeline.messages, ...fresh];
      const focused = s.activeViewId ? s.views[s.activeViewId] : undefined;
      const isActive =
        focused?.network === event.network && focused.target === event.target;

      return {
        timelines: {
          ...s.timelines,
          [key]: {
            ...timeline,
            messages:
              merged.length > TIMELINE_CAP ? merged.slice(-TIMELINE_CAP) : merged,
            unreadFrom:
              timeline.unreadFrom ??
              (isActive || fresh[0]?.sender.isSelf ? null : (fresh[0]?.id ?? null)),
          },
        },
      };
    }

    case "messageUpdated": {
      const key = targetKey(event.message.network, event.message.target);
      const timeline = s.timelines[key] ?? EMPTY_TIMELINE;
      const messages = timeline.messages.slice();
      const at = messages.findIndex((m) => m.id === event.message.id);
      // An update for a message the window does not hold is still the whole
      // message, and dropping it loses the only copy there may ever be.
      if (at === -1) messages.splice(insertionPoint(messages, event.message), 0, event.message);
      else messages[at] = event.message;
      return { timelines: { ...s.timelines, [key]: { ...timeline, messages } } };
    }

    case "reactionChanged": {
      const key = targetKey(event.network, event.target);
      const timeline = s.timelines[key];
      // A reaction can name a message that scrolled out of this window, or one
      // said before the client connected. The archive keeps it either way and
      // hands it back with the message, so there is nothing to hold here.
      if (!timeline) return {};
      const at = timeline.messages.findIndex((m) => serverMsgid(m) === event.message);
      if (at === -1) return {};

      const held = timeline.messages[at]!;
      const messages = timeline.messages.slice();
      messages[at] = { ...held, reactions: applyReaction(held.reactions ?? [], event) };
      return { timelines: { ...s.timelines, [key]: { ...timeline, messages } } };
    }

    case "channelUpdated": {
      const key = targetKey(event.channel.network, event.channel.name);
      return { channels: { ...s.channels, [key]: event.channel } };
    }

    case "channelRemoved": {
      const key = targetKey(event.network, event.name);
      const { [key]: _dropped, ...channels } = s.channels;
      return { channels };
    }

    case "queryUpdated": {
      const key = targetKey(event.query.network, event.query.nick);
      return { queries: { ...s.queries, [key]: event.query } };
    }

    case "membersReplaced": {
      const key = targetKey(event.network, event.channel);
      return { members: { ...s.members, [key]: event.members } };
    }

    case "memberUpdated": {
      const key = targetKey(event.network, event.channel);
      const current = s.members[key] ?? [];
      const at = current.findIndex((m) => m.nick === event.member.nick);
      const next = current.slice();
      if (at === -1) next.push(event.member);
      else next[at] = event.member;
      return { members: { ...s.members, [key]: next } };
    }

    case "memberRemoved": {
      const key = targetKey(event.network, event.channel);
      const current = s.members[key];
      if (!current) return {};
      return {
        members: { ...s.members, [key]: current.filter((m) => m.nick !== event.nick) },
      };
    }

    case "typingChanged": {
      const key = targetKey(event.network, event.target);
      const current = s.typing[key] ?? {};
      if (!event.active) {
        const { [event.nick]: _stopped, ...rest } = current;
        return { typing: { ...s.typing, [key]: rest } };
      }
      // Servers send a start without a matching stop, so the entry carries its
      // own expiry and the view filters on it.
      return {
        typing: { ...s.typing, [key]: { ...current, [event.nick]: Date.now() + 6_000 } },
      };
    }

    case "rawLine": {
      const line = `${event.outgoing ? ">>" : "<<"} ${event.line}`;
      const current = s.rawLog[event.network] ?? [];
      const next = [...current, line];
      return {
        rawLog: {
          ...s.rawLog,
          [event.network]: next.length > RAW_LOG_CAP ? next.slice(-RAW_LOG_CAP) : next,
        },
      };
    }

    case "notice":
      // Rendered by the timeline as a Client message once core routes it to a
      // target; nothing to hold in the store.
      return {};
  }
}

/** What a `+reply` can name a message by. A message this client sent keeps the
 * local id the UI drew it with, so the server's name for it is the `msgid` tag
 * its echo carried. */
function serverMsgid(message: ChatMessage): string {
  if (!message.idIsLocal) return message.id;
  return message.tags.find(([name]) => name === "msgid")?.[1] ?? message.id;
}

/** Adding a reaction someone already holds changes nothing, and taking back one
 * they never sent changes nothing either — a server can deliver either line
 * twice, and the sender's own copy is followed by its echo. */
function applyReaction(
  held: readonly Reaction[],
  event: Extract<IrcxEvent, { type: "reactionChanged" }>,
): Reaction[] {
  const at = held.findIndex((r) => r.emoji === event.emoji);
  if (at === -1) {
    if (!event.active) return [...held];
    return [...held, { emoji: event.emoji, nicks: [event.nick] }];
  }

  const nicks = held[at]!.nicks;
  const next = event.active
    ? nicks.includes(event.nick)
      ? nicks
      : [...nicks, event.nick]
    : nicks.filter((nick) => nick !== event.nick);

  const reactions = held.slice();
  if (next.length === 0) reactions.splice(at, 1);
  else reactions[at] = { emoji: event.emoji, nicks: next };
  return reactions;
}

/** A timeline is held in the order the conversation happened, so a message that
 * arrives late lands at its own time rather than at the bottom. */
function insertionPoint(messages: readonly ChatMessage[], message: ChatMessage): number {
  const at = Date.parse(message.timestamp);
  if (Number.isNaN(at)) return messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (Date.parse(messages[i]!.timestamp) <= at) return i + 1;
  }
  return 0;
}

function patchNetwork(
  s: AppState,
  id: string,
  patch: Partial<AppState["networks"][string]>,
): Partial<AppState> {
  const current = s.networks[id];
  if (!current) return {};
  return { networks: { ...s.networks, [id]: { ...current, ...patch } } };
}

function dropByNetwork<T>(map: Record<string, T>, network: string): Record<string, T> {
  const prefix = `${network} `;
  return Object.fromEntries(
    Object.entries(map).filter(([k]) => !k.startsWith(prefix)),
  ) as Record<string, T>;
}

export { EMPTY_TIMELINE, TIMELINE_CAP };
