import { useShallow } from "zustand/react/shallow";
import type { Channel, ChatMessage, Member, Network, Query } from "@/types";
import { targetKey, type TargetKey } from "./keys";
import { EMPTY_TIMELINE, useAppStore } from "./index";
import type { ActiveTarget, AppState, ChatView, TimelineState, ViewId } from "./types";

/** Shared so an absent lookup returns one stable reference, not a fresh literal. */
const EMPTY: never[] = [];

// Every selector below derives a new array. zustand 5 compares snapshots by
// identity, so returning one unwrapped re-renders on every store read and
// React eventually bails out with a getSnapshot warning. useShallow compares
// element-wise instead.

export function useNetworks(): Network[] {
  return useAppStore(
    useShallow((s) => s.networkOrder.map((id) => s.networks[id]).filter(Boolean) as Network[]),
  );
}

export function useNetwork(id: string | undefined): Network | undefined {
  return useAppStore((s) => (id ? s.networks[id] : undefined));
}

export function useChannelsFor(network: string): Channel[] {
  return useAppStore(useShallow((s) => selectChannelsFor(s, network)));
}

export function useQueriesFor(network: string): Query[] {
  return useAppStore(useShallow((s) => selectQueriesFor(s, network)));
}

/**
 * The focused pane. Components that will become pane-aware should take a
 * `ViewId` and use the `…ForView` selectors below; these read through
 * `activeViewId` for the ones that only ever want whatever has focus.
 */
export function useActiveView(): ChatView | undefined {
  return useAppStore((s) => (s.activeViewId ? s.views[s.activeViewId] : undefined));
}

export function useActiveTarget(): ActiveTarget | null {
  return useAppStore(
    useShallow((s) => {
      const view = s.activeViewId ? s.views[s.activeViewId] : undefined;
      if (!view || !view.network) return null;
      return { network: view.network, target: view.target };
    }),
  );
}

export function useView(id: ViewId | null | undefined): ChatView | undefined {
  return useAppStore((s) => (id ? s.views[id] : undefined));
}

export function useTimelineForView(id: ViewId | null | undefined): TimelineState {
  return useAppStore((s) => {
    const view = id ? s.views[id] : undefined;
    if (!view || !view.network) return EMPTY_TIMELINE;
    return s.timelines[targetKey(view.network, view.target)] ?? EMPTY_TIMELINE;
  });
}

export function useChannelForView(id: ViewId | null | undefined): Channel | undefined {
  return useAppStore((s) => {
    const view = id ? s.views[id] : undefined;
    if (!view || !view.network) return undefined;
    return s.channels[targetKey(view.network, view.target)];
  });
}

export function useActiveChannel(): Channel | undefined {
  return useChannelForView(useAppStore((s) => s.activeViewId));
}

export function useMembers(network: string, channel: string): Member[] {
  return useAppStore((s) => s.members[targetKey(network, channel)] ?? EMPTY);
}

/** Nicks whose indicator has not expired. Call from a component that re-renders
 * on a timer; this does not schedule its own. */
export function useTypingNicks(network: string, target: string): string[] {
  return useAppStore(
    useShallow((s) => {
      const entries = s.typing[targetKey(network, target)];
      if (!entries) return EMPTY;
      const now = Date.now();
      return Object.entries(entries)
        .filter(([, expiry]) => expiry > now)
        .map(([nick]) => nick);
    }),
  );
}

export function selectChannelsFor(s: AppState, network: string): Channel[] {
  return Object.values(s.channels).filter((c) => c.network === network);
}

export function selectQueriesFor(s: AppState, network: string): Query[] {
  return Object.values(s.queries).filter((q) => q.network === network);
}


/** Whether `text` mentions `nick` on a word boundary: `sable` matches, `sableton` does not. */
export function mentions(text: string, nick: string): boolean {
  if (!nick) return false;
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w\\[\\]\\\\^{}|-])${escaped}([^\\w\\[\\]\\\\^{}|-]|$)`, "i").test(
    text,
  );
}

export function isHighlight(message: ChatMessage, ownNick: string | null): boolean {
  if (!ownNick || message.sender.isSelf) return false;
  return mentions(message.text, ownNick);
}

export { targetKey };
export type { TargetKey };
