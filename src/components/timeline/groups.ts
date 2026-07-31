import type { ChatMessage } from "@/types";

/**
 * Which messages belong together, and how sure the client is that they do.
 *
 * `readability/ircx-live-studies.html` argues grouping is three grades rather
 * than two: a bracketed topic the sender typed is a fact, IRC's `nick:`
 * convention is near-certain, and everything else is a guess. Drawing all three
 * at one strength is the interface claiming to know more than it does.
 *
 * Stroke ranks certainty and hue names the group — `READABILITY.md:236`. Hue
 * has no order, so it cannot carry "how sure"; certainty is ordinal, so it
 * cannot be a colour. The two questions are independent and are answered by
 * two properties that cannot be mistaken for one another.
 */
export type Grade = "declared" | "addressed" | "guessed";

export interface Group {
  /** The id of the message that opened it, and the group's identity. */
  id: string;
  grade: Grade;
  /** Declared only. It is the one grade a human named, so the only one named. */
  name: string | null;
  /** Whose nick colours the rule: whoever opened the group. */
  opener: string;
}

/**
 * A bracket at the head of a line, bounded so a message opening with a long
 * quotation is not read as a topic. `[` and `]` are legal in a nick, but not at
 * the start of a line followed by text, so this cannot swallow an address.
 */
const DECLARED = /^\[([^\]\n]{1,24})\]\s+/;

/**
 * `nick:` or `nick,` at the head of a line. The charset is RFC 2812's, which
 * allows `[]\`^{}|-` — a client that only accepted word characters would miss a
 * good share of real nicks.
 *
 * Matching the shape is not enough on its own: `TODO:`, `note:` and the scheme
 * of a bare URL all match it. The nick has to have actually spoken, which is
 * what `assignGroups` checks.
 */
const ADDRESSED = /^([A-Za-z0-9_[\]\\`^{}|-]{2,16})[:,]\s/;

/** How far back a nick must have spoken for an address to it to mean anything. */
const ADDRESS_LOOKBACK_MS = 15 * 60 * 1000;

/** Silence that ends a guessed group. Longer than a pause, shorter than a topic. */
const GUESS_GAP_MS = 2 * 60 * 1000;

/**
 * Silence that ends a declared one. Longer than a guess, because somebody named
 * this topic and a pause in a named conversation is still that conversation.
 *
 * Not much longer, though, and the first draft of this had it at ten minutes.
 * A declared group runs forward until something stops it, so a window wide
 * enough to survive a pause is also wide enough to swallow whatever the channel
 * turned to next — and it did, taking an unrelated exchange eight minutes later
 * into a group named for a bug nobody was discussing any more. Naming a topic
 * says what this is about, not that the channel is yours until you say stop.
 */
const DECLARED_GAP_MS = 5 * 60 * 1000;

/**
 * The floor a guess has to clear, below which it is not drawn at all.
 *
 * One person talking is an author block, which already draws its own edge and
 * states their name — grouping it says nothing the reader did not have. Two
 * messages is a remark and a reply, which is what a conversation looks like
 * when nothing is happening. The study's rule is that a guess below a size and
 * confidence floor is not drawn, and this is where that floor sits.
 */
const GUESS_MIN_MESSAGES = 3;
const GUESS_MIN_PEOPLE = 2;

/** The topic a sender declared, or null. */
export function declaredName(text: string): string | null {
  return DECLARED.exec(text)?.[1]?.trim() || null;
}

/**
 * What to draw for a message: its own text, less a bracket that has become the
 * group's name and would otherwise be printed twice.
 *
 * The archive keeps the raw text, so search still matches what was typed.
 */
export function bodyText(message: ChatMessage): string {
  const found = DECLARED.exec(message.text);
  return found ? message.text.slice(found[0].length) : message.text;
}

function isSpeech(message: ChatMessage): boolean {
  return message.kind === "privmsg" || message.kind === "action";
}

function at(message: ChatMessage): number {
  const parsed = Date.parse(message.timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function fold(nick: string): string {
  return nick.toLowerCase();
}

/**
 * Every message that belongs to a group, mapped to the group it belongs to.
 *
 * Declared beats addressed beats guessed, and a message is in at most one
 * group — the study's rule, and the reason this is one pass in precedence order
 * rather than three passes that would have to argue about overlaps.
 *
 * `dismissed` holds group ids the reader has waved away. Only a guess can be
 * dismissed, because only a guess is the client's own idea.
 */
export function assignGroups(
  messages: readonly ChatMessage[],
  dismissed: ReadonlySet<string> = new Set(),
): Map<string, Group> {
  const groups = new Map<string, Group>();
  const speech = messages.filter(isSpeech);

  // Declared. Naming a topic opens a group, and what follows joins it without
  // anybody having to type the bracket again — which is the whole point of
  // naming it. The same name said later rejoins rather than opening a second.
  const byName = new Map<string, Group>();
  let declaring: Group | null = null;
  let previous: ChatMessage | null = null;
  for (const message of speech) {
    const name = declaredName(message.text);
    if (name !== null) {
      const key = name.toLowerCase();
      let group = byName.get(key);
      if (group === undefined) {
        group = { id: message.id, grade: "declared", name, opener: message.sender.nick };
        byName.set(key, group);
      }
      declaring = group;
    } else if (
      declaring !== null &&
      (previous === null || at(message) - at(previous) > DECLARED_GAP_MS)
    ) {
      // The conversation stopped and something else started. A rule drawn
      // across that silence would claim they were one topic.
      declaring = null;
    }
    if (declaring !== null) groups.set(message.id, declaring);
    previous = message;
  }

  // Addressed. The message joins whatever the person it names is already in;
  // if they are in nothing, they open a group and it takes their colour, since
  // theirs is the message that started the exchange.
  const lastSpoke = new Map<string, ChatMessage>();
  for (const message of speech) {
    const spokenTo = ADDRESSED.exec(message.text)?.[1];
    const previous = spokenTo === undefined ? undefined : lastSpoke.get(fold(spokenTo));
    lastSpoke.set(fold(message.sender.nick), message);

    if (previous === undefined || groups.has(message.id)) continue;
    if (at(message) - at(previous) > ADDRESS_LOOKBACK_MS) continue;
    // Answering yourself is not an exchange.
    if (fold(previous.sender.nick) === fold(message.sender.nick)) continue;

    const existing = groups.get(previous.id);
    if (existing !== undefined) {
      groups.set(message.id, existing);
      continue;
    }
    const group: Group = {
      id: previous.id,
      grade: "addressed",
      name: null,
      opener: previous.sender.nick,
    };
    groups.set(previous.id, group);
    groups.set(message.id, group);
  }

  // Guessed. Runs of speech with no long silence in them, kept only when
  // several people said several things — and dropped the moment the reader says
  // it was not a group.
  for (const run of runsByTiming(speech)) {
    const free = run.filter((message) => !groups.has(message.id));
    if (free.length < GUESS_MIN_MESSAGES) continue;
    if (new Set(free.map((message) => fold(message.sender.nick))).size < GUESS_MIN_PEOPLE) continue;

    const opener = free[0]!;
    if (dismissed.has(opener.id)) continue;
    const group: Group = {
      id: opener.id,
      grade: "guessed",
      name: null,
      opener: opener.sender.nick,
    };
    for (const message of free) groups.set(message.id, group);
  }

  return groups;
}

/** Consecutive speech with no `GUESS_GAP_MS` of silence inside it. */
function runsByTiming(speech: readonly ChatMessage[]): ChatMessage[][] {
  const runs: ChatMessage[][] = [];
  let open: ChatMessage[] = [];
  for (const message of speech) {
    const previous = open[open.length - 1];
    if (previous !== undefined && at(message) - at(previous) > GUESS_GAP_MS) {
      runs.push(open);
      open = [];
    }
    open.push(message);
  }
  if (open.length > 0) runs.push(open);
  return runs;
}
