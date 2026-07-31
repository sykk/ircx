import type { ChatMessage } from "@/types";

/**
 * Which messages belong together, on the evidence of what people typed.
 *
 * `readability/ircx-live-studies.html` names three grades: a bracketed topic
 * the sender typed is a fact, IRC's `nick:` convention is near-certain, and
 * everything else is a guess from timing and participants. Two are built.
 *
 * **The guess is not, and the reason is worth keeping.** It shipped, and a run
 * against a real channel showed what it does: grouping exists to separate
 * conversations happening at once, and a channel where everybody is in the same
 * conversation has nothing to separate. Twenty messages between three people
 * came back as one group spanning the lot — a rule down the whole screen,
 * distinguishing nothing, and saying "not sure" about every line in the
 * channel. No threshold fixes that; a shorter gap only chops one conversation
 * into arbitrary pieces. The version worth building fires only when it
 * separates two disjoint sets of people in the same window, and that is
 * clustering rather than a timer.
 *
 * So the spine is coloured where somebody's own words grouped it, and stays
 * neutral otherwise. Hue names the group — `READABILITY.md:236` — taken from
 * whoever opened it.
 */
export type Grade = "declared" | "addressed";

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

/**
 * Silence that ends a declared group. Long enough that a pause in a named
 * conversation is still that conversation.
 *
 * Not much longer, though, and the first draft of this had it at ten minutes.
 * A declared group runs forward until something stops it, so a window wide
 * enough to survive a pause is also wide enough to swallow whatever the channel
 * turned to next — and it did, taking an unrelated exchange eight minutes later
 * into a group named for a bug nobody was discussing any more. Naming a topic
 * says what this is about, not that the channel is yours until you say stop.
 */
const DECLARED_GAP_MS = 5 * 60 * 1000;

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
 * Declared beats addressed and a message is in at most one group — the study's
 * rule, and the reason this is one pass in precedence order rather than two
 * that would have to argue about overlaps.
 */
export function assignGroups(messages: readonly ChatMessage[]): Map<string, Group> {
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

  return groups;
}
