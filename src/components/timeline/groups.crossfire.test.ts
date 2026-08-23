import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { assignGroups } from "./groups";

/**
 * What grouping costs when several conversations run at once.
 *
 * A staged channel cannot answer how often exchanges cross, because that is
 * whatever the generator was told to do. It can answer the shape: at a given
 * number of simultaneous conversations, how many exchanges survive and which
 * rule takes the rest. Where a real channel sits on that curve is unmeasured.
 *
 * The interleaving is the load-bearing assumption. Each step picks uniformly
 * among the conversations still owing a turn, which spaces two conversations
 * about as evenly as they can be spaced — the arrangement most likely to make
 * them cross. A real channel where one exchange finishes before the next starts
 * has nothing to separate and loses nothing, so these are worst cases at each
 * density rather than expected values.
 */

/** Reproducible without pulling in a dependency, and without `Math.random`. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PEOPLE = [
  "nyx", "kade", "jolt", "marrow", "sable", "wren", "flint", "juno",
  "brack", "vesper", "coil", "thistle", "orrin", "pike", "quill", "reef",
];

interface Staged {
  messages: ChatMessage[];
  /** Message ids per conversation, in the order they were said. */
  conversations: string[][];
}

/**
 * `pairs` conversations, each between two people who talk only to each other,
 * interleaved into one channel. Every conversation opens with an unaddressed
 * message and answers it with `nick:`, which is the evidence the addressed
 * grade reads.
 */
function stage(pairs: number, turnsEach: number, seed: number): Staged {
  const random = rng(seed);
  const speakers = PEOPLE.slice(0, pairs * 2);
  const owed = Array.from({ length: pairs }, () => turnsEach);
  const said = Array.from({ length: pairs }, (): string[] => []);
  const messages: ChatMessage[] = [];
  let clock = Date.parse("2026-08-03T12:00:00Z");

  while (owed.some((left) => left > 0)) {
    const live = owed.flatMap((left, index) => (left > 0 ? [index] : []));
    const which = live[Math.floor(random() * live.length)]!;
    const turn = turnsEach - owed[which]!;
    const [a, b] = [speakers[which * 2]!, speakers[which * 2 + 1]!];
    const speaker = turn % 2 === 0 ? a : b;
    const addressee = turn % 2 === 0 ? b : a;

    const id = `c${which}t${turn}`;
    messages.push({
      id,
      kind: "privmsg",
      sender: { nick: speaker },
      timestamp: new Date(clock).toISOString(),
      // The opener addresses nobody; everything after it answers.
      text: turn === 0 ? `starting topic ${which}` : `${addressee}: answer ${turn}`,
    } as unknown as ChatMessage);
    said[which]!.push(id);
    owed[which]! -= 1;
    clock += 20_000;
  }

  return { messages, conversations: said };
}

interface Outcome {
  /** Conversations staged. */
  staged: number;
  /** Drawn as one rule, which is what grouping is for. */
  whole: number;
  /** Given no rule at all — the case the open question was about. */
  unmarked: number;
  /** Rules a conversation was chopped into, summed. One is ideal. */
  rules: number;
  /** Messages of a conversation that landed in no group. */
  ungrouped: number;
  /** Messages of a conversation that landed in a group another conversation
   * opened. The rule reaches over intervening talk and takes it in, so this is
   * a message drawn as part of an exchange it was not in. */
  foreign: number;
  messages: number;
  /** Answers whose distance from what they answered is over `ADDRESS_REACH`,
   * so the reach rule refuses them before crossing is ever consulted. */
  answersOutOfReach: number;
  /** Answers inside the reach that still failed to join what they answered.
   * Nothing else can turn these away here — the pair rule cannot fire between
   * two people talking only to each other — so this is the crossing rule. */
  answersCrossed: number;
  answers: number;
}

/** `ADDRESS_REACH` in `groups.ts`, restated so this file can attribute a
 * refusal to it. A copy rather than an export: the study should fail loudly if
 * the rule moves, not quietly follow it. */
const REACH = 3;

const EMPTY: Outcome = {
  staged: 0, whole: 0, unmarked: 0, rules: 0, ungrouped: 0, foreign: 0, messages: 0,
  answersOutOfReach: 0, answersCrossed: 0, answers: 0,
};

function survived(staged: Staged): Outcome {
  const groups = assignGroups(staged.messages, PEOPLE);
  const owner = new Map<string, number>();
  staged.conversations.forEach((ids, index) => ids.forEach((id) => owner.set(id, index)));
  const at = new Map(staged.messages.map((message, index) => [message.id, index]));

  const outcome = { ...EMPTY };
  staged.conversations.forEach((ids, index) => {
    const held = ids.map((id) => groups.get(id));
    const marked = held.filter((group) => group !== undefined);
    const distinct = new Set(marked.map((group) => group!.id));

    outcome.staged += 1;
    outcome.messages += ids.length;
    outcome.ungrouped += ids.length - marked.length;
    outcome.rules += distinct.size;
    if (marked.length === 0) outcome.unmarked += 1;
    else if (marked.length === ids.length && distinct.size === 1) outcome.whole += 1;
    for (const group of marked) {
      if (owner.get(group!.id) !== index) outcome.foreign += 1;
    }

    // Every message after the opener answers the one before it, so each is a
    // chance for the addressed grade to join them and each can be refused.
    for (let turn = 1; turn < ids.length; turn++) {
      const answer = ids[turn]!;
      const answered = ids[turn - 1]!;
      outcome.answers += 1;
      if (at.get(answer)! - at.get(answered)! - 1 > REACH) {
        outcome.answersOutOfReach += 1;
      } else if (groups.get(answer)?.id !== groups.get(answered)?.id) {
        outcome.answersCrossed += 1;
      }
    }
  });
  return outcome;
}

/** Averaged over seeds, because one interleaving is an anecdote. */
function sweep(pairs: number, turnsEach: number, seeds = 40): Outcome {
  const total = { ...EMPTY };
  for (let seed = 1; seed <= seeds; seed++) {
    const one = survived(stage(pairs, turnsEach, seed));
    for (const key of Object.keys(total) as (keyof Outcome)[]) total[key] += one[key];
  }
  return total;
}

describe("grouping under crossfire", () => {
  it("draws one exchange as one rule when only one is happening", () => {
    const outcome = sweep(1, 6);
    expect(outcome.whole).toBe(outcome.staged);
    expect(outcome.ungrouped).toBe(0);
    expect(outcome.foreign).toBe(0);
  });

  /** The curve, printed for `docs/measurements.md`. */
  it("chops exchanges rather than dropping them, as more run at once", () => {
    const rows: string[] = [];
    const outcomes = [1, 2, 3, 4, 6, 8].map((pairs) => [pairs, sweep(pairs, 6)] as const);

    for (const [pairs, o] of outcomes) {
      rows.push(
        `${String(pairs).padStart(2)} at once  ` +
          `one rule ${((o.whole / o.staged) * 100).toFixed(0).padStart(3)}%  ` +
          `no rule ${((o.unmarked / o.staged) * 100).toFixed(0).padStart(3)}%  ` +
          `rules/exchange ${(o.rules / o.staged).toFixed(2)}  ` +
          `ungrouped ${((o.ungrouped / o.messages) * 100).toFixed(0).padStart(3)}%  ` +
          `in someone else's ${((o.foreign / o.messages) * 100).toFixed(0).padStart(3)}%  ` +
          `| answers refused: reach ${((o.answersOutOfReach / o.answers) * 100).toFixed(0).padStart(3)}%  ` +
          `crossing ${((o.answersCrossed / o.answers) * 100).toFixed(0).padStart(3)}%`,
      );
    }
    console.log(rows.join("\n"));

    const [, alone] = outcomes[0]!;
    const [, crowded] = outcomes[outcomes.length - 1]!;
    expect(alone.whole / alone.staged).toBe(1);
    // The failure is fragmentation, not silence: an exchange in a crowd is
    // drawn as several rules rather than as none. If this ever inverts, the
    // cost being reasoned about in `groups.ts` has changed shape.
    expect(crowded.unmarked / crowded.staged).toBeLessThan(0.05);
    expect(crowded.rules / crowded.staged).toBeGreaterThan(1.5);
  });

  /**
   * The shortest exchange there is — one message and one answer — which is the
   * case the open question was actually about, since it either gets a rule or
   * gets nothing. Both refusals are separated, because at eight conversations
   * the reach rule is doing much of the work and it would be easy to credit
   * crossing with all of it.
   */
  it("leaves the shortest exchanges with no rule at all", () => {
    const rows: string[] = [];
    for (const pairs of [1, 2, 3, 4, 6, 8]) {
      const o = sweep(pairs, 2);
      rows.push(
        `${String(pairs).padStart(2)} at once, two messages each  ` +
          `one rule ${((o.whole / o.staged) * 100).toFixed(0).padStart(3)}%  ` +
          `no rule ${((o.unmarked / o.staged) * 100).toFixed(0).padStart(3)}%  ` +
          `| refused by reach ${((o.answersOutOfReach / o.answers) * 100).toFixed(0).padStart(3)}%  ` +
          `by crossing ${((o.answersCrossed / o.answers) * 100).toFixed(0).padStart(3)}%`,
      );
    }
    console.log(rows.join("\n"));

    // Two conversations is the least crowding there is, and the pair rule
    // cannot fire between two people talking only to each other — so whatever
    // a two-message exchange loses at this density, crossing took it.
    const two = sweep(2, 2);
    expect(two.answersOutOfReach).toBe(0);
    expect(two.unmarked).toBeGreaterThan(0);
  });
});
