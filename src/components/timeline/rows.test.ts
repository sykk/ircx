import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { makeConversation, makeMessage } from "./fixtures";
import {
  BUCKET_MS,
  buildRows,
  describeDay,
  describePresence,
  describeSpan,
  formatClock,
  nickColumnCh,
  partitionSystemRun,
  rowIndexOfMessage,
  rowMessages,
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
  it("puts a minute of the conversation in one block, whoever spoke", () => {
    const rows = buildRows(
      [
        at(0, { id: "a", nick: "sable" }),
        at(1000, { id: "b", nick: "phrack" }),
        at(2000, { id: "c", nick: "sable" }),
      ],
      null,
    );
    expect(blocks(rows)).toHaveLength(1);
    expect(blocks(rows)[0]!.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("opens a new block on the next minute even for one speaker", () => {
    const rows = buildRows(
      [
        at(0, { id: "a", nick: "sable" }),
        at(BUCKET_MS - 1, { id: "b", nick: "sable" }),
        at(BUCKET_MS, { id: "c", nick: "sable" }),
      ],
      null,
    );
    expect(blocks(rows).map((row) => row.messages.map((m) => m.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("keeps actions and notices in the block they were said in", () => {
    const rows = buildRows(
      [
        at(0, { id: "a", nick: "sable" }),
        at(1000, { id: "b", nick: "sable", kind: "action" }),
        at(2000, { id: "c", nick: "sable", kind: "notice" }),
      ],
      null,
    );
    expect(blocks(rows)).toHaveLength(1);
  });

  it("keeps a block's id when older history merges into it", () => {
    const later = [at(30_000, { id: "b" })];
    const merged = [at(10_000, { id: "a" }), at(30_000, { id: "b" })];

    const before = blocks(buildRows(later, null))[0]!;
    const after = blocks(buildRows(merged, null))[0]!;

    expect(after.id).toBe(before.id);
    expect(after.messages.map((m) => m.id)).toEqual(["a", "b"]);
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

  it("falls back to the message id when the server mangled the timestamp", () => {
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
    expect(rows.map((row) => row.kind)).toEqual(["date", "block", "date", "block", "block"]);
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

  it("runs past the minute a block would end on", () => {
    const rows = buildRows(
      [at(0, { id: "a", kind: "join" }), at(4 * BUCKET_MS, { id: "b", kind: "quit" })],
      null,
    );
    expect(rows.filter((r) => r.kind === "system")).toHaveLength(1);
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

describe("buildRows unread divider", () => {
  it("places the rule before the first unread message", () => {
    const rows = buildRows(
      [at(0, { id: "a" }), at(BUCKET_MS, { id: "b" }), at(2 * BUCKET_MS, { id: "c" })],
      "b",
    );
    expect(rows.map((r) => r.kind)).toEqual(["date", "block", "unread", "block", "block"]);
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

describe("nickColumnCh", () => {
  it("sizes the column to the widest nick the block holds", () => {
    const block = [makeMessage({ nick: "nyx" }), makeMessage({ nick: "phrack" })];
    expect(nickColumnCh(block)).toBe(6);
  });

  it("does not count a kind that writes its own nick into the body", () => {
    const block = [makeMessage({ nick: "kade" }), makeMessage({ nick: "bitwise", kind: "action" })];
    expect(nickColumnCh(block)).toBe(4);
  });

  it("keeps a floor so a short nick still reads as a column", () => {
    expect(nickColumnCh([makeMessage({ nick: "jo" })])).toBe(4);
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
