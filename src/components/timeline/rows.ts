import type { ChatMessage, MessageKind } from "@/types";
import { isHighlight } from "@/store/selectors";

export const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** One virtualised item. Groups and system runs hold several messages each. */
export type TimelineRow =
  | { kind: "group"; id: string; messages: ChatMessage[] }
  | { kind: "system"; id: string; messages: ChatMessage[] }
  | { kind: "unread"; id: string; seam: Seam };

/** What the reader missed, stated at the unread rule rather than left to a skim. */
export interface Seam {
  messages: number;
  people: number;
  spanMs: number;
  mentions: number;
}

const SYSTEM_KINDS = new Set<MessageKind>([
  "join",
  "part",
  "quit",
  "kick",
  "nick",
  "topic",
  "mode",
  "server",
  "client",
]);

/** Comings and goings: weather, and the only kinds the digest may fold away. */
const PRESENCE_KINDS = new Set<MessageKind>(["join", "part", "quit", "nick"]);

/**
 * Events that change who can read or speak. They are named in the digest's
 * first clause and no control hides them.
 */
const LOUD_KINDS = new Set<MessageKind>(["mode", "kick"]);

function isSystemKind(kind: MessageKind): boolean {
  return SYSTEM_KINDS.has(kind);
}

/** Kinds that carry their own nick in the rendered line and so never group. */
const STANDALONE = new Set<MessageKind>(["action", "notice"]);

function groupsWith(prev: ChatMessage, next: ChatMessage): boolean {
  if (STANDALONE.has(prev.kind) || STANDALONE.has(next.kind)) return false;
  if (prev.sender.nick !== next.sender.nick) return false;
  const gap = Date.parse(next.timestamp) - Date.parse(prev.timestamp);
  return Number.isFinite(gap) && gap >= 0 && gap <= GROUP_WINDOW_MS;
}

export function buildRows(
  messages: readonly ChatMessage[],
  unreadFrom: string | null,
  ownNick: string | null = null,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let open: Extract<TimelineRow, { kind: "group" | "system" }> | null = null;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    if (unreadFrom !== null && message.id === unreadFrom) {
      open = null;
      rows.push({ kind: "unread", id: "unread", seam: measureSeam(messages.slice(i), ownNick) });
    }

    const system = isSystemKind(message.kind);
    const continues = system
      ? open?.kind === "system"
      : open?.kind === "group" && groupsWith(open.messages[open.messages.length - 1]!, message);

    if (continues && open) {
      open.messages.push(message);
      continue;
    }

    open = system
      ? { kind: "system", id: `s:${message.id}`, messages: [message] }
      : { kind: "group", id: `g:${message.id}`, messages: [message] };
    rows.push(open);
  }

  return rows;
}

/** Presence is not counted: the seam measures what people said. */
function measureSeam(unread: readonly ChatMessage[], ownNick: string | null): Seam {
  const speech = unread.filter((m) => !isSystemKind(m.kind));
  const first = speech[0];
  const last = speech[speech.length - 1];
  return {
    messages: speech.length,
    people: new Set(speech.map((m) => m.sender.nick)).size,
    spanMs: first && last ? Math.max(0, Date.parse(last.timestamp) - Date.parse(first.timestamp)) : 0,
    mentions: speech.filter((m) => isHighlight(m, ownNick)).length,
  };
}

/** `HH:MM` in the viewer's timezone, without locale-dependent separators. */
export function formatClock(timestamp: string): string {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return "--:--";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/** Row index holding `messageId`, or -1. Drives the jump from a reply quote. */
export function rowIndexOfMessage(rows: readonly TimelineRow[], messageId: string): number {
  return rows.findIndex(
    (row) => row.kind !== "unread" && row.messages.some((m) => m.id === messageId),
  );
}

export interface SystemRun {
  /** Access changes. Always on screen, always first. */
  loud: ChatMessage[];
  /** Comings and goings, foldable into one line. */
  presence: ChatMessage[];
  /** Topics and server output: neither weather nor access, so always shown. */
  plain: ChatMessage[];
}

export function partitionSystemRun(messages: readonly ChatMessage[]): SystemRun {
  const run: SystemRun = { loud: [], presence: [], plain: [] };
  for (const message of messages) {
    if (LOUD_KINDS.has(message.kind)) run.loud.push(message);
    else if (PRESENCE_KINDS.has(message.kind)) run.presence.push(message);
    else run.plain.push(message);
  }
  return run;
}

const VERBS: Partial<Record<MessageKind, string>> = {
  join: "joined",
  part: "left",
  quit: "quit",
  nick: "renamed",
};

/** One line of prose for a run of comings and goings: "3 joined, 1 quit". */
export function describePresence(messages: readonly ChatMessage[]): string {
  const counts = new Map<MessageKind, number>();
  for (const message of messages) {
    counts.set(message.kind, (counts.get(message.kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, n]) => `${n} ${VERBS[kind] ?? "changed"}`).join(", ");
}

export function describeSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}
