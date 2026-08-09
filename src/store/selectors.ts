import { useShallow } from "zustand/react/shallow";
import type { Channel, ChatMessage, Member, Network, Query } from "@/types";
import { targetKey, type TargetKey } from "./keys";
import { chatPane, EMPTY_TIMELINE, serverMsgid, useAppStore } from "./index";
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

/** Where the reader is looking, off a state rather than through a
 * subscription — for the callers that are not components. `chatPane` rather
 * than the focused pane, so this still answers while settings holds the
 * focus. */
export function selectActiveTarget(s: AppState): ActiveTarget | null {
  const id = chatPane(s);
  const view = id ? s.views[id] : undefined;
  if (!view || !view.network) return null;
  return { network: view.network, target: view.target };
}

/** Where the reader is looking. Components that will become pane-aware should
 * take a `ViewId` and use the `…ForView` selectors below instead. */
export function useActiveTarget(): ActiveTarget | null {
  return useAppStore(useShallow(selectActiveTarget));
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

/** Lines already sent in this conversation, newest first. */
export function useInputHistory(network: string, target: string): string[] {
  return useAppStore((s) => s.inputHistory[targetKey(network, target)] ?? EMPTY);
}

/**
 * How many of our own lines in this conversation are still waiting for the
 * socket.
 *
 * Counted backwards from the newest and stopped at the first line of ours that
 * has left, rather than swept over the window. #334 gives every line a ticket
 * in the order it was queued and settles them as a prefix, so our own pending
 * lines are a suffix of our own: once one has left, everything we said before
 * it has left too. A conversation nobody is pasting into therefore costs one
 * comparison, which is what this is called on every store read for.
 *
 * Someone else's messages are skipped rather than stopped at — a busy channel
 * goes on talking while a paste of ours drains.
 */
export function selectQueued(s: AppState, network: string, target: string): number {
  const messages = s.timelines[targetKey(network, target)]?.messages ?? EMPTY;
  let queued = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (!message.sender.isSelf) continue;
    if (message.delivery.state !== "pending") break;
    queued++;
  }
  return queued;
}

export function useQueued(network: string, target: string): number {
  return useAppStore((s) => selectQueued(s, network, target));
}

export function selectChannelsFor(s: AppState, network: string): Channel[] {
  return Object.values(s.channels).filter((c) => c.network === network);
}

export function selectQueriesFor(s: AppState, network: string): Query[] {
  return Object.values(s.queries).filter((q) => q.network === network);
}

/**
 * The conversation at the top of the sidebar, which is the one an empty window
 * opens.
 *
 * Reading order rather than arrival order: one network's panel at a time, its
 * channels before its queries and both by name, which is how `SidebarNetworks`
 * draws them. A window that opens itself should land on the row the eye is
 * already going to, and an autojoin arrives in whatever order the server
 * acknowledges it.
 */
export function selectFirstConversation(s: AppState): ActiveTarget | null {
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

  for (const network of s.networkOrder) {
    const channel = selectChannelsFor(s, network).sort((a, b) => byName(a.name, b.name))[0];
    if (channel) return { network, target: channel.name };
    const query = selectQueriesFor(s, network).sort((a, b) => byName(a.nick, b.nick))[0];
    if (query) return { network, target: query.nick };
  }
  return null;
}


/** A character no nick can contain. `\w` and RFC 2812's `[]\^{}|-` are what one
 * can, so the boundary class is everything outside that set. */
const BOUNDARY = "[^\\w\\[\\]\\\\^{}|-]";

/**
 * What makes a line loud: the reader's nickname, and the words they added
 * beside it on the settings window's Notifications page.
 *
 * One value rather than two, because everything that decides this needs both.
 * A component handed only the nick would tint a row the badge disagreed with,
 * which is the failure `fixtures/highlight.json` exists to prevent between the
 * two languages and this type prevents inside one.
 */
export interface HighlightRule {
  /** Null before the session has registered, when nothing is addressed to you
   * yet because you have no name to be addressed by. */
  nick: string | null;
  words: readonly string[];
}

/** The rule with nothing in it. A conversation drawn against this has no loud
 * lines, which is what the settings preview and a session mid-registration
 * both want. */
export const NO_HIGHLIGHT: HighlightRule = { nick: null, words: [] };

function termsOf(rule: HighlightRule): string[] {
  const terms = rule.words.filter((word) => word !== "");
  if (rule.nick) terms.push(rule.nick);
  // Longest first, so a line holding both `deploy` and `deployment` marks the
  // longer one rather than the prefix the alternation reached first.
  return terms.sort((a, b) => b.length - a.length);
}

/**
 * The trailing boundary is a lookahead rather than a match: consumed, it became
 * the leading boundary the next occurrence needed, so `syk syk` found one
 * mention instead of two. Nothing about which texts match changes.
 */
/** Keyed by the whole term list, so it holds one pattern per distinct rule —
 * a handful, and one more each time the words are edited. Safe to share
 * because `.test` without `g` and `matchAll` (which clones) leave `lastIndex`
 * alone; a caller that ran `exec` on a `g` pattern would not be. */
const highlightPatterns = new Map<string, RegExp | null>();

/** Null where there is nothing to match, which an empty alternation would
 * otherwise turn into a pattern matching every position in the line. */
function highlightPattern(terms: readonly string[], flags: string): RegExp | null {
  const key = `${flags}\0${terms.join("\0")}`;
  const held = highlightPatterns.get(key);
  if (held !== undefined) return held;
  const pattern =
    terms.length === 0
      ? null
      : new RegExp(
          `(^|${BOUNDARY})(${terms.map(escapeTerm).join("|")})(?=${BOUNDARY}|$)`,
          flags,
        );
  highlightPatterns.set(key, pattern);
  return pattern;
}

/** A word is a word and not a pattern: somebody who works on `c++` may say so. */
function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `text` is loud under `rule`: the nick, or any of the words, each on
 * a nickname boundary. `sable` matches, `sableton` does not, and neither does
 * `sable|away`. */
export function matchesHighlight(text: string, rule: HighlightRule): boolean {
  return highlightPattern(termsOf(rule), "i")?.test(text) ?? false;
}

export interface TextRun {
  text: string;
  /** True for what made the line loud — the reader's own nick, or one of their
   * words. Both are drawn the same way, because both are the reader finding
   * the thing they were told about. */
  mine: boolean;
}

/**
 * `text` split into runs, marking the ones the rule matched.
 *
 * Shares its pattern with `matchesHighlight`, so what a message is highlighted
 * for and what gets marked inside it cannot come apart — a row tinted with
 * nothing picked out in it would leave the reader hunting for the word.
 */
export function splitOnHighlight(text: string, rule: HighlightRule): TextRun[] {
  const pattern = highlightPattern(termsOf(rule), "gi");
  if (!pattern) return [{ text, mine: false }];

  const runs: TextRun[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1]!.length;
    const end = start + match[2]!.length;
    if (start > at) runs.push({ text: text.slice(at, start), mine: false });
    runs.push({ text: text.slice(start, end), mine: true });
    at = end;
  }
  if (at < text.length) runs.push({ text: text.slice(at), mine: false });
  return runs;
}

/**
 * Whether this message wants the reader's attention.
 *
 * `present` is who is in the conversation, folded. Somebody who is not in it
 * cannot be addressing anyone in it, which is what silences a service narrating
 * the reader's own comings and goings: ergo replays those as ordinary messages
 * from `HistServ`, whose text is `<you> joined the channel`, and the name in it
 * is the reader's own. #222.
 *
 * The cost is stated rather than hidden: somebody who named the reader and has
 * since left loses the mark, though not the message. The alternative was
 * recognising narration by its shape, which is a guess about English.
 *
 * An empty set is a conversation whose roster has not arrived rather than one
 * nobody is in — the reader is always in their own channel — so it does not
 * gate. Queries pass no set at all: the two people in one are the only two who
 * can speak.
 *
 * The reader's words are gated the same way the nick is. Somebody who has left
 * is not talking to the channel, whichever of the two the line matched.
 */
export function isHighlight(
  message: ChatMessage,
  rule: HighlightRule,
  present?: ReadonlySet<string>,
): boolean {
  if (message.sender.isSelf) return false;
  if (present && present.size > 0 && !present.has(message.sender.nick.toLowerCase())) {
    return false;
  }
  return matchesHighlight(message.text, rule);
}

export { targetKey };
export type { TargetKey };
