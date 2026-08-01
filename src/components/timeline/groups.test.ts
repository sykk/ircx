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

/** Everyone who speaks in a fixture is in the channel, which is the ordinary
 * case and keeps the membership rule out of tests that are not about it. */
function assign(messages: ChatMessage[], members?: string[]): Map<string, Group> {
  return assignGroups(messages, members ?? messages.map((m) => m.sender.nick));
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
    const groups = assign([
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
    const groups = assign([
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
    const groups = assign([
      at(2, "phrack", "[parser] tags fail on multiline values"),
      at(3, "sable", "confirmed, it is the CRLF handling"),
      at(40, "tsutomu", "morning all"),
    ]);

    expect(gradeOf(groups, "m3")).toBe("declared");
    expect(gradeOf(groups, "m40")).toBe("none");
  });

  it("puts the same name said again into the same group", () => {
    const groups = assign([
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
    const groups = assign([
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
    const written = assign([
      at(4, "kade", "standup in 10"),
      at(5, "rae", "TODO: write the changelog"),
    ]);
    const linked = assign([
      at(4, "kade", "standup in 10"),
      at(5, "rae", "https://example.com/thing"),
    ]);

    expect(gradeOf(written, "m5")).toBe("none");
    expect(gradeOf(linked, "m5")).toBe("none");
  });

  it("does not group somebody answering themselves", () => {
    const groups = assign([
      at(4, "kade", "standup in 10"),
      at(5, "kade", "kade: actually make that 15"),
    ]);

    expect(gradeOf(groups, "m5")).toBe("none");
  });

  /**
   * This used to be bounded by a clock — fifteen minutes since the addressee
   * spoke — and a walk found somebody addressing a person sitting in the
   * channel and missing by nine seconds. Two blocks with nothing between them
   * read as an exchange however long the pause, so the bound is reach rather
   * than time.
   */
  it("reaches back however long ago it was, if nothing is in the way", () => {
    const groups = assign([
      at(0, "kade", "standup in 10"),
      at(59, "rae", "kade: can't make it"),
    ]);

    expect(gradeOf(groups, "m59")).toBe("addressed");
  });

  /** The rule is one line, so it takes in what it reaches over. Past a few
   * lines that is a claim about other people's conversation. */
  it("does not reach over a stretch of other people talking", () => {
    const groups = assign([
      at(0, "kade", "standup in 10"),
      at(1, "nyx", "one"),
      at(2, "jolt", "two"),
      at(3, "nyx", "three"),
      at(4, "jolt", "four"),
      at(5, "rae", "kade: can't make it"),
    ]);

    expect(gradeOf(groups, "m5")).toBe("none");
  });

  /** What makes it an address rather than a colon: the name is somebody here.
   * `TODO:` groups nothing, and neither does a nick that has left. */
  it("needs the name to belong to somebody in the channel", () => {
    const messages = [at(4, "kade", "standup in 10"), at(5, "rae", "kade: can't make it")];

    expect(gradeOf(assign(messages, ["rae"]), "m5")).toBe("none");
    expect(gradeOf(assign(messages, ["kade", "rae"]), "m5")).toBe("addressed");
  });

  /** Everything from the answer back to what it answers, or the line would be
   * two rules with a neutral block between them. */
  it("takes in what its rule reaches over", () => {
    const groups = assign([
      at(0, "kade", "standup in 10"),
      at(1, "nyx", "unrelated remark"),
      at(2, "rae", "kade: can't make it"),
    ]);

    expect(gradeOf(groups, "m1")).toBe("addressed");
    expect(groups.get("m1")).toBe(groups.get("m0"));
  });
});

describe("one exchange at a time", () => {
  /**
   * The failure a live round found and this file could not see: five messages
   * and two separate question-and-answers drawn as one group. Answering
   * somebody already in a group put the answerer in it, so every fresh pair
   * inherited the last pair's rule and the group ran until the channel went
   * quiet.
   */
  it("does not run one pair's rule on into the next pair's", () => {
    const groups = assign([
      at(0, "nyx", "is the mirror still down"),
      at(1, "jolt", "nyx: back up 20 min ago"),
      at(2, "kade", "jolt: any news on the build"),
      at(3, "jolt", "kade: green as of an hour ago"),
      at(4, "rae", "jolt: thanks"),
    ]);

    expect(groups.get("m1")).toBe(groups.get("m0"));
    expect(groups.get("m3")).toBe(groups.get("m2"));
    expect(groups.get("m2")).not.toBe(groups.get("m0"));
    expect(gradeOf(groups, "m4")).toBe("none");
  });

  /** The exchange it does carry on is its own. Two people going back and forth
   * are one conversation however many turns it takes. */
  it("carries on between the two people already in it", () => {
    const groups = assign([
      at(0, "kade", "standup in 10"),
      at(1, "rae", "kade: can't make it"),
      at(2, "kade", "rae: no problem"),
      at(3, "rae", "kade: thanks"),
    ]);

    expect(groups.get("m1")).toBe(groups.get("m0"));
    expect(groups.get("m2")).toBe(groups.get("m0"));
    expect(groups.get("m3")).toBe(groups.get("m0"));
  });

  /** A message the rule reached over is in the group's span without being in
   * its conversation, so it is not a way in for whoever wrote it. */
  it("does not admit somebody its rule only reached over", () => {
    const groups = assign([
      at(0, "kade", "standup in 10"),
      at(1, "nyx", "unrelated remark"),
      at(2, "rae", "kade: can't make it"),
      at(3, "nyx", "rae: what time"),
    ]);

    expect(groups.get("m1")).toBe(groups.get("m0"));
    expect(gradeOf(groups, "m3")).toBe("none");
  });

  /** Declared is a fact its author typed rather than a guess off one colon, so
   * it still takes anybody who joins the topic. */
  it("lets a named topic take whoever joins it", () => {
    const groups = assign([
      at(2, "phrack", "[parser] tags fail on multiline values"),
      at(3, "sable", "phrack: confirmed"),
      at(4, "kade", "sable: which branch"),
    ]);

    expect(groups.get("m3")).toBe(groups.get("m2"));
    expect(groups.get("m4")).toBe(groups.get("m2"));
  });
});

describe("a conversation nobody grouped", () => {
  /**
   * The guess used to take this, and taking it is why it went. Three people in
   * one conversation have nothing to separate, so a rule down the side of it
   * distinguishes nothing and says "not sure" about every line in the channel.
   * A live run against #test returned twenty messages as one group.
   */
  it("is left alone however much of it there is", () => {
    const groups = assign([
      at(7, "nyx", "is the mirror still down"),
      at(8, "jolt", "back up 20 min ago"),
      at(9, "nyx", "thanks"),
      at(10, "kade", "morning all"),
      at(11, "rae", "morning"),
      at(12, "kade", "any news"),
    ]);

    expect(groups.size).toBe(0);
  });

  /** Naming somebody in passing is not addressing them, and the client has no
   * business inferring that it is. */
  it("is not grouped by people using each other's names in passing", () => {
    const groups = assign([
      at(7, "walker", "back, the parser bug is the CRLF handling"),
      at(8, "syk", "hey walker"),
      at(9, "syk_", "wb walker"),
    ]);

    expect(groups.size).toBe(0);
  });
});

describe("precedence", () => {
  /** Declared beats addressed, and a message is in one group. */
  it("leaves a declared message where its author put it", () => {
    const groups = assign([
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

  it("leaves an unrelated line out of the exchange beside it", () => {
    const groups = assign([
      at(4, "kade", "standup in 10"),
      at(5, "rae", "kade: can't make it"),
      at(6, "nyx", "unrelated"),
    ]);

    expect(gradeOf(groups, "m5")).toBe("addressed");
    expect(gradeOf(groups, "m6")).toBe("none");
  });
});

describe("what is in no group", () => {
  /** The ordinary case, and it has to stay ordinary. */
  it("leaves a lone message alone", () => {
    const groups = assign([
      at(7, "nyx", "is the mirror still down"),
      at(8, "jolt", "back up 20 min ago"),
      at(9, "nyx", "thanks"),
      at(40, "tsutomu", "morning all"),
    ]);

    expect(gradeOf(groups, "m40")).toBe("none");
  });

  it("groups no joins, parts or server output", () => {
    const groups = assign([
      makeMessage({ id: "j1", nick: "nyx", kind: "join", text: "nyx joined" }),
      makeMessage({ id: "j2", nick: "jolt", kind: "join", text: "jolt joined" }),
      makeMessage({ id: "j3", nick: "kade", kind: "quit", text: "kade quit" }),
    ]);

    expect(groups.size).toBe(0);
  });
});
