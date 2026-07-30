import type { ChatMessage, MessageKind } from "@/types";
import { isHighlight } from "@/store/selectors";

/**
 * A minute of the conversation, whoever spoke during it. It bounds a run of
 * system messages too: a server console holds nothing else, so without it the
 * console would be a single row for the length of the session — one element for
 * the virtualiser to measure however long the output ran.
 */
export const BUCKET_MS = 60 * 1000;

/** One virtualised item. Blocks and system runs hold several messages each. */
export type TimelineRow =
  | { kind: "block"; id: string; messages: ChatMessage[] }
  | { kind: "system"; id: string; messages: ChatMessage[] }
  | { kind: "date"; id: string; at: string }
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

/** Kinds that print their own nick in the body: `* nick` and `-nick-`. */
const OWN_NICK_KINDS = new Set<MessageKind>(["action", "notice"]);

function isSystemKind(kind: MessageKind): boolean {
  return SYSTEM_KINDS.has(kind);
}

export function writesOwnNick(kind: MessageKind): boolean {
  return OWN_NICK_KINDS.has(kind);
}

function bucketOf(timestamp: string): number | null {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? Math.floor(at / BUCKET_MS) : null;
}

/** Local calendar day, which is what a date separator divides. */
function dayOf(timestamp: string): string | null {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

/**
 * A minute can open more than one block — a burst of joins between two
 * sentences splits it — so the bucket alone is not a key. The suffix keeps
 * React and the virtualiser's measurement cache on distinct rows while the
 * first block of a bucket keeps its id when older history merges into it.
 */
function uniqueId(taken: Map<string, number>, base: string): string {
  const n = (taken.get(base) ?? 0) + 1;
  taken.set(base, n);
  return n === 1 ? base : `${base}#${n}`;
}

export function buildRows(
  messages: readonly ChatMessage[],
  unreadFrom: string | null,
  ownNick: string | null = null,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  const taken = new Map<string, number>();
  let open: Extract<TimelineRow, { kind: "block" | "system" }> | null = null;
  let openBucket: number | null = null;
  let openDay: string | null = null;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    const day = dayOf(message.timestamp);
    if (day !== null && day !== openDay) {
      openDay = day;
      open = null;
      rows.push({ kind: "date", id: `d:${day}`, at: message.timestamp });
    }

    if (unreadFrom !== null && message.id === unreadFrom) {
      open = null;
      rows.push({ kind: "unread", id: "unread", seam: measureSeam(messages.slice(i), ownNick) });
    }

    const system = isSystemKind(message.kind);
    const bucket = bucketOf(message.timestamp);
    const continues =
      open?.kind === (system ? "system" : "block") && bucket !== null && bucket === openBucket;

    if (continues && open) {
      open.messages.push(message);
      continue;
    }

    open = system
      ? { kind: "system", id: `s:${message.id}`, messages: [message] }
      : {
          kind: "block",
          id: uniqueId(taken, bucket === null ? `b:${message.id}` : `b:${bucket}`),
          messages: [message],
        };
    openBucket = bucket;
    rows.push(open);
  }

  return rows;
}

/** Rows that carry messages. Date rules and the seam carry none. */
export function rowMessages(row: TimelineRow): readonly ChatMessage[] {
  return row.kind === "block" || row.kind === "system" ? row.messages : [];
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

/** Narrow enough that the ladder still reads as a column under a short nick. */
const MIN_NICK_CH = 4;

/**
 * Width of a block's nick column in monospace character advances, sized to the
 * widest nick the block actually holds. A block of `nyx` and `kade` therefore
 * sits closer to its text than one containing `phrack`, and the nick never
 * truncates: the name is the identifier and colour only reinforces it.
 *
 * Actions and notices write their nick into the body, so they leave the column
 * empty and do not widen it.
 */
export function nickColumnCh(messages: readonly ChatMessage[]): number {
  let widest = MIN_NICK_CH;
  for (const message of messages) {
    if (writesOwnNick(message.kind)) continue;
    widest = Math.max(widest, message.sender.nick.length);
  }
  return widest;
}

/** `HH:MM` in the viewer's timezone, without locale-dependent separators. */
export function formatClock(timestamp: string): string {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return "--:--";
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
}

/** The label on a date rule: near days by name, older ones by date. */
export function describeDay(timestamp: string, now: Date = new Date()): string {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return "Undated";
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const sameYear = at.getFullYear() === now.getFullYear();
  return at.toLocaleDateString("en-GB", {
    weekday: sameYear ? "short" : undefined,
    day: "numeric",
    month: "long",
    year: sameYear ? undefined : "numeric",
  });
}

/** Row index holding `messageId`, or -1. Drives the jump from a reply quote. */
export function rowIndexOfMessage(rows: readonly TimelineRow[], messageId: string): number {
  return rows.findIndex((row) => rowMessages(row).some((m) => m.id === messageId));
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
