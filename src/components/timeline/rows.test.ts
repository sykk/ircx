import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { makeConversation, makeMessage } from "./fixtures";
import {
  BUCKET_MS,
  buildRows,
  describeDay,
  describePresence,
  describePresenceRun,
  describeSpan,
  formatClock,
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

  it("digests presence but never an access change", () => {
    const run = partitionSystemRun([
      at(0, { id: "a", kind: "join" }),
      at(1, { id: "b", kind: "join" }),
      at(2, { id: "c", kind: "part" }),
      at(3, { id: "d", kind: "mode" }),
      at(4, { id: "e", kind: "kick" }),
      at(5, { id: "f", kind: "server" }),
    ]);

    expect(run.presence.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(run.loud.map((m) => m.id)).toEqual(["d", "e"]);
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
      "Over 5 minutes: 4 joined. None of it involves you.",
    );
  });

  /** A burst inside one minute is a burst. Saying so costs a clause and tells
   * the reader nothing they would act on. */
  it("says nothing about a span under a minute", () => {
    expect(describePresenceRun(joins(3, 1000), null)).toBe("3 joined. None of it involves you.");
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
      "sable",
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
    expect(formatClock(stamp)).toBe("02:05");
  });

  it("does not throw on a timestamp the server mangled", () => {
    expect(formatClock("not a date")).toBe("--:--");
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
      buildRows(messages, null, null, new Map(messages.map((m) => [m.id, GROUP]))),
    );

    expect(rows.map((row) => row.opensGroup)).toEqual([true, false, false]);
    expect(rows.every((row) => row.group === GROUP)).toBe(true);
  });

  it("leaves a block in no group carrying none", () => {
    const rows = blocks(buildRows([at(0, { id: "a" })], null, null, new Map()));

    expect(rows[0]!.group).toBeNull();
    expect(rows[0]!.opensGroup).toBe(false);
  });

  /** A digest of joins between two blocks is not part of what anybody said, so
   * the rule stops at it and starts again below. */
  it("is broken by a run of presence between two blocks", () => {
    const messages = [
      at(0, { id: "a", nick: "phrack" }),
      at(1_000, { id: "j", nick: "wren", kind: "join" as const }),
      at(2_000, { id: "c", nick: "phrack" }),
    ];
    const rows = blocks(
      buildRows(
        messages,
        null,
        null,
        new Map([
          ["a", GROUP],
          ["c", GROUP],
        ]),
      ),
    );

    expect(rows.map((row) => row.opensGroup)).toEqual([true, true]);
  });

  /** A rule across the pane says these are not one exchange. A group's line
   * running past it would say they are. */
  it("is broken by the unread seam", () => {
    const messages = [at(0, { id: "a", nick: "phrack" }), at(1_000, { id: "b", nick: "sable" })];
    const rows = blocks(
      buildRows(messages, "b", null, new Map(messages.map((m) => [m.id, GROUP]))),
    );

    expect(rows.map((row) => row.opensGroup)).toEqual([true, true]);
  });
});
