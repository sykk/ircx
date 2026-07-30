import { create } from "zustand";
import type { ChatMessage, IrcxEvent } from "@/types";
import { targetKey, type TargetKey } from "./keys";
import type { ActiveTarget, AppState, ChatView, TimelineState, ViewId } from "./types";

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

  toggleDrawer: (open?: boolean) => void;
  togglePalette: (open?: boolean) => void;
  toggleSearch: (open?: boolean) => void;
  toggleNetworkCollapsed: (network: string) => void;
  setSidebarWidth: (px: number) => void;
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
  recent: [],
  drawerOpen: false,
  paletteOpen: false,
  searchOpen: false,
  collapsedNetworks: {},
  sidebarWidth: 240,
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
  togglePalette: (open) => set((s) => ({ paletteOpen: open ?? !s.paletteOpen })),
  toggleSearch: (open) => set((s) => ({ searchOpen: open ?? !s.searchOpen })),

  toggleNetworkCollapsed: (network) =>
    set((s) => ({
      collapsedNetworks: {
        ...s.collapsedNetworks,
        [network]: !s.collapsedNetworks[network],
      },
    })),

  setSidebarWidth: (px) => set({ sidebarWidth: Math.min(400, Math.max(180, px)) }),
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
      const timeline = s.timelines[key];
      if (!timeline) return {};
      const at = timeline.messages.findIndex((m) => m.id === event.message.id);
      if (at === -1) return {};
      const messages = timeline.messages.slice();
      messages[at] = event.message;
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
