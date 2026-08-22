import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { NO_HIGHLIGHT } from "@/store/selectors";
import { makeConversation, makeMessage } from "./fixtures";
import {
  BUCKET_MS,
  buildRows,
  describeDay,
  describePresence,
  describePresenceRun,
  describeSpan,
  formatClock,
  failureRuns,
  partitionSystemRun,
  rowIndexOfMessage,
  rowMessages,
  RUN_MS,
  type TimelineRow,
} from "./rows";

const START = Date.parse("2026-07-29T02:00:00.000Z");

function at(offsetMs: number, over: Parameters<typeof makeMessage>[0] = {}) {
  return makeMessage({ timestamp: new Date(START + offsetMs).toISOString(), ...over });
}

function blocks(rows: TimelineRow[]) {
  return rows.filter((row) => row.kind === "block");
}

describe("buildRows blocks", () => {
  it("gives each speaker their own block, however fast they take turns", () => {
    const rows = buildRows(
      [
        at(0, { id: "a", nick: "sable" }),
        at(1000, { id: "b", nick: "phrack" }),
        at(2000, { id: "c", nick: "sable" }),
      ],
      null,
    );
    expect(blocks(rows).map((row) => row.messages.map((m) => m.id))).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps one speaker's consecutive lines together", () => {
    const rows = buildRows(
      [
        at(0, { id: "a", nick: "sable" }),
        at(1000, { id: "b", nick: "sable" }),
        at(2000, { id: "c", nick: "sable" }),
      ],
      null,
    );
    expect(blocks(rows).map((row) => row.messages.map((m) => m.id))).toEqual([["a", "b", "c"]]);
  });

  // The defect this replaced: on a wall-clock grid two lines seconds apart fell
  // in different buckets whenever a boundary landed between them, and the
  // speaker was split for no reason the reader could see.
  it("does not split a speaker on a clock boundary they happened to cross", () => {
    const rows = buildRows(
      [
        at(BUCKET_MS - 1, { id: "a", nick: "sable" }),
        at(BUCKET_MS + 1, { id: "b", nick: "sable" }),
      ],
      null,
    );
    expect(blocks(rows).map((row) => row.messages.map((m) => m.id))).toEqual([["a", "b"]]);
  });

  it("breaks a run once one person has held the floor for RUN_MS", () => {
    const rows = buildRows(
      [
        at(0, { id: "a", nick: "sable" }),
        at(RUN_MS, { id: "b", nick: "sable" }),
        at(RUN_MS + 1, { id: "c", nick: "sable" }),
      ],
      null,
    );
    expect(blocks(rows).map((row) => row.messages.map((m) => m.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("runs a kind that writes its own nick separately from the same nick's speech", () => {
    const rows = buildRows(
      [
        at(0, { id: "a", nick: "sable" }),
        at(1000, { id: "b", nick: "sable", kind: "action" }),
        at(2000, { id: "c", nick: "sable", kind: "notice" }),
        at(3000, { id: "d", nick: "sable" }),
      ],
      null,
    );
    expect(blocks(rows).map((row) => row.messages.map((m) => m.id))).toEqual([
      ["a"],
      ["b", "c"],
      ["d"],
    ]);
  });

  // The id used to name the minute so it survived a prepend. A run is named for
  // the message that opened it instead, and older history merging into one
  // renames it — which costs that block a re-measure and nothing else.
  it("merges older history into the run it continues", () => {
    const merged = blocks(buildRows([at(10_000, { id: "a" }), at(30_000, { id: "b" })], null));

    expect(merged).toHaveLength(1);
    expect(merged[0]!.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(merged[0]!.id).toBe("b:a");
  });

  it("gives distinct ids to two blocks a burst of joins split apart", () => {
    const rows = buildRows(
      [
        at(0, { id: "a" }),
        at(1000, { id: "j", kind: "join", text: "" }),
        at(2000, { id: "b" }),
      ],
      null,
    );
    const ids = blocks(rows).map((row) => row.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("gives a message its own block when the server mangled the timestamp", () => {
    const rows = buildRows(
      [makeMessage({ id: "a", timestamp: "not a date" }), makeMessage({ id: "b", timestamp: "" })],
      null,
    );
    expect(blocks(rows).map((row) => row.id)).toEqual(["b:a", "b:b"]);
  });
});

describe("buildRows date rules", () => {
  it("opens the timeline with a date rule and repeats it on each new day", () => {
    const rows = buildRows(
      [
        makeMessage({ id: "a", timestamp: new Date(2026, 6, 28, 23, 55).toISOString() }),
        makeMessage({ id: "b", timestamp: new Date(2026, 6, 29, 0, 5).toISOString() }),
        makeMessage({ id: "c", timestamp: new Date(2026, 6, 29, 0, 6).toISOString() }),
      ],
      null,
    );
    expect(rows.map((row) => row.kind)).toEqual(["date", "block", "date", "block"]);
  });

  it("ends the open block, so no block spans a day", () => {
    const rows = buildRows(
      [
        makeMessage({ id: "a", timestamp: new Date(2026, 6, 28, 23, 59, 10).toISOString() }),
        makeMessage({ id: "b", timestamp: new Date(2026, 6, 28, 23, 59, 20).toISOString() }),
        makeMessage({ id: "c", timestamp: new Date(2026, 6, 29, 0, 0, 10).toISOString() }),
      ],
      null,
    );
    expect(blocks(rows).map((row) => row.messages.map((m) => m.id))).toEqual([["a", "b"], ["c"]]);
  });
});

describe("buildRows system runs", () => {
  it("collects a burst of joins and parts into one row", () => {
    const rows = buildRows(
      [
        at(0, { id: "a", kind: "join" }),
        at(1000, { id: "b", kind: "part" }),
        at(2000, { id: "c", kind: "quit" }),
        at(3000, { id: "d", kind: "privmsg" }),
      ],
      null,
    );
    expect(rows.map((r) => r.kind)).toEqual(["date", "system", "block"]);
    expect(rows[1]).toMatchObject({ id: "s:a" });
  });

  /** A netsplit takes minutes to play out. Bounded by the minute, it arrived as
   * several digest lines each stating a fraction of one event. */
  it("holds a burst of comings and goings that runs for minutes", () => {
    const rows = buildRows(
      [at(0, { id: "a", kind: "join" }), at(4 * BUCKET_MS, { id: "b", kind: "quit" })],
      null,
    );
    expect(rows.filter((r) => r.kind === "system").map((r) => r.messages.map((m) => m.id))).toEqual(
      [["a", "b"]],
    );
  });

  it("still ends that run, so no row grows without bound", () => {
    const rows = buildRows(
      [at(0, { id: "a", kind: "join" }), at(RUN_MS + 1, { id: "b", kind: "quit" })],
      null,
    );
    expect(rows.filter((r) => r.kind === "system").map((r) => r.messages.map((m) => m.id))).toEqual(
      [["a"], ["b"]],
    );
  });

  it("keeps a console's steady output out of one ever-growing row", () => {
    // A server console holds nothing but system messages, so before the minute
    // bounded them the whole session was a single row.
    const lines = Array.from({ length: 4 }, (_, i) =>
      at(i * BUCKET_MS, { id: `l${i}`, kind: "server", text: `line ${i}` }),
    );
    expect(buildRows(lines, null).filter((r) => r.kind === "system")).toHaveLength(4);
  });

  it("digests a mode with the rest of the weather, and never a kick", () => {
    const run = partitionSystemRun([
      at(0, { id: "a", kind: "join" }),
      at(1, { id: "b", kind: "join" }),
      at(2, { id: "c", kind: "part" }),
      at(3, { id: "d", kind: "mode" }),
      at(4, { id: "e", kind: "kick" }),
      at(5, { id: "f", kind: "server" }),
    ]);

    expect(run.presence.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(run.loud.map((m) => m.id)).toEqual(["e"]);
    expect(run.plain.map((m) => m.id)).toEqual(["f"]);
  });

  it("states the presence digest as one line of prose", () => {
    const presence = [
      at(0, { id: "a", kind: "join" }),
      at(1, { id: "b", kind: "join" }),
      at(2, { id: "c", kind: "part" }),
      at(3, { id: "d", kind: "nick" }),
    ];
    expect(describePresence(presence)).toBe("2 joined, 1 left, 1 renamed");
  });
});

describe("describePresenceRun", () => {
  const joins = (count: number, everyMs: number, over: Parameters<typeof at>[1] = {}) =>
    Array.from({ length: count }, (_, i) =>
      at(i * everyMs, { id: `s${i}`, kind: "join", ...over }),
    );

  it("leads with how long it ran once that is worth saying", () => {
    expect(describePresenceRun(joins(4, 90_000), null)).toBe(
      "Over 5 minutes: 4 joined.",
    );
  });

  /** A burst inside one minute is a burst. Saying so costs a clause and tells
   * the reader nothing they would act on. */
  it("says nothing about a span under a minute", () => {
    expect(describePresenceRun(joins(3, 1000), null)).toBe("3 joined.");
  });

  it("counts a line that names the reader", () => {
    const run = [
      at(0, { id: "a", kind: "quit", text: "sable: back later" }),
      at(1, { id: "b", kind: "join" }),
    ];
    expect(describePresenceRun(run, "sable")).toBe("1 quit, 1 joined. 1 of them involves you.");
  });

  it("agrees with itself about singular and plural", () => {
    const run = [
      at(0, { id: "a", kind: "quit", text: "sable: one" }),
      at(1, { id: "b", kind: "quit", text: "sable: two" }),
    ];
    expect(describePresenceRun(run, "sable")).toBe("2 quit. 2 of them involve you.");
  });
});

describe("buildRows unread divider", () => {
  it("places the rule before the first unread message", () => {
    const rows = buildRows(
      [at(0, { id: "a" }), at(BUCKET_MS, { id: "b" }), at(2 * BUCKET_MS, { id: "c" })],
      "b",
    );
    expect(rows.map((r) => r.kind)).toEqual(["date", "block", "unread", "block"]);
  });

  it("splits a block that would otherwise span the rule", () => {
    const rows = buildRows([at(0, { id: "a" }), at(1000, { id: "b" })], "b");
    expect(blocks(rows).map((row) => row.messages.map((m) => m.id))).toEqual([["a"], ["b"]]);
    expect(new Set(blocks(rows).map((row) => row.id)).size).toBe(2);
  });

  it("emits no rule when the marker is cleared", () => {
    const rows = buildRows([at(0, { id: "a" })], null);
    expect(rows.some((r) => r.kind === "unread")).toBe(false);
  });

  it("emits no rule when the marked message is not loaded", () => {
    const rows = buildRows([at(0, { id: "a" })], "missing");
    expect(rows.some((r) => r.kind === "unread")).toBe(false);
  });

  it("measures what was missed, counting speech and not weather", () => {
    const rows = buildRows(
      [
        at(0, { id: "read", nick: "sable" }),
        at(1000, { id: "b", nick: "phrack", text: "sable: look" }),
        at(2000, { id: "c", nick: "phrack", kind: "join" }),
        at(3000, { id: "d", nick: "nyx", text: "and this" }),
        at(60_000 * 90, { id: "e", nick: "nyx", text: "sableton is elsewhere" }),
      ],
      "b",
      { nick: "sable", words: [] },
    );

    const divider = rows.find((r) => r.kind === "unread");
    expect(divider).toMatchObject({
      seam: { messages: 3, people: 2, mentions: 1 },
    });
  });
});

describe("describeDay", () => {
  const now = new Date(2026, 6, 29, 12, 0);

  it("names the days a reader thinks of by name", () => {
    expect(describeDay(new Date(2026, 6, 29, 1, 0).toISOString(), now)).toBe("Today");
    expect(describeDay(new Date(2026, 6, 28, 23, 0).toISOString(), now)).toBe("Yesterday");
  });

  it("dates anything older, and names the year once it differs", () => {
    expect(describeDay(new Date(2026, 6, 25, 9, 0).toISOString(), now)).toBe("Sat 25 July");
    expect(describeDay(new Date(2025, 10, 3, 9, 0).toISOString(), now)).toBe("3 November 2025");
  });

  it("does not throw on a timestamp the server mangled", () => {
    expect(describeDay("not a date", now)).toBe("Undated");
  });
});

describe("describeSpan", () => {
  it("rounds to a unit a reader can act on", () => {
    expect(describeSpan(20_000)).toBe("under a minute");
    expect(describeSpan(60_000)).toBe("1 minute");
    expect(describeSpan(45 * 60_000)).toBe("45 minutes");
    expect(describeSpan(9 * 3_600_000)).toBe("9 hours");
    expect(describeSpan(5 * 86_400_000)).toBe("5 days");
  });
});

describe("rowIndexOfMessage", () => {
  it("finds a message inside a multi-message block", () => {
    const rows = buildRows([at(0, { id: "a" }), at(1000, { id: "b" })], null);
    expect(rowIndexOfMessage(rows, "b")).toBe(1);
    expect(rowIndexOfMessage(rows, "nope")).toBe(-1);
  });
});

describe("formatClock", () => {
  it("pads to HH:MM", () => {
    const stamp = new Date(2026, 6, 29, 2, 5).toISOString();
    expect(formatClock(stamp, "24h")).toBe("02:05");
  });

  it("pads the seconds too", () => {
    const stamp = new Date(2026, 6, 29, 2, 5, 7).toISOString();
    expect(formatClock(stamp, "24h-seconds")).toBe("02:05:07");
  });

  it("writes midnight and noon as 12 rather than 0", () => {
    const midnight = new Date(2026, 6, 29, 0, 5).toISOString();
    const noon = new Date(2026, 6, 29, 12, 5).toISOString();
    expect(formatClock(midnight, "12h")).toBe("12:05 AM");
    expect(formatClock(noon, "12h")).toBe("12:05 PM");
  });

  it("does not pad the hour in 12-hour", () => {
    const stamp = new Date(2026, 6, 29, 14, 32).toISOString();
    expect(formatClock(stamp, "12h")).toBe("2:32 PM");
  });

  /* The suffix is what a 12-hour clock costs in width, and a reader watching a
     channel in one afternoon already knows which half of the day it is. */
  it("drops AM and PM but keeps the 12-hour reading", () => {
    const morning = new Date(2026, 6, 29, 2, 5).toISOString();
    const afternoon = new Date(2026, 6, 29, 14, 32).toISOString();
    expect(formatClock(morning, "12h-bare")).toBe("2:05");
    expect(formatClock(afternoon, "12h-bare")).toBe("2:32");
  });

  it("gives nothing to draw when the clock is off", () => {
    const stamp = new Date(2026, 6, 29, 2, 5).toISOString();
    expect(formatClock(stamp, "off")).toBeNull();
    /* Before the date is even looked at: off is off whatever arrived. */
    expect(formatClock("not a date", "off")).toBeNull();
  });

  it("does not throw on a timestamp the server mangled", () => {
    expect(formatClock("not a date", "24h")).toBe("--:--");
  });
});

/**
 * #618. A search jump files a window read around the hit over the conversation,
 * and that window can end hours short of the present. The line the channel says
 * next is drawn under it, and nothing in either message says the two are not
 * each other's neighbours.
 */
describe("buildRows gap rule", () => {
  const held = [at(0, { id: "a" }), at(1000, { id: "b" })];

  it("draws no rule while the window still reaches the present", () => {
    const rows = buildRows(held, null, NO_HIGHLIGHT, new Map(), undefined, null);

    expect(rows.map((row) => row.kind)).toEqual(["date", "block"]);
  });

  it("draws none for a detached window nothing has landed on yet", () => {
    const rows = buildRows(held, null, NO_HIGHLIGHT, new Map(), undefined, "b");

    expect(rows.map((row) => row.kind)).toEqual(["date", "block"]);
  });

  it("breaks the run where the present resumes", () => {
    const rows = buildRows(
      [...held, at(2000, { id: "c" })],
      null,
      NO_HIGHLIGHT,
      new Map(),
      undefined,
      "b",
    );

    expect(rows.map((row) => row.kind)).toEqual(["date", "block", "gap", "block"]);
  });

  /** The two sides of a gap are minutes apart as often as days, and a date rule
   * under the break would restate a day the reader was just shown. */
  it("does not restate the day where the gap does not span one", () => {
    const rows = buildRows(
      [
        makeMessage({ id: "a", timestamp: new Date(2026, 6, 29, 12, 6).toISOString() }),
        makeMessage({ id: "b", timestamp: new Date(2026, 6, 29, 12, 7).toISOString() }),
      ],
      null,
      NO_HIGHLIGHT,
      new Map(),
      undefined,
      "a",
    );

    expect(rows.map((row) => row.kind)).toEqual(["date", "block", "gap", "block"]);
  });

  it("still states it where the gap does", () => {
    const rows = buildRows(
      [
        makeMessage({ id: "a", timestamp: new Date(2026, 6, 28, 23, 55).toISOString() }),
        makeMessage({ id: "b", timestamp: new Date(2026, 6, 29, 12, 7).toISOString() }),
      ],
      null,
      NO_HIGHLIGHT,
      new Map(),
      undefined,
      "a",
    );

    expect(rows.map((row) => row.kind)).toEqual(["date", "block", "gap", "date", "block"]);
  });
});

describe("buildRows at scale", () => {
  it("covers every fixture message exactly once, under unique keys", () => {
    const messages: ChatMessage[] = makeConversation({ count: 5000 });
    const rows = buildRows(messages, messages[2500]!.id);
    const seen = rows.flatMap((row) => rowMessages(row).map((m) => m.id));

    expect(seen).toEqual(messages.map((m) => m.id));
    expect(rows.length).toBeLessThan(messages.length);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });
});

describe("buildRows and groups", () => {
  const GROUP = { id: "a", grade: "declared" as const, name: "parser", opener: "phrack" };

  /** A group spans several author blocks, so which block opens it cannot be
   * read off the block alone — only the one above it. */
  it("marks the first block of a group and not the ones that continue it", () => {
    const messages = [
      at(0, { id: "a", nick: "phrack" }),
      at(1_000, { id: "b", nick: "sable" }),
      at(2_000, { id: "c", nick: "phrack" }),
    ];
    const rows = blocks(
      buildRows(messages, null, NO_HIGHLIGHT, new Map(messages.map((m) => [m.id, GROUP]))),
    );

    expect(rows.map((row) => row.opensGroup)).toEqual([true, false, false]);
    expect(rows.every((row) => row.group === GROUP)).toBe(true);
  });

  it("leaves a block in no group carrying none", () => {
    const rows = blocks(buildRows([at(0, { id: "a" })], null, NO_HIGHLIGHT, new Map()));

    expect(rows[0]!.group).toBeNull();
    expect(rows[0]!.opensGroup).toBe(false);
  });

  /**
   * A digest of joins is not part of what anybody said, and a group is not over
   * because somebody arrived. This used to re-open it, so a channel with
   * ordinary comings and goings drew one group as four, each labelled again —
   * the rows disagreeing with the model about how many groups there were.
   */
  it("survives a run of presence between two blocks", () => {
    const messages = [
      at(0, { id: "a", nick: "phrack" }),
      at(1_000, { id: "j", nick: "wren", kind: "join" as const }),
      at(2_000, { id: "c", nick: "phrack" }),
    ];
    const rows = blocks(
      buildRows(
        messages,
        null,
        NO_HIGHLIGHT,
        new Map([
          ["a", GROUP],
          ["c", GROUP],
        ]),
      ),
    );

    expect(rows.map((row) => row.opensGroup)).toEqual([true, false]);
  });

  /** A rule across the pane says these are not one exchange. A group's line
   * running past it would say they are. */
  it("is broken by the unread seam", () => {
    const messages = [at(0, { id: "a", nick: "phrack" }), at(1_000, { id: "b", nick: "sable" })];
    const rows = blocks(
      buildRows(messages, "b", NO_HIGHLIGHT, new Map(messages.map((m) => [m.id, GROUP]))),
    );

    expect(rows.map((row) => row.opensGroup)).toEqual([true, true]);
  });
});

describe("a run that spans two groups", () => {
  const TALK = { id: "g1", grade: "addressed" as const, name: null, opener: "walker" };

  /**
   * One block draws one spine, so a run holding two groups can only show one.
   * It used to show the head's, which hid every `walker: …` typed in the middle
   * of somebody's own run: the message was grouped and the block it landed in
   * was not, so nothing was drawn. Found by typing exactly that and watching
   * nothing happen.
   */
  it("is split so each side can draw its own", () => {
    const messages = [
      at(0, { id: "a", nick: "syk", text: "thanks bud" }),
      at(1_000, { id: "b", nick: "syk", text: "walker: still there?" }),
      at(2_000, { id: "c", nick: "syk", text: "anyway" }),
    ];
    const rows = blocks(buildRows(messages, null, NO_HIGHLIGHT, new Map([["b", TALK]])));

    expect(rows.map((row) => row.messages.map((m) => m.id))).toEqual([["a"], ["b"], ["c"]]);
    expect(rows.map((row) => row.group)).toEqual([null, TALK, null]);
  });

  /** The split costs a repeated name and time, so it only happens where the
   * groups genuinely differ. */
  it("is not split when every line is in the same one", () => {
    const messages = [
      at(0, { id: "a", nick: "syk", text: "one" }),
      at(1_000, { id: "b", nick: "syk", text: "two" }),
    ];
    const rows = blocks(
      buildRows(
        messages,
        null,
        NO_HIGHLIGHT,
        new Map([
          ["a", TALK],
          ["b", TALK],
        ]),
      ),
    );

    expect(rows).toHaveLength(1);
  });
});

/**
 * #221. A message the server replayed is bounded rather than tinted, so a
 * service narrating somebody's comings and goings reads as a transcript.
 */
describe("the history boundary", () => {
  const replayed = (id: string, text: string): ChatMessage =>
    makeMessage({ id, text, source: "serverHistory" });

  function kinds(rows: TimelineRow[]): string[] {
    return rows.map((row) => (row.kind === "history" ? (row.opens ? "opens" : "closes") : row.kind));
  }

  it("opens where the replay starts and closes where it gives way", () => {
    const rows = buildRows(
      [
        makeMessage({ id: "a", text: "live" }),
        replayed("b", "replayed"),
        makeMessage({ id: "c", text: "live again" }),
      ],
      null,
    );

    expect(kinds(rows)).toEqual(["date", "block", "opens", "block", "closes", "block"]);
  });

  /** A rule under nothing states a boundary the reader can already see. */
  it("draws no closing rule when the replay is the last thing there is", () => {
    const rows = buildRows([makeMessage({ id: "a", text: "live" }), replayed("b", "replayed")], null);

    expect(kinds(rows)).toEqual(["date", "block", "opens", "block"]);
  });

  it("opens once for a run rather than once per message", () => {
    const rows = buildRows([replayed("a", "one"), replayed("b", "two"), replayed("c", "three")], null);

    expect(kinds(rows).filter((kind) => kind === "opens")).toHaveLength(1);
  });

  it("bounds each replay separately when live messages sit between them", () => {
    const rows = buildRows(
      [replayed("a", "one"), makeMessage({ id: "b", text: "live" }), replayed("c", "two")],
      null,
    );

    expect(kinds(rows)).toEqual(["date", "opens", "block", "closes", "block", "opens", "block"]);
  });

  /** What comes back out of the archive is `localArchive`, so the rule does not
   * return on the next launch to relitigate history already caught up on. */
  it("leaves a conversation read back from the archive unmarked", () => {
    const rows = buildRows(
      [
        makeMessage({ id: "a", text: "one", source: "localArchive" }),
        makeMessage({ id: "b", text: "two", source: "localArchive" }),
      ],
      null,
    );

    expect(kinds(rows)).toEqual(["date", "block"]);
  });

  /** The rule is a break across the pane, and a run that continued past it
   * would claim the replay and the live conversation are one person talking. */
  it("breaks the run it interrupts", () => {
    const rows = buildRows(
      [
        makeMessage({ id: "a", nick: "phrack", text: "before" }),
        replayed("b", "replayed"),
        makeMessage({ id: "c", nick: "phrack", text: "after" }),
      ],
      null,
    );

    expect(rows.filter((row) => row.kind === "block")).toHaveLength(3);
  });
});

/**
 * A netsplit is the burst the digest exists for. Unlike a `LIST`, which now
 * bypasses the timeline entirely (#125), every one of these legitimately
 * belongs on screen — so the only thing that keeps thousands of them from
 * becoming thousands of rows is the fold.
 *
 * Measured rather than guessed: `docs/measurements.md` records what this costs
 * at four sizes, and the number that matters is here as an assertion because a
 * regression would be a channel that becomes unscrollable rather than slow.
 */
describe("buildRows under a netsplit", () => {
  /** `n` people leaving, then the same `n` coming back a minute later — the
   * shape of a split and its heal, inside one `RUN_MS` window. */
  function split(n: number): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < n; i += 1) {
      messages.push(
        at(i * 10, { id: `q${i}`, nick: `nick${i}`, kind: "quit", text: "*.net *.split" }),
      );
    }
    for (let i = 0; i < n; i += 1) {
      messages.push(
        at(60_000 + i * 10, { id: `j${i}`, nick: `nick${i}`, kind: "join", text: "joined" }),
      );
    }
    return messages;
  }

  it("folds thousands of comings and goings into a handful of rows", () => {
    const rows = buildRows(split(2_500), null);

    // One, in fact: the split and its heal are inside a single run window, so
    // they share a digest. The bound rather than the exact figure is what
    // matters — what must not happen is one row each.
    expect(rows.filter((row) => row.kind === "system").length).toBeLessThanOrEqual(4);
  });

  it("folds them without losing any", () => {
    const messages = split(2_500);
    const rows = buildRows(messages, null);

    const held = rows.flatMap((row) => rowMessages(row).map((message) => message.id));
    expect(held).toHaveLength(messages.length);
    expect(new Set(held).size).toBe(messages.length);
  });

  /** The digest counts what it folded, so the line has to survive the scale it
   * is summarising — five thousand comings and goings is still one sentence. */
  it("still says what happened", () => {
    const rows = buildRows(split(2_500), null);
    const system = rows.find((row) => row.kind === "system");

    expect(system && describePresence(system.messages)).toBe("2500 quit, 2500 joined");
  });
});

describe("lines that failed together", () => {
  function line(id: string, delivery: ChatMessage["delivery"]): ChatMessage {
    return makeMessage({ id, nick: "walker", delivery });
  }
  const cut = (id: string) =>
    line(id, { state: "failed", detail: "not connected to Queue" });
  const gone = (id: string) => line(id, { state: "delivered" });

  /** What the sizes look like per row, which is what the notice and the marks
   * are drawn from. */
  const shape = (messages: ChatMessage[]) =>
    failureRuns(messages).map((mark) => (mark === null ? "-" : `${mark.run.length}${mark.last ? "!" : ""}`));

  it("marks nothing where nothing failed", () => {
    expect(shape([gone("a"), gone("b")])).toEqual(["-", "-"]);
  });

  /** A single failure is what shipped before #341, and it keeps saying exactly
   * what it said: its own notice, on its own row. */
  it("leaves one failure as its own run", () => {
    expect(shape([gone("a"), cut("b"), gone("c")])).toEqual(["-", "1!", "-"]);
  });

  it("gathers a cut's worth into one run ending on the last", () => {
    expect(shape([gone("a"), cut("b"), cut("c"), cut("d")])).toEqual(["-", "3", "3", "3!"]);
  });

  it("gives every row of a run the same messages to retry", () => {
    const messages = [cut("a"), cut("b"), cut("c")];
    const marks = failureRuns(messages);

    expect(marks[2]!.run.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(marks[0]!.run).toBe(marks[2]!.run);
  });

  /** A message that got out between two failures means the connection came
   * back, so what follows is a second event and not more of the first. */
  it("splits a run where a message got through", () => {
    expect(shape([cut("a"), gone("b"), cut("c")])).toEqual(["1!", "-", "1!"]);
  });

  /** Two reasons are two events even with nothing between them: one is the
   * connection and the other is the channel refusing the line. */
  it("splits a run where the reason changes", () => {
    const refused = line("c", { state: "failed", detail: "Cannot send to channel" });
    expect(shape([cut("a"), cut("b"), refused])).toEqual(["2", "2!", "1!"]);
  });
});
