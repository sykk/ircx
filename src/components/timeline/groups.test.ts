import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import { assignGroups, bodyText, declaredName, type Group } from "./groups";
import { makeMessage } from "./fixtures";

/** Minutes past a fixed hour, so a test reads as a transcript. */
function at(minute: number, nick: string, text: string, id = `m${minute}`): ChatMessage {
  return makeMessage({
    id,
    nick,
    text,
    timestamp: `2026-07-29T11:${String(minute).padStart(2, "0")}:00.000Z`,
  });
}

function gradeOf(groups: Map<string, Group>, id: string): string {
  return groups.get(id)?.grade ?? "none";
}

describe("declared", () => {
  it("takes the name a person typed and does not print it twice", () => {
    const message = at(2, "phrack", "[parser] tags fail on multiline values");

    expect(declaredName(message.text)).toBe("parser");
    expect(bodyText(message)).toBe("tags fail on multiline values");
  });

  /** A line opening with a long quotation is not somebody naming a topic. */
  it("is bounded, so a bracketed quotation is not a group", () => {
    const long = `[${"x".repeat(40)}] and then he said`;

    expect(declaredName(long)).toBeNull();
    expect(bodyText(makeMessage({ text: long }))).toBe(long);
  });

  /** Naming a topic is what saves everyone from repeating it. A group that
   * held only the lines carrying the bracket would re-open on every one of
   * them and print its name again each time, which is what the first render
   * of this did. */
  it("takes in what follows without the bracket being typed again", () => {
    const groups = assignGroups([
      at(2, "phrack", "[parser] tags fail on multiline values"),
      at(3, "sable", "confirmed, it is the CRLF handling"),
      at(6, "phrack", "patch in 8f2ad10"),
    ]);

    expect(groups.get("m3")).toBe(groups.get("m2"));
    expect(groups.get("m6")).toBe(groups.get("m2"));
    expect(groups.get("m6")?.name).toBe("parser");
  });

  /** Found by looking at it: a wide window made the declaration run forward
   * into whatever the channel turned to next, so a standup eight minutes later
   * was drawn as part of a parser bug. */
  it("does not swallow the conversation that follows it", () => {
    const groups = assignGroups([
      at(2, "phrack", "[parser] tags fail on multiline values"),
      at(6, "phrack", "patch in 8f2ad10"),
      at(14, "kade", "standup in 10"),
      at(15, "rae", "kade: can't make it"),
    ]);

    expect(gradeOf(groups, "m6")).toBe("declared");
    expect(gradeOf(groups, "m14")).toBe("addressed");
    expect(groups.get("m14")).not.toBe(groups.get("m2"));
  });

  it("lets go after the conversation has stopped for long enough", () => {
    const groups = assignGroups([
      at(2, "phrack", "[parser] tags fail on multiline values"),
      at(3, "sable", "confirmed, it is the CRLF handling"),
      at(40, "tsutomu", "morning all"),
    ]);

    expect(gradeOf(groups, "m3")).toBe("declared");
    expect(gradeOf(groups, "m40")).toBe("none");
  });

  it("puts the same name said again into the same group", () => {
    const groups = assignGroups([
      at(2, "phrack", "[parser] tags fail on multiline values"),
      at(3, "sable", "unrelated"),
      at(4, "sable", "[parser] confirmed, it is the CRLF handling"),
    ]);

    expect(groups.get("m2")).toBe(groups.get("m4"));
    expect(groups.get("m2")?.name).toBe("parser");
    expect(groups.get("m2")?.opener).toBe("phrack");
  });
});

describe("addressed", () => {
  it("joins the person it names, and takes their colour", () => {
    const groups = assignGroups([
      at(4, "kade", "standup in 10"),
      at(5, "rae", "kade: can't make it"),
    ]);

    expect(gradeOf(groups, "m5")).toBe("addressed");
    expect(groups.get("m5")).toBe(groups.get("m4"));
    // The exchange started with kade, so the rule is kade's colour.
    expect(groups.get("m5")?.opener).toBe("kade");
  });

  /** The shape alone matches `TODO:` and the scheme of a bare URL. Requiring
   * the nick to have spoken is the whole of what keeps those out.
   *
   * Two messages, so the guess floor cannot be reached and the only grade this
   * could come back as is the one under test. */
  it("needs the nick to have actually spoken", () => {
    const written = assignGroups([
      at(4, "kade", "standup in 10"),
      at(5, "rae", "TODO: write the changelog"),
    ]);
    const linked = assignGroups([
      at(4, "kade", "standup in 10"),
      at(5, "rae", "https://example.com/thing"),
    ]);

    expect(gradeOf(written, "m5")).toBe("none");
    expect(gradeOf(linked, "m5")).toBe("none");
  });

  it("does not group somebody answering themselves", () => {
    const groups = assignGroups([
      at(4, "kade", "standup in 10"),
      at(5, "kade", "kade: actually make that 15"),
    ]);

    expect(gradeOf(groups, "m5")).toBe("none");
  });

  it("lets go after long enough that the address means nothing", () => {
    const groups = assignGroups([
      at(0, "kade", "standup in 10"),
      at(59, "rae", "kade: can't make it"),
    ]);

    expect(gradeOf(groups, "m59")).toBe("none");
  });
});

describe("guessed", () => {
  it("groups a burst several people took part in", () => {
    const groups = assignGroups([
      at(7, "nyx", "is the mirror still down"),
      at(8, "jolt", "back up 20 min ago"),
      at(9, "nyx", "thanks"),
    ]);

    expect(gradeOf(groups, "m7")).toBe("guessed");
    expect(groups.get("m9")).toBe(groups.get("m7"));
  });

  /** One person talking is an author block, which says so already. */
  it("does not group one person talking to themselves", () => {
    const groups = assignGroups([
      at(7, "nyx", "one"),
      at(8, "nyx", "two"),
      at(9, "nyx", "three"),
    ]);

    expect(gradeOf(groups, "m7")).toBe("none");
  });

  it("does not group a remark and a reply", () => {
    const groups = assignGroups([at(7, "nyx", "morning"), at(8, "jolt", "morning")]);

    expect(gradeOf(groups, "m7")).toBe("none");
  });

  it("is ended by a silence", () => {
    const groups = assignGroups([
      at(7, "nyx", "is the mirror still down"),
      at(8, "jolt", "back up 20 min ago"),
      at(30, "kade", "morning all"),
      at(31, "rae", "morning"),
      at(32, "kade", "any news"),
    ]);

    expect(gradeOf(groups, "m7")).toBe("none");
    expect(gradeOf(groups, "m30")).toBe("guessed");
  });

  it("goes when the reader says it was not a group", () => {
    const messages = [
      at(7, "nyx", "is the mirror still down"),
      at(8, "jolt", "back up 20 min ago"),
      at(9, "nyx", "thanks"),
    ];
    const opener = assignGroups(messages).get("m7")!.id;

    expect(gradeOf(assignGroups(messages, new Set([opener])), "m7")).toBe("none");
  });
});

describe("precedence", () => {
  /** Declared beats addressed beats guessed, and a message is in one group. */
  it("leaves a declared message where its author put it", () => {
    const groups = assignGroups([
      at(2, "phrack", "[parser] tags fail on multiline values"),
      at(3, "sable", "phrack: confirmed"),
      at(4, "phrack", "[parser] patch in 8f2ad10"),
    ]);

    expect(gradeOf(groups, "m2")).toBe("declared");
    expect(gradeOf(groups, "m4")).toBe("declared");
    expect(groups.get("m2")).toBe(groups.get("m4"));
    // sable addressed phrack, whose message is already declared, so sable joins
    // that group rather than opening a weaker one over the top of it.
    expect(groups.get("m3")).toBe(groups.get("m2"));
  });

  it("does not let a guess take a message an address already claimed", () => {
    const groups = assignGroups([
      at(4, "kade", "standup in 10"),
      at(5, "rae", "kade: can't make it"),
      at(6, "nyx", "unrelated"),
    ]);

    expect(gradeOf(groups, "m5")).toBe("addressed");
    expect(groups.get("m5")).toBe(groups.get("m4"));
  });
});

describe("what is in no group", () => {
  /** The ordinary case, and it has to stay ordinary. */
  it("leaves a lone message alone", () => {
    const groups = assignGroups([
      at(7, "nyx", "is the mirror still down"),
      at(8, "jolt", "back up 20 min ago"),
      at(9, "nyx", "thanks"),
      at(40, "tsutomu", "morning all"),
    ]);

    expect(gradeOf(groups, "m40")).toBe("none");
  });

  it("groups no joins, parts or server output", () => {
    const groups = assignGroups([
      makeMessage({ id: "j1", nick: "nyx", kind: "join", text: "nyx joined" }),
      makeMessage({ id: "j2", nick: "jolt", kind: "join", text: "jolt joined" }),
      makeMessage({ id: "j3", nick: "kade", kind: "quit", text: "kade quit" }),
    ]);

    expect(groups.size).toBe(0);
  });
});
