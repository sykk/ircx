import type { ChatMessage, MessageKind } from "@/types";
import type { ClockFormat } from "@/lib/theme";
import { isHighlight } from "@/store/selectors";
import type { Group } from "./groups";

/**
 * Bounds a run of system messages: a server console holds nothing else, so
 * without it the console would be a single row for the length of the session —
 * one element for the virtualiser to measure however long the output ran.
 *
 * It used to bound a block of speech too, which is what made a block a minute
 * rather than a person. See `RUN_MS`.
 */
export const BUCKET_MS = 60 * 1000;

/**
 * How long one person may go on before their run is broken and their name and
 * the time are stated again.
 *
 * Measured from the run's own first message rather than off a wall clock, which
 * is the whole of the difference from `BUCKET_MS`. A fixed grid splits two
 * lines seconds apart whenever a boundary happens to fall between them, and at
 * a minute wide it did that constantly. Anchored to the run, the break only
 * arrives after somebody has genuinely been talking for five minutes — which is
 * a reason to restate the time rather than an artefact of where the grid fell.
 */
export const RUN_MS = 5 * 60 * 1000;

/** One virtualised item. Blocks and system runs hold several messages each. */
export type TimelineRow =
  | {
      kind: "block";
      id: string;
      messages: ChatMessage[];
      /** What this run belongs to, which is what colours its spine. */
      group: Group | null;
      /** First block of that group: the one that draws the name or the dismiss
       * chip, and the only one whose spine starts rather than continues. */
      opensGroup: boolean;
    }
  | { kind: "system"; id: string; messages: ChatMessage[] }
  | { kind: "date"; id: string; at: string }
  | { kind: "unread"; id: string; seam: Seam }
  /** Where what the server replayed begins, and where it gives way to what
   * this client heard said. */
  | { kind: "history"; id: string; opens: boolean };

/** Which lines failed together, and whether this is the one that says so. */
export interface FailureRun {
  /** Every message of the run, in the order they were said, shared by each
   * row of it — the notice retries all of them. */
  run: ChatMessage[];
  /** The last of the run, which is where the one notice goes. */
  last: boolean;
}

function failureReason(message: ChatMessage): string | null {
  return message.delivery.state === "failed" ? message.delivery.detail : null;
}

/**
 * Consecutive messages that failed for the same reason, which are one event.
 *
 * `abandon_unwritten` fails every line still queued in one pass and gives them
 * all the same reason, so a cut mid-paste produces one run however long the
 * paste was — walked at 78 lines, where a notice on each said one fact
 * seventy-eight times and offered seventy-eight ways to fix it. #341.
 *
 * Adjacency rather than an id carried from the core: the core knows they are
 * one event and the wire does not say so, and nothing yet needs it to. Two
 * failures for the same reason with a sent message between them are two runs,
 * which is what they are.
 */
export function failureRuns(messages: ChatMessage[]): (FailureRun | null)[] {
  const marks: (FailureRun | null)[] = new Array(messages.length).fill(null);

  let start = 0;
  while (start < messages.length) {
    const reason = failureReason(messages[start]!);
    if (reason === null) {
      start += 1;
      continue;
    }
    let end = start + 1;
    while (end < messages.length && failureReason(messages[end]!) === reason) end += 1;

    const run = messages.slice(start, end);
    for (let at = start; at < end; at += 1) marks[at] = { run, last: at === end - 1 };
    start = end;
  }

  return marks;
}

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

/** Comings and goings: weather, and the only kinds the digest may fold away.
 *
 * A mode is in here because a channel where people are handed ops all day
 * reads as one where something is constantly happening, and the line it drew
 * was `syk_ set mode +o syk` — the protocol, not the event. Folded, it is one
 * more clause: `1 took ops`. A kick is not weather and stays out. */
const PRESENCE_KINDS = new Set<MessageKind>(["join", "part", "quit", "nick", "mode"]);

/** What the client and the server print. A console holds nothing else. */
const CONSOLE_KINDS = new Set<MessageKind>(["server", "client"]);

/**
 * Events that change who can read or speak. They are named in the digest's
 * first clause and no control hides them.
 */
const LOUD_KINDS = new Set<MessageKind>(["kick"]);

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
 * Whether `message` belongs to the run already open.
 *
 * Speech continues while one person keeps talking. Anyone else speaking ends
 * the run, which is what makes a block an author rather than an interval, and
 * the kinds that write their own nick into the body (`* nick`, `-nick-`) form
 * their own runs — a header above them would state the name the line is about
 * to state again.
 */
function continuesRun(
  open: Extract<TimelineRow, { kind: "block" | "system" }>,
  message: ChatMessage,
  group: Group | null = null,
): boolean {
  const head = open.messages[0]!;

  const start = Date.parse(head.timestamp);
  const at = Date.parse(message.timestamp);
  if (!Number.isFinite(start) || !Number.isFinite(at)) return false;

  if (open.kind === "system") {
    // Console output keeps the minute, which is the whole reason BUCKET_MS
    // exists. Comings and goings get the run window instead: a netsplit takes
    // minutes to play out, and four digest lines each saying a fraction of it
    // is the repetition the digest was built to end.
    if (CONSOLE_KINDS.has(head.kind)) {
      const bucket = bucketOf(head.timestamp);
      return bucket !== null && bucket === bucketOf(message.timestamp);
    }
    return at - start <= RUN_MS;
  }

  return (
    head.sender.nick === message.sender.nick &&
    writesOwnNick(head.kind) === writesOwnNick(message.kind) &&
    at - start <= RUN_MS &&
    // One block draws one spine, so a run that spans two groups can only show
    // one of them. It used to show the head's, which hid every `walker: …`
    // typed in the middle of somebody's own run — the message was grouped and
    // the block it landed in was not. Splitting costs a repeated name and time
    // where a person says two things about two conversations, which is what
    // has happened when it does.
    group === open.group
  );
}

export function buildRows(
  messages: readonly ChatMessage[],
  unreadFrom: string | null,
  ownNick: string | null = null,
  groups: ReadonlyMap<string, Group> = new Map(),
  present?: ReadonlySet<string>,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let open: Extract<TimelineRow, { kind: "block" | "system" }> | null = null;
  let openDay: string | null = null;
  // The group the block above belonged to. A group spans several author blocks,
  // so whether this one opens it cannot be read off the block alone.
  let openGroupId: string | null = null;
  let inHistory = false;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;

    // A rule across the pane ends the group's rule with it: a line that runs
    // past a date change or the unread seam claims those are one exchange, and
    // the reader has just been told they are not. The group starts again below,
    // which is also how its name comes back after the break.
    const day = dayOf(message.timestamp);
    if (day !== null && day !== openDay) {
      openDay = day;
      open = null;
      openGroupId = null;
      rows.push({ kind: "date", id: `d:${day}`, at: message.timestamp });
    }

    // Under the date and above the seam: the day is the outermost fact about a
    // message and the seam is the innermost, being the one thing the reader has
    // to act on.
    //
    // A replayed run is bounded rather than tinted, for the reason the date
    // rule is: the boundary is the fact, and marking every message inside it
    // says the same thing once per line. Only what the server replayed this
    // session is bounded — a message read back from the archive is
    // `localArchive`, so the rule does not come back on the next launch to
    // relitigate history the reader has already caught up on.
    const history = message.source === "serverHistory";
    if (history !== inHistory) {
      inHistory = history;
      open = null;
      openGroupId = null;
      rows.push({ kind: "history", id: `h:${message.id}`, opens: history });
    }

    if (unreadFrom !== null && message.id === unreadFrom) {
      open = null;
      openGroupId = null;
      rows.push({
        kind: "unread",
        id: "unread",
        seam: measureSeam(messages.slice(i), ownNick, present),
      });
    }

    const system = isSystemKind(message.kind);
    const wanted = system ? "system" : "block";
    const group = system ? null : (groups.get(message.id) ?? null);

    if (open !== null && open.kind === wanted && continuesRun(open, message, group)) {
      open.messages.push(message);
      continue;
    }

    // Named for the message that opened the run, message ids being unique
    // already. The id used to name the bucket, and there is no bucket now.
    if (system) {
      // The group is not over: `assignGroups` never saw this line, because
      // nobody said it. A digest of joins draws no rule, and the exchange
      // either side of it is still one exchange, so `openGroupId` stands.
      //
      // Resetting it here is what made a channel with ordinary comings and
      // goings draw the same group four times, each with its own name and its
      // own dismiss chip — the model saying one group and the rows saying four.
      open = { kind: "system", id: `s:${message.id}`, messages: [message] };
    } else {
      // Every message in the block shares this group: `continuesRun` will not
      // add one that does not.
      open = {
        kind: "block",
        id: `b:${message.id}`,
        messages: [message],
        group,
        opensGroup: group !== null && group.id !== openGroupId,
      };
      openGroupId = group?.id ?? null;
    }
    rows.push(open);
  }

  return rows;
}

/** Rows that carry messages. Date rules and the seam carry none. */
export function rowMessages(row: TimelineRow): readonly ChatMessage[] {
  return row.kind === "block" || row.kind === "system" ? row.messages : [];
}

/** Presence is not counted: the seam measures what people said. */
function measureSeam(
  unread: readonly ChatMessage[],
  ownNick: string | null,
  present?: ReadonlySet<string>,
): Seam {
  const speech = unread.filter((m) => !isSystemKind(m.kind));
  const first = speech[0];
  const last = speech[speech.length - 1];
  return {
    messages: speech.length,
    people: new Set(speech.map((m) => m.sender.nick)).size,
    spanMs: first && last ? Math.max(0, Date.parse(last.timestamp) - Date.parse(first.timestamp)) : 0,
    mentions: speech.filter((m) => isHighlight(m, ownNick, present)).length,
  };
}

/**
 * The time in the viewer's timezone, in the format they chose, without
 * locale-dependent separators.
 *
 * Null when they chose none, which every caller draws as nothing rather than as
 * an empty slot: a clock turned off in the timeline and still printed beside a
 * search hit would be two answers to one question.
 */
export function formatClock(timestamp: string, format: ClockFormat): string | null {
  if (format === "off") return null;
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return "--:--";

  const minutes = String(at.getMinutes()).padStart(2, "0");
  if (format === "12h") {
    return `${at.getHours() % 12 || 12}:${minutes} ${at.getHours() < 12 ? "AM" : "PM"}`;
  }

  const clock = `${String(at.getHours()).padStart(2, "0")}:${minutes}`;
  if (format === "24h") return clock;
  return `${clock}:${String(at.getSeconds()).padStart(2, "0")}`;
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

/**
 * What one of these did, in the words the digest counts by.
 *
 * A mode carries its own: core writes `took ops` rather than `+o`, so two
 * people being handed ops are one clause and somebody losing voice is another.
 * Everything else has a verb per kind.
 */
function presenceVerb(message: ChatMessage): string {
  if (message.kind !== "mode") return VERBS[message.kind] ?? "changed";
  return message.text.trim() === "" ? "changed the channel" : message.text.trim();
}

/** One line of prose for a run of comings and goings: "3 joined, 1 quit". */
export function describePresence(messages: readonly ChatMessage[]): string {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const verb = presenceVerb(message);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  return [...counts].map(([verb, n]) => `${n} ${verb}`).join(", ");
}

/**
 * How long the run covered, or null when that is not worth a reader's time.
 *
 * A burst inside one minute is a burst. Four minutes of it is a netsplit, and
 * knowing it is one event rather than several is the difference between
 * skipping the line and going looking for what happened.
 */
export function describePresenceSpan(messages: readonly ChatMessage[]): string | null {
  const first = Date.parse(messages[0]?.timestamp ?? "");
  const last = Date.parse(messages[messages.length - 1]?.timestamp ?? "");
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
  const span = describeSpan(Math.max(0, last - first));
  return span === "under a minute" ? null : `Over ${span}`;
}

/**
 * How many of these are about the reader: their own coming or going, or a
 * parting line that names them.
 *
 * Presence is skippable exactly when this is zero, and a digest that does not
 * say so leaves the reader opening it to find out — which is the reading the
 * fold exists to save them.
 */
export function presenceInvolving(
  messages: readonly ChatMessage[],
  ownNick: string | null,
): number {
  return messages.filter((m) => m.sender.isSelf || isHighlight(m, ownNick)).length;
}

/** The whole digest: how long, what happened, and whether it was about you. */
export function describePresenceRun(
  messages: readonly ChatMessage[],
  ownNick: string | null,
): string {
  const span = describePresenceSpan(messages);
  const involving = presenceInvolving(messages, ownNick);
  // Nothing is said when none of it was about the reader. Saying so put a
  // sentence on every digest to report an absence, and a digest that names
  // nobody already means nobody.
  const clause =
    involving === 0
      ? ""
      : ` ${involving} of them ${involving === 1 ? "involves" : "involve"} you.`;
  return `${span === null ? "" : `${span}: `}${describePresence(messages)}.${clause}`;
}

export function describeSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
}
