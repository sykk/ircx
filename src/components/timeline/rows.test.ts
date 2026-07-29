import { describe, expect, it } from "vitest";
import { makeConversation, makeMessage } from "./fixtures";
import {
  buildRows,
  describePresence,
  describeSpan,
  formatClock,
  GROUP_WINDOW_MS,
  partitionSystemRun,
  rowIndexOfMessage,
} from "./rows";

const START = Date.parse("2026-07-29T02:00:00.000Z");

function at(offsetMs: number, over: Parameters<typeof makeMessage>[0] = {}) {
  return makeMessage({ timestamp: new Date(START + offsetMs).toISOString(), ...over });
}

describe("buildRows grouping", () => {
  it("groups consecutive messages from one sender", () => {
    const rows = buildRows(
      [at(0, { id: "a", nick: "sable" }), at(1000, { id: "b", nick: "sable" })],
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "group", id: "g:a" });
  });

  it("breaks the group when the sender changes", () => {
    const rows = buildRows(
      [at(0, { id: "a", nick: "sable" }), at(1000, { id: "b", nick: "phrack" })],
      null,
    );
    expect(rows.map((r) => r.id)).toEqual(["g:a", "g:b"]);
  });

  it("groups at exactly five minutes and breaks past it", () => {
    const inside = buildRows(
      [at(0, { id: "a" }), at(GROUP_WINDOW_MS, { id: "b" })],
      null,
    );
    expect(inside).toHaveLength(1);

    const outside = buildRows(
      [at(0, { id: "a" }), at(GROUP_WINDOW_MS + 1, { id: "b" })],
      null,
    );
    expect(outside).toHaveLength(2);
  });

  it("measures the gap from the previous message, not the first", () => {
    const rows = buildRows(
      [
        at(0, { id: "a" }),
        at(GROUP_WINDOW_MS - 1000, { id: "b" }),
        at(2 * GROUP_WINDOW_MS - 2000, { id: "c" }),
      ],
      null,
    );
    expect(rows).toHaveLength(1);
  });

  it("keeps actions and notices out of groups", () => {
    const rows = buildRows(
      [
        at(0, { id: "a", nick: "sable" }),
        at(1000, { id: "b", nick: "sable", kind: "action" }),
        at(2000, { id: "c", nick: "sable" }),
        at(3000, { id: "d", nick: "sable", kind: "notice" }),
      ],
      null,
    );
    expect(rows.map((r) => r.id)).toEqual(["g:a", "g:b", "g:c", "g:d"]);
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
    expect(rows.map((r) => r.kind)).toEqual(["system", "group"]);
    expect(rows[0]).toMatchObject({ id: "s:a" });
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
      [at(0, { id: "a" }), at(1000, { id: "b" }), at(2000, { id: "c" })],
      "b",
    );
    expect(rows.map((r) => r.kind)).toEqual(["group", "unread", "group"]);
    expect(rows[2]).toMatchObject({ id: "g:b" });
  });

  it("splits a group that would otherwise span the rule", () => {
    const rows = buildRows([at(0, { id: "a" }), at(1000, { id: "b" })], "b");
    expect(rows).toHaveLength(3);
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
  it("finds a message inside a multi-message group", () => {
    const rows = buildRows([at(0, { id: "a" }), at(1000, { id: "b" })], null);
    expect(rowIndexOfMessage(rows, "b")).toBe(0);
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
  it("covers every fixture message exactly once", () => {
    const messages = makeConversation({ count: 5000 });
    const rows = buildRows(messages, messages[2500]!.id);
    const seen = rows.flatMap((row) => (row.kind === "unread" ? [] : row.messages.map((m) => m.id)));
    expect(seen).toEqual(messages.map((m) => m.id));
    expect(rows.length).toBeLessThan(messages.length);
  });
});
