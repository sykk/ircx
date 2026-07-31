import { useShallow } from "zustand/react/shallow";
import type { Channel, ChatMessage, Member, Network, Query } from "@/types";
import { targetKey, type TargetKey } from "./keys";
import { EMPTY_TIMELINE, serverMsgid, useAppStore } from "./index";
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

/** One network's protocol transcript, oldest first, as the store capped it. */
export function useRawLog(network: string): string[] {
  return useAppStore((s) => s.rawLog[network] ?? EMPTY);
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

/** What the composer is about to answer: the staged msgid, and the message it
 * names if that message is still in the loaded window. The msgid alone is
 * enough to send with, so a parent scrolled out of history does not cancel the
 * reply — it only leaves nothing to quote. */
export function useReplyTarget(
  network: string,
  target: string,
): { msgid: string; parent: ChatMessage | undefined } | null {
  return useAppStore(
    useShallow((s) => {
      const key = targetKey(network, target);
      const msgid = s.replyTo[key];
      if (msgid === undefined) return null;
      const messages = s.timelines[key]?.messages ?? EMPTY;
      return { msgid, parent: messages.find((m) => serverMsgid(m) === msgid) };
    }),
  );
}

export function selectChannelsFor(s: AppState, network: string): Channel[] {
  return Object.values(s.channels).filter((c) => c.network === network);
}

export function selectQueriesFor(s: AppState, network: string): Query[] {
  return Object.values(s.queries).filter((q) => q.network === network);
}


/** A character no nick can contain. `\w` and RFC 2812's `[]\^{}|-` are what one
 * can, so the boundary class is everything outside that set. */
const BOUNDARY = "[^\\w\\[\\]\\\\^{}|-]";

/**
 * The trailing boundary is a lookahead rather than a match: consumed, it became
 * the leading boundary the next occurrence needed, so `syk syk` found one
 * mention instead of two. Nothing about which texts match changes.
 */
function mentionPattern(nick: string, flags: string): RegExp {
  const escaped = nick.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|${BOUNDARY})(${escaped})(?=${BOUNDARY}|$)`, flags);
}

/** Whether `text` mentions `nick` on a word boundary: `sable` matches, `sableton` does not. */
export function mentions(text: string, nick: string): boolean {
  if (!nick) return false;
  return mentionPattern(nick, "i").test(text);
}

export interface TextRun {
  text: string;
  /** True for the reader's own nick, which is drawn as the mention it is. */
  mine: boolean;
}

/**
 * `text` split into runs, marking the ones that are the reader's own nick.
 *
 * Shares its pattern with `mentions`, so what a message is highlighted for and
 * what gets marked inside it cannot come apart — a row tinted with nothing
 * picked out in it would leave the reader hunting for the word.
 */
export function splitOnMention(text: string, nick: string | null): TextRun[] {
  if (!nick) return [{ text, mine: false }];

  const runs: TextRun[] = [];
  let at = 0;
  for (const match of text.matchAll(mentionPattern(nick, "gi"))) {
    const start = match.index + match[1]!.length;
    const end = start + match[2]!.length;
    if (start > at) runs.push({ text: text.slice(at, start), mine: false });
    runs.push({ text: text.slice(start, end), mine: true });
    at = end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), mine: false });
  return runs;
}

export function isHighlight(message: ChatMessage, ownNick: string | null): boolean {
  if (!ownNick || message.sender.isSelf) return false;
  return mentions(message.text, ownNick);
}

export { targetKey };
export type { TargetKey };
